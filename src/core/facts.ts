/**
 * Learned project facts: the lifecycle, the claim text, the firing gate and the
 * forget/unforget rail.
 *
 * The module is deliberately host-free and has no I/O. A fact is learned from an
 * observed tool outcome (see `facts-learn.ts`), stored in a `ProjectRecord`
 * (see `project.ts`) and rendered into a small system block. Nothing here calls
 * a model, and no raw command output is ever part of a fact.
 *
 * The lifecycle is the validated TokenEconomizer replay state machine:
 * confirmations accumulate across separate sessions, a candidate is promoted
 * after `K_PROMOTE` of them, recency decay and a heavier contradiction weight
 * can retire an active fact, and an active fact is only injected once it clears
 * the firing gate.
 *
 * @module mega-smart-context/facts
 */

import { createHash } from "node:crypto"

import { isPlainObject } from "./types.ts"

// ---------------------------------------------------------------------------
// Lifecycle constants (the replay constants; do not re-tune without a measurement)
// ---------------------------------------------------------------------------

/** Confirmations on separate sessions needed to promote a candidate. */
export const K_PROMOTE = 3
/** Recency decay per session-ago. */
export const GAMMA = 0.8
/** A contradiction weighs this many confirmations. */
export const LAMBDA = 5.0
/** An ACTIVE fact retires when its recency score falls below this floor. */
export const SCORE_FLOOR = 0.0
/** A high-stakes fact retires on one clean contradiction. */
export const HARD_KILL = true
/** Injection needs this firing rate ... */
export const FIRE_GATE = 0.4
/** ... measured over at least this many exercised sessions. */
export const FIRE_MIN_N = 4

/** The render cap: at most this many facts in the block. */
export const MAX_FACTS = 4
/** The render cap: at most this many estimated tokens for header plus bullets. */
export const MAX_TOKENS = 150
/** The estimate divisor used everywhere in the package. */
export const CHARS_PER_TOKEN = 4

/** Candidates and retired facts are kept this long without a new sighting. */
export const RETENTION_DAYS = 90
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000
/** Candidate and retired-map bounds. */
export const MAX_CANDIDATES = 16
export const MAX_RETIRED = 32
/** A stored claim parameter is capped, so one pathological command cannot bloat the store. */
export const MAX_PARAM_CHARS = 160

/** The heading of the injected system block. */
export const FACT_HEADER = "# Learned project facts"

/** Families grounded in an observed command outcome. */
export type FactFamily =
  | "form_repair"
  | "absent_tool"
  | "boundary"
  | "arg_repair"
  | "env_value"
  | "empty_probe"

export const FACT_FAMILIES: ReadonlyArray<FactFamily> = [
  "form_repair",
  "absent_tool",
  "boundary",
  "arg_repair",
  "env_value",
  "empty_probe",
]

/** Families whose claim is high-stakes: one clean contradiction retires them. */
export const HIGH_STAKES: Readonly<Record<FactFamily, boolean>> = {
  form_repair: false,
  absent_tool: true,
  boundary: true,
  arg_repair: false,
  env_value: false,
  empty_probe: false,
}

const FAMILY_SET = new Set<string>(FACT_FAMILIES)
const LINT_RE =
  /\b(skip|no need|don'?t|do not|stop|done|completed?|finish(?:ed)?|verify|verification|instead of (?:running|testing))\b/iu

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type FactState = "CANDIDATE" | "ACTIVE" | "RETIRED"

export interface FactConfirmation {
  /** The session that confirmed the fact; one entry per session. */
  session: string
  /** The logical project step the confirmation belongs to. */
  step: number
  /** Files the session edited, when the caller knows them (drift detection). */
  files: string[]
}

export interface FactContradiction {
  session: string
  step: number
}

export interface FactLifecycle {
  state: FactState
  /** A high-stakes fact retires on one clean contradiction. */
  high: boolean
  /** Promotion needs confirmations on sessions that edited different files. */
  drift: boolean
  confirms: FactConfirmation[]
  contradicts: FactContradiction[]
  /** Sessions where the problem the fact prevents actually occurred. */
  fireNum: number
  /** Sessions where the fact was exercised (the relevant command ran). */
  fireDen: number
  /** Session-dedupe for fireDen. */
  fireSessions: string[]
  /** Session-dedupe for fireNum; kept separately so a later failure in the same session counts once. */
  firedSessions: string[]
  promotedAtStep?: number
  retiredAtStep?: number
  retiredAt?: number
  /** Why a fact left the active/candidate maps. */
  reason?: string
}

export interface ProjectFact {
  /** Stable, human-readable id the user can pass to `/context facts forget`. */
  id: string
  family: FactFamily
  /** One declarative line, rendered verbatim. */
  claim: string
  /** Redacted, bounded claim parameters. Never raw output. */
  params: Record<string, string>
  lifecycle: FactLifecycle
  firstSeen: number
  lastSeen: number
  /** How many rendered snapshots included this fact. */
  injected: number
}

export type RetirementReason = "contradiction" | "forgotten" | "expired" | "evicted"

export interface RetiredFact {
  fact: ProjectFact
  reason: RetirementReason
  at: number
}

/** The three maps every lifecycle operation works over. */
export interface FactStore {
  facts: Record<string, ProjectFact>
  candidates: Record<string, ProjectFact>
  retired: Record<string, RetiredFact>
}

export interface FactDraft {
  id?: string
  family: FactFamily
  params?: Record<string, string>
  high?: boolean
  drift?: boolean
}

export interface FactEvidence {
  kind: "confirm" | "contradict"
  session: string
  step: number
  /** The relevant command ran in this session. Defaults to true. */
  exercised?: boolean
  /** The problem the fact prevents occurred in this session. */
  fired?: boolean
  files?: string[]
}

export type FactAction = "candidate" | "confirmed" | "promoted" | "retired" | "skipped"

export interface FactOutcome {
  fact: ProjectFact
  action: FactAction
  retired?: RetiredFact
}

export interface FactRenderOptions {
  header?: string
  maxFacts?: number
  maxTokens?: number
  includeIds?: boolean
}

export interface FactRender {
  text: string
  ids: string[]
  facts: ProjectFact[]
  tokens: number
  chars: number
}

export interface FactDescription {
  id: string
  family: FactFamily
  state: FactState
  claim: string
  confirms: number
  contradictions: number
  fireNum: number
  fireDen: number
  firingRate: number
  injectable: boolean
  firstSeen: number
  lastSeen: number
  injected: number
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim()
}

function compact(value: unknown, max = MAX_PARAM_CHARS): string {
  const text = oneLine(typeof value === "string" ? value : String(value ?? ""))
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}

/** A deterministic short digest, used for ids and collision suffixes. */
export function shortHash(value: string, length = 6): string {
  return createHash("sha256").update(value).digest("hex").slice(0, Math.max(1, length))
}

function slug(value: string, max = 24): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, max)
  return out.length > 0 ? out : "x"
}

/**
 * The stable id of a fact. The same family and parameters always produce the
 * same id, so a repeated sighting merges instead of creating a second fact.
 */
export function factId(family: FactFamily, params: Record<string, string> = {}): string {
  const p = (key: string): string => compact(params[key] ?? "")
  switch (family) {
    case "absent_tool":
      return "absent_tool:" + slug(p("tool"), 32)
    case "boundary":
      return "boundary:" + slug(p("host"), 40)
    case "env_value":
      return "env_value:" + slug(p("variable"), 32)
    case "empty_probe":
      return "empty_probe:" + slug(p("probe"), 40)
    case "arg_repair":
      return (
        "arg_repair:" +
        slug(p("failed"), 18) +
        ">" +
        slug(p("worked"), 18) +
        "-" +
        shortHash(p("failed") + "\u0000" + p("worked"), 6)
      )
    case "form_repair":
      return (
        "form_repair:" +
        slug(p("failed"), 18) +
        ">" +
        slug(p("worked"), 18) +
        "-" +
        shortHash(p("failed") + "\u0000" + p("worked"), 6)
      )
  }
}

/** The plain-language claim for a family and its (already redacted) parameters. */
export function claimFor(family: FactFamily, params: Record<string, string> = {}): string {
  const p = (key: string): string => compact(params[key] ?? "")
  switch (family) {
    case "form_repair": {
      const failed = p("failed")
      const worked = p("worked")
      if (failed.length === 0 || worked.length === 0) return ""
      const error = p("error")
      return error.length > 0
        ? `\`${failed}\` fails here with ${error}; \`${worked}\` works.`
        : `\`${failed}\` fails here; \`${worked}\` works.`
    }
    case "absent_tool": {
      const tool = p("tool")
      if (tool.length === 0) return ""
      return `\`${tool} …\` fails here with command not found, and no other way to run it has worked.`
    }
    case "boundary": {
      const host = p("host")
      if (host.length === 0) return ""
      return `Outbound connections to \`${host}\` are refused here.`
    }
    case "arg_repair": {
      const failed = p("failed")
      const worked = p("worked")
      if (failed.length === 0 || worked.length === 0) return ""
      return `\`${failed}\` is rejected here; \`${worked}\` is accepted.`
    }
    case "env_value": {
      const variable = p("variable")
      if (variable.length === 0) return ""
      return `Code that imports this project needs \`${variable}\` set here.`
    }
    case "empty_probe": {
      const probe = p("probe")
      if (probe.length === 0) return ""
      return `\`${probe}\` returns nothing here.`
    }
  }
}

/** The completion/verification lint: an offending word, or undefined when clean. */
export function factLint(claim: string): string | undefined {
  const match = LINT_RE.exec(claim)
  return match?.[0]
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function emptyLifecycle(high: boolean, drift = false): FactLifecycle {
  return {
    state: "CANDIDATE",
    high,
    drift,
    confirms: [],
    contradicts: [],
    fireNum: 0,
    fireDen: 0,
    fireSessions: [],
    firedSessions: [],
  }
}

/** How many sessions confirmed the fact, respecting the drift rule. */
export function driftedConfirms(lifecycle: FactLifecycle): number {
  if (!lifecycle.drift) return lifecycle.confirms.length
  const kept: string[][] = []
  for (const confirmation of lifecycle.confirms) {
    const files = new Set(confirmation.files ?? [])
    if (files.size === 0 || kept.every((other) => [...files].every((file) => !other.includes(file)))) {
      kept.push([...files])
    }
  }
  return kept.length
}

/** Recency-weighted evidence: confirmations minus `LAMBDA` times contradictions. */
export function lifecycleScore(lifecycle: FactLifecycle, step: number): number {
  const decay = (at: number): number => GAMMA ** Math.max(0, step - at)
  let score = 0
  for (const confirmation of lifecycle.confirms) score += decay(confirmation.step)
  for (const contradiction of lifecycle.contradicts) score -= LAMBDA * decay(contradiction.step)
  return score
}

export function firingRate(lifecycle: FactLifecycle): number {
  return lifecycle.fireDen > 0 ? lifecycle.fireNum / lifecycle.fireDen : 0
}

/** ACTIVE and clearing the firing gate, so it may enter a render. */
export function isInjectable(lifecycle: FactLifecycle): boolean {
  return (
    lifecycle.state === "ACTIVE" &&
    lifecycle.fireDen >= FIRE_MIN_N &&
    firingRate(lifecycle) >= FIRE_GATE
  )
}

/**
 * Fold one evidence event into a lifecycle.
 *
 * A session is counted once for confirmation, one for contradiction and once
 * for exercise/firing: a repeated idle event, or a retry inside one session,
 * cannot move the fact by itself.
 */
export function recordEvidence(lifecycle: FactLifecycle, evidence: FactEvidence): boolean {
  let changed = false
  if (evidence.exercised !== false) {
    if (!lifecycle.fireSessions.includes(evidence.session)) {
      lifecycle.fireSessions.push(evidence.session)
      lifecycle.fireDen += 1
      changed = true
    }
    if (evidence.fired === true && !lifecycle.firedSessions.includes(evidence.session)) {
      lifecycle.firedSessions.push(evidence.session)
      lifecycle.fireNum += 1
      changed = true
    }
  }
  if (evidence.kind === "confirm") {
    if (!lifecycle.confirms.some((entry) => entry.session === evidence.session)) {
      lifecycle.confirms.push({
        session: evidence.session,
        step: evidence.step,
        files: [...(evidence.files ?? [])],
      })
      changed = true
    }
  } else if (!lifecycle.contradicts.some((entry) => entry.session === evidence.session)) {
    lifecycle.contradicts.push({ session: evidence.session, step: evidence.step })
    changed = true
  }
  return changed
}

/** The next state, without mutating the lifecycle. */
export function nextState(lifecycle: FactLifecycle, evidence: FactEvidence): FactState {
  if (lifecycle.state === "CANDIDATE") {
    if (driftedConfirms(lifecycle) >= K_PROMOTE) return "ACTIVE"
    if (lifecycleScore(lifecycle, evidence.step) < SCORE_FLOOR) return "RETIRED"
    return "CANDIDATE"
  }
  if (lifecycle.state === "ACTIVE") {
    const hard = lifecycle.high && evidence.kind === "contradict" && HARD_KILL
    if (hard || lifecycleScore(lifecycle, evidence.step) < SCORE_FLOOR) return "RETIRED"
  }
  return lifecycle.state
}

// ---------------------------------------------------------------------------
// Facts and the store maps
// ---------------------------------------------------------------------------

export function cloneFact(fact: ProjectFact): ProjectFact {
  return {
    ...fact,
    params: { ...fact.params },
    lifecycle: {
      ...fact.lifecycle,
      confirms: fact.lifecycle.confirms.map((entry) => ({ ...entry, files: [...entry.files] })),
      contradicts: fact.lifecycle.contradicts.map((entry) => ({ ...entry })),
      fireSessions: [...fact.lifecycle.fireSessions],
      firedSessions: [...fact.lifecycle.firedSessions],
    },
  }
}

/** Build a candidate from a draft. The caller has already redacted the params. */
export function createFact(draft: FactDraft, now = Date.now()): ProjectFact {
  const family = draft.family
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(draft.params ?? {})) {
    const clean = compact(value)
    if (clean.length > 0) params[key] = clean
  }
  const id = draft.id ?? factId(family, params)
  return {
    id,
    family,
    claim: claimFor(family, params),
    params,
    lifecycle: emptyLifecycle(draft.high ?? HIGH_STAKES[family], draft.drift ?? false),
    firstSeen: now,
    lastSeen: now,
    injected: 0,
  }
}

function moveToRetired(
  store: FactStore,
  fact: ProjectFact,
  reason: RetirementReason,
  now: number,
  step?: number,
): RetiredFact {
  const retiredFact = cloneFact(fact)
  retiredFact.lifecycle.state = "RETIRED"
  retiredFact.lifecycle.retiredAt = now
  if (step !== undefined) retiredFact.lifecycle.retiredAtStep = step
  retiredFact.lifecycle.reason = reason
  delete store.facts[fact.id]
  delete store.candidates[fact.id]
  const entry: RetiredFact = { fact: retiredFact, reason, at: now }
  store.retired[fact.id] = entry
  return entry
}

/**
 * Apply one evidence event to a fact, creating it as a candidate when it is new.
 *
 * Returns `undefined` only when the claim is empty or reads as completion or
 * verification advice; such a claim is never stored. A retired id (forgotten,
 * contradicted or expired) is never learned again.
 */
export function applyEvidence(
  store: FactStore,
  draft: FactDraft,
  evidence: FactEvidence,
  options: { now?: number } = {},
): FactOutcome | undefined {
  const now = options.now ?? Date.now()
  const family = draft.family
  if (!FAMILY_SET.has(family)) return undefined

  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(draft.params ?? {})) {
    const clean = compact(value)
    if (clean.length > 0) params[key] = clean
  }
  const id = draft.id ?? factId(family, params)

  const retired = store.retired[id]
  if (retired !== undefined) {
    return { fact: cloneFact(retired.fact), action: "skipped", retired }
  }

  let fact = store.facts[id] ?? store.candidates[id]
  let created = false
  if (fact === undefined) {
    fact = {
      id,
      family,
      claim: claimFor(family, params),
      params,
      lifecycle: emptyLifecycle(draft.high ?? HIGH_STAKES[family], draft.drift ?? false),
      firstSeen: now,
      lastSeen: now,
      injected: 0,
    }
    created = true
  } else {
    // The id is stable, so the family is too; a later observation may add a
    // parameter (an error phrase) but never replaces the whole claim.
    fact = cloneFact(fact)
    fact.params = { ...fact.params, ...params }
    const claim = claimFor(fact.family, fact.params)
    if (claim.length > 0) fact.claim = claim
  }

  if (fact.claim.length === 0 || factLint(fact.claim) !== undefined) return undefined

  const before = fact.lifecycle.state
  recordEvidence(fact.lifecycle, evidence)
  fact.lastSeen = now
  const after = nextState(fact.lifecycle, evidence)

  if (after === "RETIRED") {
    const entry = moveToRetired(store, fact, evidence.kind === "contradict" ? "contradiction" : "expired", now, evidence.step)
    return { fact: cloneFact(fact), action: "retired", retired: entry }
  }

  if (after === "ACTIVE") {
    fact.lifecycle.state = "ACTIVE"
    if (fact.lifecycle.promotedAtStep === undefined) fact.lifecycle.promotedAtStep = evidence.step
    delete store.candidates[id]
    store.facts[id] = fact
    return { fact, action: before === "CANDIDATE" || created ? "promoted" : "confirmed" }
  }

  fact.lifecycle.state = "CANDIDATE"
  store.candidates[id] = fact
  return { fact, action: "candidate" }
}

/** Retire a fact by hand or because the caller decided it is stale. */
export function retireFact(
  store: FactStore,
  id: string,
  reason: RetirementReason = "contradiction",
  options: { now?: number } = {},
): boolean {
  const fact = store.facts[id] ?? store.candidates[id]
  if (fact === undefined) return false
  moveToRetired(store, fact, reason, options.now ?? Date.now())
  return true
}

/** Forget a fact: it leaves the store but its id and record are kept so it is never re-learned. */
export function forgetFact(store: FactStore, id: string, now = Date.now()): boolean {
  const entry = store.retired[id]
  if (entry !== undefined) return false
  const fact = store.facts[id] ?? store.candidates[id]
  if (fact === undefined) return false
  moveToRetired(store, fact, "forgotten", now)
  return true
}

/** Bring a forgotten fact back, in the state its evidence supports. */
export function unforgetFact(store: FactStore, id: string, now = Date.now()): boolean {
  const entry = store.retired[id]
  if (entry === undefined || entry.reason !== "forgotten") return false
  const fact = cloneFact(entry.fact)
  delete store.retired[id]
  fact.lifecycle.retiredAt = undefined
  fact.lifecycle.retiredAtStep = undefined
  fact.lifecycle.reason = undefined
  if (fact.lifecycle.confirms.length >= K_PROMOTE) {
    fact.lifecycle.state = "ACTIVE"
    store.facts[id] = fact
  } else {
    fact.lifecycle.state = "CANDIDATE"
    store.candidates[id] = fact
  }
  fact.lastSeen = now
  return true
}

/** Record that a rendered snapshot included these facts. */
export function markInjected(store: FactStore, ids: ReadonlyArray<string>): number {
  let count = 0
  for (const id of ids) {
    const fact = store.facts[id]
    if (fact === undefined) continue
    fact.injected += 1
    count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN))
}

/**
 * Render the injectable facts as one stable system block.
 *
 * Ordering is by id, never by score: two passes over the same record produce
 * byte-identical text, and an insertion order cannot churn the provider prefix.
 * The caps are hard: at most `MAX_FACTS` facts and `MAX_TOKENS` estimated
 * tokens, header included. A fact is included whole or not at all.
 */
export function renderFacts(store: FactStore, options: FactRenderOptions = {}): FactRender {
  const header = (options.header ?? FACT_HEADER).trim()
  const maxFacts = Math.max(0, Math.min(options.maxFacts ?? MAX_FACTS, MAX_FACTS))
  const maxTokens = Math.max(0, Math.min(options.maxTokens ?? MAX_TOKENS, MAX_TOKENS))
  const includeIds = options.includeIds ?? true
  const empty: FactRender = { text: "", ids: [], facts: [], tokens: 0, chars: 0 }

  if (header.length === 0 || maxFacts === 0 || maxTokens === 0) return empty
  if (estimateTokens(header.length) > maxTokens) return empty

  const eligible = Object.values(store.facts)
    .filter((fact) => isInjectable(fact.lifecycle) && fact.claim.length > 0 && factLint(fact.claim) === undefined)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

  const lines: string[] = [header]
  const ids: string[] = []
  const facts: ProjectFact[] = []
  let chars = header.length
  for (const fact of eligible) {
    if (facts.length >= maxFacts) break
    const bullet = includeIds ? `- [${fact.id}] ${fact.claim}` : `- ${fact.claim}`
    const nextChars = chars + 1 + bullet.length
    if (estimateTokens(nextChars) > maxTokens) continue
    lines.push(bullet)
    ids.push(fact.id)
    facts.push(fact)
    chars = nextChars
  }

  // A header with no fact is not a block: injecting it would spend tokens on a
  // label and tell the model nothing.
  if (facts.length === 0) return empty

  const text = lines.join("\n")
  return { text, ids, facts, tokens: estimateTokens(text.length), chars: text.length }
}

// ---------------------------------------------------------------------------
// Inspection and pruning
// ---------------------------------------------------------------------------

/** The `/context facts` rows: active and candidate facts, deterministic order. */
export function describeFacts(store: FactStore): FactDescription[] {
  const rows: FactDescription[] = []
  for (const fact of [...Object.values(store.facts), ...Object.values(store.candidates)]) {
    rows.push({
      id: fact.id,
      family: fact.family,
      state: fact.lifecycle.state,
      claim: fact.claim,
      confirms: fact.lifecycle.confirms.length,
      contradictions: fact.lifecycle.contradicts.length,
      fireNum: fact.lifecycle.fireNum,
      fireDen: fact.lifecycle.fireDen,
      firingRate: firingRate(fact.lifecycle),
      injectable: isInjectable(fact.lifecycle),
      firstSeen: fact.firstSeen,
      lastSeen: fact.lastSeen,
      injected: fact.injected,
    })
  }
  rows.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return rows
}

/**
 * Drop stale candidates and retired facts: 90 days without a sighting, then a
 * count cap. Active facts are never pruned here; a contradiction retires them.
 */
export function pruneFacts(store: FactStore, now = Date.now()): { candidates: number; retired: number } {
  let candidates = 0
  let retired = 0

  const candidateRows = Object.values(store.candidates).sort((left, right) => left.lastSeen - right.lastSeen)
  for (const fact of candidateRows) {
    const stale = now - fact.lastSeen > RETENTION_MS
    const overCap = Object.keys(store.candidates).length > MAX_CANDIDATES
    if (stale || overCap) {
      delete store.candidates[fact.id]
      candidates += 1
    }
  }

  const retiredRows = Object.values(store.retired).sort((left, right) => left.at - right.at)
  for (const entry of retiredRows) {
    const stale = now - entry.at > RETENTION_MS
    const overCap = Object.keys(store.retired).length > MAX_RETIRED
    if (stale || overCap) {
      delete store.retired[entry.fact.id]
      retired += 1
    }
  }

  return { candidates, retired }
}

// ---------------------------------------------------------------------------
// Normalization (a record written by an older version must still load)
// ---------------------------------------------------------------------------

function normalizeLifecycle(value: unknown, family: FactFamily): FactLifecycle {
  const source = isPlainObject(value) ? value : {}
  const state =
    source.state === "ACTIVE" || source.state === "RETIRED" || source.state === "CANDIDATE"
      ? source.state
      : "CANDIDATE"
  const confirms: FactConfirmation[] = []
  if (Array.isArray(source.confirms)) {
    for (const entry of source.confirms) {
      if (!isPlainObject(entry) || typeof entry.session !== "string") continue
      confirms.push({
        session: entry.session,
        step: finite(entry.step),
        files: stringArray(entry.files),
      })
    }
  }
  const contradicts: FactContradiction[] = []
  if (Array.isArray(source.contradicts)) {
    for (const entry of source.contradicts) {
      if (!isPlainObject(entry) || typeof entry.session !== "string") continue
      contradicts.push({ session: entry.session, step: finite(entry.step) })
    }
  }
  const fireSessions = stringArray(source.fireSessions)
  const firedSessions = stringArray(source.firedSessions)
  return {
    state,
    high: typeof source.high === "boolean" ? source.high : HIGH_STAKES[family],
    drift: source.drift === true,
    confirms,
    contradicts,
    fireNum: Math.max(0, Math.floor(finite(source.fireNum))),
    fireDen: Math.max(0, Math.floor(finite(source.fireDen, fireSessions.length))),
    fireSessions,
    firedSessions,
    promotedAtStep: typeof source.promotedAtStep === "number" ? source.promotedAtStep : undefined,
    retiredAtStep: typeof source.retiredAtStep === "number" ? source.retiredAtStep : undefined,
    retiredAt: typeof source.retiredAt === "number" ? source.retiredAt : undefined,
    reason: typeof source.reason === "string" ? source.reason : undefined,
  }
}

/** Defensive read of a fact record; undefined when it is not one. */
export function normalizeFact(value: unknown): ProjectFact | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.id !== "string" || value.id.length === 0) return undefined
  if (typeof value.family !== "string" || !FAMILY_SET.has(value.family)) return undefined
  const family = value.family as FactFamily
  const params: Record<string, string> = {}
  if (isPlainObject(value.params)) {
    for (const [key, entry] of Object.entries(value.params)) {
      if (typeof entry === "string") params[key] = compact(entry)
    }
  }
  const lifecycle = normalizeLifecycle(value.lifecycle, family)
  const claim =
    typeof value.claim === "string" && value.claim.length > 0 ? value.claim : claimFor(family, params)
  return {
    id: value.id,
    family,
    claim,
    params,
    lifecycle,
    firstSeen: finite(value.firstSeen, Date.now()),
    lastSeen: finite(value.lastSeen, Date.now()),
    injected: Math.max(0, Math.floor(finite(value.injected))),
  }
}

/** Defensive read of a retired-fact entry; undefined when it is not one. */
export function normalizeRetired(value: unknown): RetiredFact | undefined {
  if (!isPlainObject(value)) return undefined
  const fact = normalizeFact(value.fact)
  if (fact === undefined) return undefined
  const reason =
    value.reason === "forgotten" || value.reason === "expired" || value.reason === "evicted"
      ? value.reason
      : "contradiction"
  return { fact, reason, at: finite(value.at, Date.now()) }
}

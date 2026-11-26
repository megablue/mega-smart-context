/**
 * Learn project facts from observed tool outcomes.
 *
 * The only inputs are a tool call and the result the host returned for it. The
 * shell tools come first: a command, its exit code and a canonical error
 * signature. Assistant prose is never read, and raw output is never stored: the
 * output is parsed for a signature, then discarded. Commands and the few
 * parameters a claim keeps are redacted before they reach a fact.
 *
 * @module mega-smart-context/facts-learn
 */
import { createHash } from "node:crypto"

import {
  applyEvidence,
  factId,
  pruneFacts,
  renderFacts,
  type FactDraft,
  type FactEvidence,
  type FactOutcome,
  type FactStore,
} from "./facts.ts"
import { PROJECT_SEEN_MAX, type ProjectRecord } from "./project.ts"
import { isPlainObject, type ContentPart, type Message } from "./types.ts"

/** Shell-shaped tools whose results carry a command and an exit status. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "shell",
  // This plugin replaces the host's `shell` with `run`; the learner must see it.
  "run",
  "bash",
  "sh",
  "zsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "pwsh",
  "terminal",
  "exec",
])

const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "multiedit",
  "write",
  "create",
  "apply_patch",
  "str_replace_editor",
])

const PARSE_LIMIT = 12_000
const MAX_OBSERVATION_COMMAND = 200

/** One observed outcome. There is deliberately no `output` field. */
export interface ToolObservation {
  sessionID: string
  turnID?: string
  callID?: string
  tool: string
  /** Redacted, whitespace-normalized command for a shell tool. */
  command?: string
  exitCode?: number
  /** Canonical error signature, never the raw message. */
  signature?: string
  /** The executable the failure said was missing, when it named one. */
  missingTool?: string
  ok: boolean
  /** A successful discovery probe returned no text. */
  empty?: boolean
  /** A redacted hostname, for a boundary observation. */
  host?: string
  /** An environment variable name the failure named, never its value. */
  envVar?: string
  /** Files an edit tool touched, for drift-aware promotion. */
  files?: string[]
  order: number
}

export interface ExtractOptions {
  sessionID: string
  turnID?: string
}

export interface FoldOptions {
  sessionID: string
  turnID?: string
  /** Force a logical step (tests and replay). Defaults to the next record step. */
  step?: number
  /** Wall clock for first/last seen and retirement. */
  now?: number
  /** Files the session edited, when the caller tracked them. */
  files?: string[]
}

export interface FoldResult {
  duplicate: boolean
  step: number
  observations: number
  factIds: string[]
  outcomes: FactOutcome[]
  promoted: number
  retired: number
  candidates: number
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Redact everything a fact must never keep: home paths, URL credentials,
 * query-string secrets, key/value secrets, bearer tokens and common token
 * shapes. The result is bounded and whitespace-normalized.
 */
export function redactText(value: string, maxChars = 400): string {
  let text = String(value ?? "").replace(/\r\n?/gu, "\n")

  // Home paths before the generic token rules, so a user name does not survive.
  text = text.replace(/(?:[A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'<>]+/giu, "<home>")
  text = text.replace(/(^|[\s"'`(=])\/(?:home|Users)\/[^/\s"'`<>]+/gu, "$1<home>")

  // URL userinfo: scheme://user:password@host -> scheme://<redacted>@host.
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/giu, "$1<redacted>@")

  // Secrets in a query string.
  text = text.replace(
    /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|key)=)[^&\s#]+/giu,
    "$1<redacted>",
  )

  // Authorization headers and key/value secrets, including --password VALUE.
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "$1 <redacted>")
  text = text.replace(
    /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|authorization))\b(\s*(?:=|:)\s*|\s+)(["']?)[^\s"',;]{3,}\3/giu,
    "$1$2$3<redacted>$3",
  )

  // Common token shapes, then one last opaque-long-value guard.
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "<redacted>")
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "<redacted>")
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "<redacted>")
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/gu, "<redacted>")
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/giu, "<redacted>")
  text = text.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu, "<redacted>")
  text = text.replace(/\b[A-Za-z0-9_+/=-]{48,}\b/gu, "<redacted>")

  text = text.replace(/\s+/gu, " ").trim()
  return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text
}

// ---------------------------------------------------------------------------
// Commands and signatures
// ---------------------------------------------------------------------------

/** Collapse whitespace in a command. */
export function normalizeCommand(command: string): string {
  return String(command ?? "").replace(/\s+/gu, " ").trim().slice(0, MAX_OBSERVATION_COMMAND)
}

/**
 * The stable form of a command: the leading tokens up to the first option or
 * path. `npm test -- --run` and `npm test` share the form `npm test`; two
 * different runners do not.
 */
export function commandForm(command: string): string {
  const tokens = normalizeCommand(command).split(" ").filter((token) => token.length > 0)
  const out: string[] = []
  for (const token of tokens) {
    if (token.startsWith("-")) break
    if (out.length >= 3) break
    out.push(token)
  }
  return out.join(" ").toLowerCase()
}

/** The executable name of a command, without a directory prefix. */
export function toolOf(command: string): string {
  const first = normalizeCommand(command).split(" ")[0] ?? ""
  const cleaned = first.replace(/^["']|["']$/gu, "")
  const pieces = cleaned.split(/[\\/]/u)
  return (pieces[pieces.length - 1] ?? cleaned).toLowerCase()
}

const NETWORK_HOST = /\bhttps?:\/\/(?:[^/\s@]+@)?([^/\s:@]+)/iu

/** A hostname from a redacted failure text or command; no credentials can survive. */
export function hostOf(text: string): string | undefined {
  const match = NETWORK_HOST.exec(redactText(text, 1000))
  if (match === null) return undefined
  const host = match[1].toLowerCase().replace(/[^a-z0-9.-]+/gu, "").slice(0, 120)
  return host.length > 0 ? host : undefined
}

const ENV_NAMES = [
  /(?:environment variable|env(?:ironment)? var(?:iable)?|variable)\s+[`"']?([A-Z][A-Z0-9_]{2,})[`"']?\s+(?:is\s+)?(?:not set|missing|required)/iu,
  /(?:set|export|define)\s+[`"']?([A-Z][A-Z0-9_]{2,})[`"']?/u,
  /keyerror:\s*["']([A-Z][A-Z0-9_]{2,})["']/iu,
]

/**
 * The executable a command-not-found message names, when it names the same one
 * the command tried to run. A missing package in a test runner's output does not
 * get mistaken for a missing runner.
 */
export function missingToolOf(text: string, command: string): string | undefined {
  const wanted = toolOf(command)
  if (wanted.length === 0) return undefined
  const patterns = [
    /(?:command not found:?\s*)([A-Za-z0-9_.\\/-]+)/iu,
    /(?:^|[\s:])([A-Za-z0-9_.\\/-]+): (?:command )?not found\b/iu,
    /["']?([A-Za-z0-9_.\\/-]+)["']? is not recognized as an internal or external command/iu,
    /executable file not found[: ]+([A-Za-z0-9_.\\/-]+)/iu,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1] === undefined) continue
    const named = toolOf(match[1])
    if (named === wanted) return wanted
  }
  return undefined
}

/** A successful empty discovery probe, not every command that happens to print nothing. */
export function isProbeCommand(command: string): boolean {
  return /^git\s+(?:remote|branch\s+-r|tag|show-ref|rev-list)\b/iu.test(normalizeCommand(command))
}

/** An environment variable name a failure named; never a value. */
export function envVarOf(text: string): string | undefined {
  for (const pattern of ENV_NAMES) {
    const match = pattern.exec(text)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

/**
 * A canonical error signature. The raw message never leaves this function; a
 * fact can say "command not found" but never quote the 40 lines around it.
 */
export function signatureOf(text: string, exitCode?: number): string {
  const lower = String(text ?? "").toLowerCase()
  if (
    lower.includes("command not found") ||
    lower.includes("is not recognized as an internal or external command") ||
    lower.includes("executable file not found") ||
    /(?:^|[:\s])(?:[a-z0-9_.-]+): not found\b/u.test(lower)
  ) {
    return "command not found"
  }
  const env = envVarOf(text)
  if (env !== undefined) return "env:" + env
  if (
    lower.includes("modulenotfounderror") ||
    lower.includes("no module named") ||
    lower.includes("cannot find module")
  ) {
    return "module missing"
  }
  if (lower.includes("permission denied") || lower.includes("eacces") || lower.includes("access is denied")) {
    return "permission denied"
  }
  if (lower.includes("econnrefused") || lower.includes("connection refused") || lower.includes("failed to connect")) {
    return "connection refused"
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo") || lower.includes("name or service not known")) {
    return "dns failure"
  }
  if (lower.includes("etimedout") || lower.includes("timed out") || lower.includes("timeout")) {
    return "network timeout"
  }
  if (
    lower.startsWith("usage:") ||
    lower.includes("unknown option") ||
    lower.includes("invalid option") ||
    lower.includes("unrecognized argument")
  ) {
    return "usage error"
  }
  if (exitCode !== undefined && exitCode !== 0) return "non-zero exit"
  if (/\b(error|failed|failure|fatal)\b/u.test(lower)) return "non-zero exit"
  return exitCode !== undefined && exitCode !== 0 ? "non-zero exit" : "non-zero exit"
}

/** Readable wording for a signature, used inside a claim. */
export function signatureLabel(signature: string): string {
  if (signature.startsWith("env:")) return "a missing environment variable"
  switch (signature) {
    case "command not found":
      return "command not found"
    case "module missing":
      return "ModuleNotFoundError"
    case "permission denied":
      return "permission denied"
    case "connection refused":
      return "connection refused"
    case "dns failure":
      return "a DNS failure"
    case "network timeout":
      return "a timeout"
    case "usage error":
      return "a usage error"
    default:
      return "a non-zero exit"
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function textOfValue(value: unknown, depth = 0): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  if (depth > 4) return ""
  if (Array.isArray(value)) return value.map((item) => textOfValue(item, depth + 1)).join("\n")
  if (isPlainObject(value)) {
    const parts: string[] = []
    for (const key of ["output", "stdout", "stderr", "text", "content", "message", "error"]) {
      if (key in value) parts.push(textOfValue(value[key], depth + 1))
    }
    if (parts.length === 0) {
      try {
        return JSON.stringify(value)
      } catch {
        return ""
      }
    }
    return parts.join("\n")
  }
  return String(value)
}

function numericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === "string" && /^-?\d{1,3}$/u.test(value.trim())) return Number(value.trim())
  return undefined
}

/** The outcome a `run`-shaped result reports, at the top level or under `output`. */
function stateOf(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined
  for (const source of [
    value,
    isPlainObject(value.output) ? value.output : undefined,
    isPlainObject(value.metadata) ? value.metadata : undefined,
  ]) {
    if (source === undefined) continue
    const state = source.state
    if (typeof state === "string" && state.length > 0) return state.toLowerCase()
  }
  return undefined
}

function exitCodeOf(value: unknown, text: string): number | undefined {
  if (isPlainObject(value)) {
    for (const source of [
      value,
      isPlainObject(value.output) ? value.output : undefined,
      isPlainObject(value.metadata) ? value.metadata : undefined,
    ]) {
      if (source === undefined) continue
      for (const key of ["exitCode", "exit_code", "status"]) {
        const code = numericCode(source[key])
        if (code !== undefined) return code
      }
    }
    const code = numericCode(value.code)
    if (code !== undefined) return code
  }
  const match =
    /\b(?:exit(?:ed)?(?:\s+with)?\s+(?:code\s+)?|exitCode["']?\s*[:=]\s*)(-?\d{1,3})\b/iu.exec(text) ??
    /\$LASTEXITCODE\s*(?:=|:)\s*(-?\d{1,3})\b/iu.exec(text)
  return match === null ? undefined : Number(match[1])
}

function okOf(value: unknown, exitCode: number | undefined, text: string): boolean {
  if (exitCode !== undefined) return exitCode === 0
  const state = stateOf(value)
  if (state === "failed" || state === "stopped" || state === "error") return false
  if (state === "completed" || state === "ready") return true
  if (isPlainObject(value)) {
    if (value.ok === false || value.success === false || value.isError === true) return false
    if (value.ok === true || value.success === true) return true
  }
  if (/\b(command not found|is not recognized as an internal or external command|permission denied|econnrefused|enotfound|modulenotfounderror)\b/iu.test(text)) {
    return false
  }
  return true
}

function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return normalizeCommand(input)
  if (!isPlainObject(input)) return undefined
  for (const key of ["command", "cmd", "script"]) {
    if (typeof input[key] === "string") return normalizeCommand(input[key])
  }
  if (Array.isArray(input.args)) {
    return normalizeCommand(input.args.filter((item): item is string => typeof item === "string").join(" "))
  }
  return undefined
}

function filesOf(name: string, input: unknown): string[] {
  if (!EDIT_TOOLS.has(name) || !isPlainObject(input)) return []
  const files: string[] = []
  for (const key of ["file_path", "path", "relative_path"]) {
    if (typeof input[key] === "string") files.push(input[key])
  }
  if (Array.isArray(input.paths)) {
    for (const path of input.paths) if (typeof path === "string") files.push(path)
  }
  return files
}

function isCall(part: ContentPart): boolean {
  return part.type === "tool-call"
}

function isResult(part: ContentPart): boolean {
  return part.type === "tool-result"
}

/**
 * Pair each tool call with its observed result and return one observation per
 * completed call. A call with no result is ignored: an intention is not evidence.
 */
export function extractObservations(
  messages: ReadonlyArray<Message>,
  options: ExtractOptions,
): ToolObservation[] {
  const calls: Array<{ id: string; name: string; input: unknown; order: number }> = []
  const results = new Map<string, unknown>()
  let order = 0

  for (const message of messages ?? []) {
    for (const part of message.content ?? []) {
      if (isCall(part)) {
        const call = part as { id?: unknown; name?: unknown; input?: unknown }
        const id = typeof call.id === "string" ? call.id : `call-${order}`
        const name = typeof call.name === "string" ? call.name.toLowerCase() : ""
        if (name.length === 0) continue
        calls.push({ id, name, input: call.input, order: order++ })
      } else if (isResult(part)) {
        const result = part as { id?: unknown; result?: { value?: unknown } }
        if (typeof result.id === "string") results.set(result.id, result.result?.value)
      }
    }
  }

  const observations: ToolObservation[] = []
  for (const call of calls) {
    if (!results.has(call.id)) continue
    const value = results.get(call.id)
    // A job that is still running has not produced an outcome; folding it would
    // invent one. The completion note arrives on a later pass with a finished state.
    if (stateOf(value) === "running") continue
    const text = textOfValue(value).slice(0, PARSE_LIMIT)
    const shell = SHELL_TOOLS.has(call.name)
    const command = shell ? commandOf(call.input) : undefined
    const exitCode = exitCodeOf(value, text)
    const ok = okOf(value, exitCode, text)
    const signature = ok ? undefined : signatureOf(text, exitCode)
    const missingTool =
      shell && !ok && signature === "command not found" && command !== undefined
        ? missingToolOf(text, command)
        : undefined
    const host = shell ? hostOf(text + " " + (command ?? "")) : undefined
    const envVar = ok ? undefined : envVarOf(text)
    const empty = shell && ok ? text.trim().length === 0 : undefined
    const files = filesOf(call.name, call.input)
    observations.push({
      sessionID: options.sessionID,
      turnID: options.turnID,
      callID: call.id,
      tool: call.name,
      command: command !== undefined && command.length > 0 ? redactText(command, MAX_OBSERVATION_COMMAND) : undefined,
      exitCode,
      signature,
      missingTool,
      ok,
      empty,
      host,
      envVar,
      files: files.length > 0 ? files : undefined,
      order: call.order,
    })
  }
  return observations
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

function fingerprint(observations: ReadonlyArray<ToolObservation>, options: FoldOptions): string {
  const identity =
    options.turnID !== undefined && options.turnID.length > 0
      ? "turn:" + options.turnID
      : observations
          .map((observation) => observation.callID ?? `${observation.tool}:${observation.command ?? ""}:${observation.exitCode ?? ""}`)
          .join("|")
  return options.sessionID + "|" + createHash("sha256").update(identity).digest("hex").slice(0, 16)
}

function draftOf(fact: { id: string; family: FactDraft["family"]; params: Record<string, string>; lifecycle: { high: boolean; drift: boolean } }): FactDraft {
  return {
    id: fact.id,
    family: fact.family,
    params: fact.params,
    high: fact.lifecycle.high,
    drift: fact.lifecycle.drift,
  }
}

function evidenceFor(
  fact: { family: FactDraft["family"]; params: Record<string, string> },
  observations: ReadonlyArray<ToolObservation>,
  options: FoldOptions,
): FactEvidence | undefined {
  const session = options.sessionID
  const files = options.files ?? []
  if (fact.family === "absent_tool") {
    const tool = fact.params.tool
    if (tool === undefined) return undefined
    const relevant = observations.filter((observation) => observation.command !== undefined && toolOf(observation.command) === tool)
    if (relevant.length === 0) return undefined
    if (relevant.some((observation) => observation.ok)) {
      return { kind: "contradict", session, step: 0, exercised: true, fired: false, files }
    }
    if (relevant.some((observation) => !observation.ok && observation.signature === "command not found")) {
      return { kind: "confirm", session, step: 0, exercised: true, fired: true, files }
    }
    return undefined
  }

  if (fact.family === "form_repair" || fact.family === "arg_repair") {
    const failed = fact.params.failed
    const worked = fact.params.worked
    const relevant = observations.filter(
      (observation) =>
        observation.command !== undefined && (observation.command === failed || observation.command === worked),
    )
    if (relevant.length === 0) return undefined
    const contradiction = relevant.some(
      (observation) =>
        (observation.command === worked && !observation.ok) ||
        (observation.command === failed && observation.ok),
    )
    if (contradiction) {
      return { kind: "contradict", session, step: 0, exercised: true, fired: false, files }
    }
    const fired = relevant.some((observation) => observation.command === failed && !observation.ok)
    return { kind: "confirm", session, step: 0, exercised: true, fired, files }
  }

  if (fact.family === "boundary") {
    const host = fact.params.host
    if (host === undefined) return undefined
    const relevant = observations.filter((observation) => observation.host === host)
    if (relevant.length === 0) return undefined
    if (relevant.some((observation) => observation.ok)) {
      return { kind: "contradict", session, step: 0, exercised: true, fired: false, files }
    }
    return { kind: "confirm", session, step: 0, exercised: true, fired: true, files }
  }

  if (fact.family === "env_value") {
    const variable = fact.params.variable
    if (variable === undefined) return undefined
    const relevant = observations.filter((observation) => observation.envVar === variable)
    if (relevant.length === 0) return undefined
    return {
      kind: relevant.some((observation) => observation.ok) ? "contradict" : "confirm",
      session,
      step: 0,
      exercised: true,
      fired: relevant.some((observation) => !observation.ok),
      files,
    }
  }

  if (fact.family === "empty_probe") {
    const probe = fact.params.probe
    if (probe === undefined) return undefined
    const relevant = observations.filter(
      (observation) => observation.command !== undefined && commandForm(observation.command) === probe,
    )
    if (relevant.length === 0) return undefined
    if (relevant.some((observation) => observation.ok && observation.empty === false)) {
      return { kind: "contradict", session, step: 0, exercised: true, fired: false, files }
    }
    if (relevant.some((observation) => observation.ok && observation.empty === true)) {
      return { kind: "confirm", session, step: 0, exercised: true, fired: true, files }
    }
    return undefined
  }

  return undefined
}

/**
 * Deduplicate, fold and prune one turn's observations.
 *
 * The turn fingerprint makes a repeated idle event a no-op. Within the fold a
 * fact receives at most one evidence event per session; the lifecycle dedupes
 * by session again, so two turns in one session cannot promote a fact on their
 * own.
 */
export function foldObservations(
  record: ProjectRecord,
  observations: ReadonlyArray<ToolObservation>,
  options: FoldOptions,
): FoldResult {
  const now = options.now ?? Date.now()
  if (observations.length === 0) {
    return {
      duplicate: false,
      step: record.envelope.step,
      observations: 0,
      factIds: [],
      outcomes: [],
      promoted: 0,
      retired: 0,
      candidates: 0,
    }
  }

  const key = fingerprint(observations, options)
  if (record.envelope.seen.includes(key)) {
    return {
      duplicate: true,
      step: record.envelope.step,
      observations: observations.length,
      factIds: [],
      outcomes: [],
      promoted: 0,
      retired: 0,
      candidates: 0,
    }
  }

  const step = Math.max(record.envelope.step + 1, options.step ?? 0)
  record.envelope.step = step
  record.envelope.sessions += 1
  record.envelope.seen.push(key)
  if (record.envelope.seen.length > PROJECT_SEEN_MAX) {
    record.envelope.seen = record.envelope.seen.slice(-PROJECT_SEEN_MAX)
  }

  // Tool usage is folded separately from completed prompt-turns in tool-usage.ts.
  // Counting here as well would double every call once the report is enabled.

  const ordered = [...observations].sort((left, right) => left.order - right.order)
  const session = options.sessionID
  const files = options.files ?? []
  const outcomes: FactOutcome[] = []
  const applied = new Set<string>()

  const apply = (draft: FactDraft, evidence: FactEvidence): void => {
    if (applied.has(draft.id ?? factId(draft.family, draft.params ?? {}))) return
    const outcome = applyEvidence(record, draft, evidence, { now })
    if (outcome === undefined) return
    applied.add(outcome.fact.id)
    outcomes.push(outcome)
  }

  // ---- new drafts from this fold -----------------------------------------
  const missingTools = new Set<string>()
  const workingTools = new Set<string>()
  for (const observation of ordered) {
    if (observation.command === undefined) continue
    if (observation.ok) workingTools.add(toolOf(observation.command))
    else if (observation.missingTool !== undefined) missingTools.add(observation.missingTool)
  }
  for (const tool of missingTools) {
    if (tool.length === 0 || workingTools.has(tool)) continue
    apply(
      { family: "absent_tool", params: { tool }, high: true },
      { kind: "confirm", session, step, exercised: true, fired: true, files },
    )
  }

  for (const observation of ordered) {
    if (observation.command === undefined) continue
    if (!observation.ok && observation.signature === "command not found") continue
    if (observation.ok) {
      if (observation.empty === true && isProbeCommand(observation.command)) {
        const probe = commandForm(observation.command)
        if (probe.length > 0) {
          apply(
            { family: "empty_probe", params: { probe } },
            { kind: "confirm", session, step, exercised: true, fired: true, files },
          )
        }
      }
      continue
    }

    if (observation.signature === "connection refused" || observation.signature === "dns failure") {
      if (observation.host !== undefined) {
        apply(
          { family: "boundary", params: { host: observation.host }, high: true },
          { kind: "confirm", session, step, exercised: true, fired: true, files },
        )
      }
      continue
    }

    if (observation.signature?.startsWith("env:")) {
      const variable = observation.envVar ?? observation.signature.slice(4)
      if (variable.length > 0) {
        const laterSuccess = ordered.some(
          (other) =>
            other.order > observation.order &&
            other.ok &&
            other.command !== undefined &&
            commandForm(other.command) === commandForm(observation.command ?? ""),
        )
        if (laterSuccess) {
          apply(
            { family: "env_value", params: { variable } },
            { kind: "confirm", session, step, exercised: true, fired: true, files },
          )
        }
      }
      continue
    }

    const failedForm = commandForm(observation.command)
    const later = ordered.find(
      (other) =>
        other.order > observation.order &&
        other.ok &&
        other.command !== undefined &&
        other.command !== observation.command &&
        commandForm(other.command) === failedForm,
    )
    if (later?.command !== undefined && failedForm.length > 0) {
      apply(
        {
          family: "form_repair",
          params: {
            failed: observation.command,
            worked: later.command,
            error: signatureLabel(observation.signature ?? "non-zero exit"),
          },
        },
        { kind: "confirm", session, step, exercised: true, fired: true, files },
      )
    }
  }

  // ---- new evidence for facts already known -------------------------------
  for (const fact of [...Object.values(record.facts), ...Object.values(record.candidates)]) {
    if (applied.has(fact.id)) continue
    const evidence = evidenceFor(fact, ordered, options)
    if (evidence === undefined) continue
    apply(draftOf(fact), { ...evidence, step })
  }

  pruneFacts(record, now)
  const rendered = renderFacts(record)
  record.envelope.rendered = rendered.text.length > 0 ? rendered.text : undefined
  record.envelope.tokens = rendered.tokens

  return {
    duplicate: false,
    step,
    observations: observations.length,
    factIds: outcomes.map((outcome) => outcome.fact.id),
    outcomes,
    promoted: outcomes.filter((outcome) => outcome.action === "promoted").length,
    retired: outcomes.filter((outcome) => outcome.action === "retired").length,
    candidates: outcomes.filter((outcome) => outcome.action === "candidate").length,
  }
}

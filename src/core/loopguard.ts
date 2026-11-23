/**
 * The loop guard: a pure per-turn fold that detects repeated failed work and
 * returns one short redirect.
 *
 * It is deliberately a state machine over tool calls, not a second model call:
 * the same failed call and error signature three times, five failures without a
 * verification, eight edits without a check, or a turn that has run past its
 * envelope with the same failure still repeating. The first match in a turn
 * produces one line; a turn that has verified green produces none.
 *
 * The state is compact (counters, two bounded maps and the stored redirect), so
 * it can live on the session record and be normalized after a restart. The
 * redirect is appended to the trailing state note, after the current turn, so
 * every earlier byte of the payload stays put and a provider prefix cache keeps
 * its prefix.
 *
 * @module mega-smart-context/loopguard
 */

import type {
  LoopGuardRepeat,
  LoopGuardState,
  Message,
  ToolCallPart,
  ToolResultPart,
} from "./types.ts"
import { isPlainObject } from "./types.ts"
import { isRealUser } from "./view.ts"

/** The two shipped threshold profiles. */
export type LoopGuardMode = "default" | "aggressive"

/** Why a turn got its redirect. */
export type LoopGuardReason = "repeat" | "failures" | "edits" | "envelope"

/** What the caller can tune without changing the state machine. */
export interface LoopGuardOptions {
  /** `default` (20-call fallback) or `aggressive` (14-call fallback). */
  readonly mode?: LoopGuardMode
  /** Redirects allowed per turn; the shipped value is 1. */
  readonly nudges?: number
  /** A floor for the over-envelope rule. */
  readonly minCalls?: number
  /** Set false to keep the three fixed rules but disable the over-envelope rule. */
  readonly envelopeEnabled?: boolean
  /**
   * A project/history envelope supplied by the caller. When finite and positive
   * it wins over the session samples; otherwise the p90 of green turns is used,
   * then the mode's conservative fallback.
   */
  readonly envelope?: number
}

/** The state after folding the newest turn, plus the current redirect, if any. */
export interface LoopGuardDecision {
  readonly state: LoopGuardState
  readonly redirect?: string
  readonly reason?: LoopGuardReason
}

/** The conservative fallback before a session has enough green turns. */
export const DEFAULT_LOOP_GUARD_ENVELOPE = 20
/** The aggressive fallback. */
export const AGGRESSIVE_LOOP_GUARD_ENVELOPE = 14
/** Green turns needed before the p90 replaces the fallback. */
export const LOOP_GUARD_MIN_SAMPLES = 5
/** How many green-turn lengths one session remembers. */
export const MAX_LOOP_GUARD_SAMPLES = 32
/** How many error signatures and call fingerprints one turn remembers. */
export const MAX_LOOP_GUARD_SIGNATURES = 64
/** The longest stored error signature, in characters. */
export const MAX_LOOP_GUARD_SIGNATURE = 120
/** The longest stored call label, in characters. */
export const MAX_LOOP_GUARD_LABEL = 80
/** The longest stored redirect, in characters. */
export const MAX_LOOP_GUARD_REDIRECT = 600

const MAX_TURN_ID = 200
const MAX_COUNTER = 1_000_000
const MAX_ENVELOPE = 200
const MIN_ENVELOPE = 4

const EDIT_TOOLS = new Set(["edit", "write", "patch", "str_replace", "apply_patch", "multiedit"])
const NEW_FILE_TOOLS = new Set(["write"])
const READ_TOOLS = new Set(["read", "view", "grep", "glob", "list", "ls", "search"])
const SHELL_TOOLS = new Set(["bash", "shell", "execute", "terminal", "run", "powershell"])

const TOOL_ALIASES: Record<string, string> = {
  str_replace: "edit",
  apply_patch: "edit",
  multiedit: "edit",
  create: "write",
}

/** The source extensions the shell-edit heuristic recognises, across ecosystems. */
const SOURCE_EXT =
  "(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|php|cs|c|cc|cpp|h|hpp|swift|scala|sh|ps1|sql|json|ya?ml|toml|md|html?|css|scss|sass|less)"
const SHELL_IN_PLACE = /\bsed\s+(?:-[A-Za-z]*i|--in-place)\b|\bperl\s+-[A-Za-z]*i\b/i
const SHELL_PATCH = /\b(?:patch|git\s+apply)\b/i
const SHELL_TEE = new RegExp("\\btee\\s+(?:-a\\s+)?[^\\s&|;<>\"']*\\." + SOURCE_EXT + "(?:\\s|$)", "i")
const SHELL_REDIRECT = new RegExp("(?:^|[^>])>{1,2}\\s*[\"']?[^\\s&|;<>\"']+\\." + SOURCE_EXT + "(?:\\s|$)", "i")

/**
 * A shell command that edits a source file is an edit.
 *
 * sed -i, perl -pi, patch and git apply, and writes through tee or a
 * redirection into a source extension count. The extension gate keeps a test
 * report or a log redirect out of the edit count, so the edit rule does not
 * mistake logging for an unverified change.
 */
function isShellEdit(name: string, input: unknown): boolean {
  if (!SHELL_TOOLS.has(canonicalTool(name))) return false
  const command = stringArg(input, ["command", "cmd", "script"]) ?? ""
  return (
    SHELL_IN_PLACE.test(command) ||
    SHELL_PATCH.test(command) ||
    SHELL_TEE.test(command) ||
    SHELL_REDIRECT.test(command)
  )
}

/**
 * A command line that runs the project's own checks.
 *
 * Broader than "the tests" on purpose: the guard's edit rule is about failing to
 * verify at all, so a build, a typecheck, a linter or this repository's smoke
 * script all count.
 */
const VERIFY_COMMAND = new RegExp(
  [
    "\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|build|typecheck|lint|check|smoke)\\b",
    "\\b(?:npx|pnpx)\\s+(?:tsc|jest|vitest|mocha|pytest|eslint|ruff|mypy|pyright|biome)\\b",
    "\\b(?:tsc|jest|vitest|mocha|ava|pytest|tox|nox|eslint|ruff|mypy|pyright|biome|phpunit|rspec|ctest)\\b",
    "\\bnode\\s+--test\\b",
    "\\bnode\\s+[^\\s;&|]*\\.(?:test|spec)\\.[cm]?[jt]s\\b",
    "\\bpython\\d?(?:\\.\\d+)?\\s+-m\\s+(?:pytest|unittest|tox|nox)\\b",
    "\\b(?:cargo|go|dotnet|mvn|mvnw|gradle|gradlew|make)\\s+(?:[^\\s;&|]+\\s+)*(?:test|build|check|clippy|nextest)\\b",
    "\\b(?:swift|mix)\\s+test\\b",
    "\\b(?:manage\\.py\\s+test|runtests(?:\\.py)?)\\b",
    "\\bsmoke(?:\\.mjs)?\\b",
  ].join("|"),
  "i",
)

/**
 * A line that reports a failure, across the ecosystems this repository and its
 * users run. Content tools are exempt: a read that returns a test file full of
 * "assert" is not a failing call.
 */
const ERROR_SIGNAL = new RegExp(
  [
    "Traceback \\(most recent call last\\)",
    "\\b\\w*Error\\b",
    "\\bFAILED\\b",
    "\\bFAIL\\b",
    "\\bassert(?:ion)?\\b",
    "Exception",
    "errors during collection",
    "^# fail [1-9]",
    "^not ok \\d",
    "\\b[1-9]\\d* (?:failing|failures?)\\b",
    "Failures: [1-9]",
    "^--- FAIL: ",
    "^FAIL\\t",
    "^FAIL$",
    "command not found",
    "no such file",
    "permission denied",
    "cannot find module",
    "ENOENT",
  ].join("|"),
  "im",
)

/** An empty state for a session that has never seen a completed tool call. */
export function emptyLoopGuard(): LoopGuardState {
  return {
    version: 1,
    turn: "",
    calls: 0,
    failures: 0,
    edits: 0,
    verifications: 0,
    lastEditCall: 0,
    lastVerifyCall: 0,
    editsAtVerify: 0,
    lastVerifyOk: false,
    repeated: 0,
    reads: 0,
    newFiles: 0,
    errorSigs: {},
    repeatKeys: {},
    redirected: false,
    samples: [],
  }
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.replace(/\s+/gu, " ").trim()
  if (text.length === 0) return undefined
  return text.length <= max ? text : text.slice(0, max)
}

function boundedCount(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(MAX_COUNTER, Math.max(0, Math.round(value)))
}

function normalizeRepeat(value: unknown): LoopGuardRepeat | undefined {
  if (!isPlainObject(value)) return undefined
  const signature = boundedText(value.signature, MAX_LOOP_GUARD_SIGNATURE)
  const label = boundedText(value.label, MAX_LOOP_GUARD_LABEL)
  const count = boundedCount(value.count)
  if (signature === undefined || label === undefined || count === 0) return undefined
  return { count, signature, label }
}

function normalizeReason(value: unknown): LoopGuardReason | undefined {
  return value === "repeat" || value === "failures" || value === "edits" || value === "envelope"
    ? value
    : undefined
}

/**
 * Coerce a stored guard state into one the state machine can trust.
 *
 * Every string is bounded, every counter is a non-negative integer, the two
 * per-call maps are capped to the newest entries and the sample list is capped
 * to the newest green turns. A non-object returns `undefined`, which the caller
 * treats as "no guard state yet".
 */
export function normalizeLoopGuard(value: unknown): LoopGuardState | undefined {
  if (!isPlainObject(value)) return undefined
  const state = emptyLoopGuard()
  state.turn = boundedText(value.turn, MAX_TURN_ID) ?? ""
  state.calls = boundedCount(value.calls)
  state.failures = boundedCount(value.failures)
  state.edits = boundedCount(value.edits)
  state.verifications = boundedCount(value.verifications)
  state.lastEditCall = boundedCount(value.lastEditCall)
  state.lastVerifyCall = boundedCount(value.lastVerifyCall)
  state.editsAtVerify = boundedCount(value.editsAtVerify)
  state.lastVerifyOk = value.lastVerifyOk === true
  state.repeated = boundedCount(value.repeated)
  state.repeatedSignature = boundedText(value.repeatedSignature, MAX_LOOP_GUARD_SIGNATURE)
  state.repeatedLabel = boundedText(value.repeatedLabel, MAX_LOOP_GUARD_LABEL)
  state.reads = boundedCount(value.reads)
  state.newFiles = boundedCount(value.newFiles)

  if (isPlainObject(value.errorSigs)) {
    const entries = Object.entries(value.errorSigs)
    for (const [key, count] of entries.slice(Math.max(0, entries.length - MAX_LOOP_GUARD_SIGNATURES))) {
      const signature = boundedText(key, MAX_LOOP_GUARD_SIGNATURE * 2)
      const normalized = boundedCount(count)
      if (signature !== undefined && normalized > 0) state.errorSigs[signature] = normalized
    }
  }
  if (isPlainObject(value.repeatKeys)) {
    const entries = Object.entries(value.repeatKeys)
    for (const [key, repeat] of entries.slice(Math.max(0, entries.length - MAX_LOOP_GUARD_SIGNATURES))) {
      const normalized = normalizeRepeat(repeat)
      const fingerprint = boundedText(key, MAX_LOOP_GUARD_SIGNATURE * 3)
      if (normalized !== undefined && fingerprint !== undefined) state.repeatKeys[fingerprint] = normalized
    }
  }

  state.redirected = value.redirected === true
  if (state.redirected) {
    state.redirectReason = normalizeReason(value.redirectReason)
    state.redirectAt = boundedCount(value.redirectAt)
    state.redirectText = boundedText(value.redirectText, MAX_LOOP_GUARD_REDIRECT)
  }

  if (Array.isArray(value.samples)) {
    const samples = value.samples
      .filter((sample): sample is number => typeof sample === "number" && Number.isFinite(sample) && sample > 0)
      .map((sample) => boundedCount(sample))
      .filter((sample) => sample > 0)
    state.samples = samples.slice(Math.max(0, samples.length - MAX_LOOP_GUARD_SAMPLES))
  }
  return state
}

/** Stable JSON for argument fingerprints: sorted keys, bounded depth and size. */
function stableString(value: unknown, depth = 0): string {
  if (depth > 5) return '"\u2026"'
  if (value === null) return "null"
  if (typeof value === "string") {
    const text = value.trim()
    return JSON.stringify(text.length > 2_000 ? text.slice(0, 2_000) : text)
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (Array.isArray(value)) {
    return "[" + value.slice(0, 50).map((entry) => stableString(entry, depth + 1)).join(",") + "]"
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort().slice(0, 50)
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableString(value[key], depth + 1)).join(",") + "}"
  }
  return "null"
}

/** FNV-1a, enough to keep a call fingerprint short and deterministic. */
function fingerprintOf(value: unknown): string {
  const text = stableString(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function canonicalTool(name: string): string {
  const lower = (name || "?").toLowerCase()
  const tail = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower
  return TOOL_ALIASES[tail] ?? tail
}

function stringArg(input: unknown, keys: ReadonlyArray<string>): string | undefined {
  if (!isPlainObject(input)) return undefined
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return undefined
}

/** A short, human-readable name for the call the redirect mirrors back. */
function callLabel(name: string, input: unknown): string {
  const canonical = canonicalTool(name)
  const detail =
    stringArg(input, ["command", "cmd", "script"]) ??
    stringArg(input, ["path", "filePath", "file_path", "relative_path", "file"]) ??
    stringArg(input, ["pattern", "query", "search", "glob"]) ??
    ""
  const clean = detail.replace(/\s+/gu, " ").replace(/`/gu, "'").trim().slice(0, MAX_LOOP_GUARD_LABEL)
  return clean.length === 0 ? canonical : `${canonical} ${clean}`
}

function resultText(part: ToolResultPart): string {
  const value: any = part.result?.value
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((entry: any) => {
        if (typeof entry === "string") return entry
        if (typeof entry?.text === "string") return entry.text
        return stableString(entry)
      })
      .join("\n")
  }
  if (isPlainObject(value)) {
    for (const key of ["output", "stdout", "stderr", "text", "body", "message", "error"]) {
      const entry = value[key]
      if (typeof entry === "string" && entry.length > 0) return entry
    }
    return stableString(value)
  }
  if (value === undefined || value === null) return ""
  return String(value)
}

function explicitFailure(part: ToolResultPart): boolean {
  const raw: any = part as any
  if (raw.isError === true || raw.error !== undefined) return true
  const result: any = raw.result
  if (result?.type === "error") return true
  const value: any = result?.value
  if (!isPlainObject(value)) return false
  if (value.isError === true || value.error !== undefined || value.success === false) return true
  const exit = value.exitCode ?? value.exit_code
  if (typeof exit === "number" && exit !== 0) return true
  if (typeof value.code === "number" && value.code !== 0) return true
  return value.status === "error" || value.status === "failed" || value.status === "failure"
}

/** The normalized first failing line: numbers and paths vary, the failure does not. */
function signatureOf(text: string): string {
  const clean = text.replace(/\x1b\[[0-9;]*m/gu, "")
  const lines = clean.split(/\r?\n/u)
  const line = lines.find((candidate) => ERROR_SIGNAL.test(candidate)) ?? lines[0] ?? ""
  const normalized = line
    .replace(/\b0x[0-9a-f]+\b/giu, "0x?")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s:'"',;)]+/gu, "<path>")
    .replace(/\b\d+\b/gu, "#")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .slice(0, MAX_LOOP_GUARD_SIGNATURE)
  return normalized.length === 0 ? "tool failed" : normalized
}

function failureOf(name: string, part: ToolResultPart): { failed: boolean; signature?: string } {
  const canonical = canonicalTool(name)
  const text = resultText(part)
  if (explicitFailure(part)) return { failed: true, signature: signatureOf(text) }
  if (READ_TOOLS.has(canonical) || text.length === 0) return { failed: false }
  if (ERROR_SIGNAL.test(text)) return { failed: true, signature: signatureOf(text) }
  return { failed: false }
}

function isVerification(name: string, input: unknown): boolean {
  const canonical = canonicalTool(name)
  if (canonical === "test" || canonical === "check") return true
  if (!SHELL_TOOLS.has(canonical)) return false
  // Code Mode runs nested tools from one outer "execute" call; the check
  // commands live in the code string, not in a "command" field.
  const command = stringArg(input, ["command", "cmd", "script", "code"]) ?? ""
  return VERIFY_COMMAND.test(command)
}

interface CompletedCall {
  readonly name: string
  readonly input: unknown
  readonly result: ToolResultPart
}

/** Pair each completed call with its result, in the order the results arrived. */
function completedCalls(messages: ReadonlyArray<Message>): CompletedCall[] {
  const calls = new Map<string, { name: string; input: unknown }>()
  const out: CompletedCall[] = []
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type !== "tool-call") continue
      const call = part as ToolCallPart
      if (typeof call.id !== "string") continue
      calls.set(call.id, { name: call.name, input: call.input })
    }
    for (const part of message.content ?? []) {
      if (part.type !== "tool-result") continue
      const result = part as ToolResultPart
      const call = calls.get(result.id)
      if (call === undefined) continue
      calls.delete(result.id)
      out.push({ name: result.name || call.name, input: call.input, result })
    }
  }
  return out
}

interface CurrentTurn {
  readonly id: string
  readonly messages: ReadonlyArray<Message>
}

/** The newest real user turn; older completed turns are never guessed at. */
function currentTurn(messages: ReadonlyArray<Message>): CurrentTurn | undefined {
  let start = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRealUser(messages[index])) {
      start = index
      break
    }
  }
  if (start < 0) return undefined
  const message = messages[start]
  const id = typeof message.id === "string" && message.id.length > 0 ? message.id : `t${start}`
  return { id, messages: messages.slice(start) }
}

/** Is this turn green: the latest verification succeeded after the latest edit? */
export function loopGuardGreen(state: LoopGuardState): boolean {
  return (
    state.verifications > 0 &&
    state.lastVerifyOk &&
    state.editsAtVerify === state.edits &&
    state.lastVerifyCall >= state.lastEditCall
  )
}

function clampEnvelope(value: number): number {
  return Math.min(MAX_ENVELOPE, Math.max(MIN_ENVELOPE, Math.round(value)))
}

/**
 * Resolve the turn-length envelope.
 *
 * An external envelope (the project/history value a later integration can
 * supply) wins; otherwise the p90 of this session's green turns once there are
 * enough, then the mode's conservative fallback. Clamped to 4..200 so a corrupt
 * or tiny sample cannot make the guard fire on a normal short turn.
 */
export function loopGuardEnvelope(state: LoopGuardState, options: LoopGuardOptions = {}): number {
  const external = options.envelope
  if (typeof external === "number" && Number.isFinite(external) && external > 0) {
    return clampEnvelope(external)
  }
  if (state.samples.length >= LOOP_GUARD_MIN_SAMPLES) {
    const sorted = [...state.samples].sort((left, right) => left - right)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.9) - 1))
    return clampEnvelope(sorted[index])
  }
  return options.mode === "aggressive" ? AGGRESSIVE_LOOP_GUARD_ENVELOPE : DEFAULT_LOOP_GUARD_ENVELOPE
}

function minCallsOf(options: LoopGuardOptions): number {
  const fallback = options.mode === "aggressive" ? AGGRESSIVE_LOOP_GUARD_ENVELOPE : DEFAULT_LOOP_GUARD_ENVELOPE
  if (typeof options.minCalls !== "number" || !Number.isFinite(options.minCalls)) return fallback
  return clampEnvelope(options.minCalls)
}

function resetCounters(state: LoopGuardState): void {
  state.calls = 0
  state.failures = 0
  state.edits = 0
  state.verifications = 0
  state.lastEditCall = 0
  state.lastVerifyCall = 0
  state.editsAtVerify = 0
  state.lastVerifyOk = false
  state.repeated = 0
  delete state.repeatedSignature
  delete state.repeatedLabel
  state.reads = 0
  state.newFiles = 0
  state.errorSigs = {}
  state.repeatKeys = {}
}

function trimMap<T>(map: Record<string, T>): void {
  const keys = Object.keys(map)
  if (keys.length <= MAX_LOOP_GUARD_SIGNATURES) return
  for (const key of keys.slice(0, keys.length - MAX_LOOP_GUARD_SIGNATURES)) delete map[key]
}

function foldCall(state: LoopGuardState, call: CompletedCall, index: number): void {
  const canonical = canonicalTool(call.name)
  state.calls = index
  if (EDIT_TOOLS.has(canonical) || isShellEdit(canonical, call.input)) {
    state.edits += 1
    state.lastEditCall = index
    if (NEW_FILE_TOOLS.has(canonical)) state.newFiles += 1
  }
  if (READ_TOOLS.has(canonical)) state.reads += 1

  const verifies = isVerification(canonical, call.input)
  const failure = failureOf(canonical, call.result)
  if (verifies) {
    state.verifications += 1
    state.lastVerifyCall = index
    state.editsAtVerify = state.edits
    state.lastVerifyOk = !failure.failed
  }
  if (!failure.failed) return

  state.failures += 1
  const signature = failure.signature ?? "tool failed"
  const previous = state.errorSigs[signature] ?? 0
  state.errorSigs[signature] = previous + 1
  if (previous > 0) {
    state.repeated += 1
    state.repeatedSignature = signature
    state.repeatedLabel = callLabel(canonical, call.input)
  }

  const key = `${canonical}|${fingerprintOf(call.input)}|${signature}`
  const entry = state.repeatKeys[key] ?? { count: 0, signature, label: callLabel(canonical, call.input) }
  entry.count += 1
  entry.signature = signature
  entry.label = callLabel(canonical, call.input)
  state.repeatKeys[key] = entry
}

function bestRepeat(state: LoopGuardState): LoopGuardRepeat | undefined {
  let best: LoopGuardRepeat | undefined
  for (const entry of Object.values(state.repeatKeys)) {
    if (entry.count < 3) continue
    if (best === undefined || entry.count > best.count) best = entry
  }
  return best
}

function safeText(text: string, max: number): string {
  return text.replace(/`/gu, "'").replace(/\s+/gu, " ").trim().slice(0, max)
}

function nudgeText(
  reason: LoopGuardReason,
  state: LoopGuardState,
  envelope: number,
  repeat: LoopGuardRepeat | undefined,
): string {
  const calls = state.calls
  const env = `envelope ${envelope}`
  if (reason === "repeat" && repeat !== undefined) {
    return (
      `process check: \`${safeText(repeat.label, MAX_LOOP_GUARD_LABEL)}\` has repeated the same failure ` +
      `${repeat.count}x (\`${safeText(repeat.signature, MAX_LOOP_GUARD_SIGNATURE)}\`); this turn is at ${calls} calls (${env}). ` +
      "Change the hypothesis or the input before trying again."
    )
  }
  if (reason === "failures") {
    return (
      `process check: ${state.failures} failed calls and no test/build/typecheck in ${calls} calls (${env}). ` +
      "Run a check or change the approach before editing again."
    )
  }
  if (reason === "edits") {
    return (
      `process check: ${state.edits - state.editsAtVerify} edits since the last test/build/typecheck in ${calls} calls (${env}). ` +
      "Verify before editing again."
    )
  }
  const label = safeText(state.repeatedLabel ?? "a repeated call", MAX_LOOP_GUARD_LABEL)
  const signature = safeText(state.repeatedSignature ?? "the same error", MAX_LOOP_GUARD_SIGNATURE)
  return (
    `process check: ${calls} calls is past this turn's ${env} and the same failure is still repeating ` +
    `(\`${label}\`: \`${signature}\`). Change the hypothesis or the input before trying again.`
  )
}

function decide(
  state: LoopGuardState,
  options: LoopGuardOptions,
): { reason: LoopGuardReason; text: string } | undefined {
  const nudges =
    typeof options.nudges === "number" && Number.isFinite(options.nudges)
      ? Math.max(0, Math.floor(options.nudges))
      : 1
  if (nudges <= 0 || loopGuardGreen(state)) return undefined

  const envelope = Math.max(minCallsOf(options), loopGuardEnvelope(state, options))
  const repeat = bestRepeat(state)
  if (repeat !== undefined) {
    return { reason: "repeat", text: nudgeText("repeat", state, envelope, repeat) }
  }

  if (state.calls >= 8 && state.failures >= 5 && state.verifications === 0) {
    return { reason: "failures", text: nudgeText("failures", state, envelope, undefined) }
  }

  const editsSinceVerify = Math.max(0, state.edits - state.editsAtVerify)
  if (editsSinceVerify >= 8) {
    return { reason: "edits", text: nudgeText("edits", state, envelope, undefined) }
  }

  if (options.envelopeEnabled !== false) {
    if (state.calls >= envelope && state.failures > 0 && state.repeated > 0) {
      return { reason: "envelope", text: nudgeText("envelope", state, envelope, undefined) }
    }
  }
  return undefined
}

/**
 * Fold the newest user turn's completed tools into the guard and decide whether
 * this pass should carry a redirect.
 *
 * Pure with respect to messages: the payload's bytes are only read. The state
 * is passed in and returned; the caller stores it on the session record. Two
 * calls with the same state and messages return the same decision, and the
 * stored redirect is re-rendered unchanged for the rest of its turn.
 */
export function updateLoopGuard(
  previous: LoopGuardState | undefined,
  messages: ReadonlyArray<Message>,
  options: LoopGuardOptions = {},
): LoopGuardDecision {
  const state = normalizeLoopGuard(previous) ?? emptyLoopGuard()
  const turn = currentTurn(messages)
  if (turn === undefined) {
    return {
      state,
      redirect: state.redirected ? state.redirectText : undefined,
      reason: state.redirectReason,
    }
  }

  if (state.turn !== turn.id) {
    if (state.turn.length > 0 && state.calls > 0 && loopGuardGreen(state)) {
      state.samples = [...state.samples, state.calls].slice(-MAX_LOOP_GUARD_SAMPLES)
    }
    resetCounters(state)
    state.turn = turn.id
    state.redirected = false
    delete state.redirectReason
    delete state.redirectAt
    delete state.redirectText
  }

  const calls = completedCalls(turn.messages)
  if (state.calls > calls.length) {
    // The host trimmed or rewound this turn. Re-fold from the raw transcript,
    // but keep the delivered redirect: one redirect per turn is the rule, even
    // when the transcript shrank.
    const redirected = state.redirected
    const reason = state.redirectReason
    const redirectAt = state.redirectAt
    const redirectText = state.redirectText
    resetCounters(state)
    state.redirected = redirected
    state.redirectReason = reason
    state.redirectAt = redirectAt
    state.redirectText = redirectText
  }
  for (let index = state.calls; index < calls.length; index += 1) {
    foldCall(state, calls[index], index + 1)
  }
  trimMap(state.errorSigs)
  trimMap(state.repeatKeys)

  if (!state.redirected) {
    const decision = decide(state, options)
    if (decision !== undefined) {
      state.redirected = true
      state.redirectReason = decision.reason
      state.redirectAt = state.calls
      state.redirectText = decision.text
    }
  }

  return {
    state,
    redirect: state.redirected ? state.redirectText : undefined,
    reason: state.redirectReason,
  }
}

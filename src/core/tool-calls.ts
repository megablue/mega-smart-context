/**
 * Completed tool calls, paired with their results.
 *
 * The usage report counts outcomes, not content: a pair carries the tool name,
 * whether the result failed, and the order the result arrived. Arguments, output,
 * paths and commands are deliberately absent, so a project record can never
 * retain them.
 *
 * The loop guard has its own private pairing for normalized call fingerprints;
 * this module is the read-only, report-facing pair. Keeping it separate means the
 * guard can evolve its fingerprint without changing what the report counts.
 */

import type { Message, ToolCallPart, ToolResultPart } from "./types.ts"

/** One call that completed: a call and its matching result. */
export interface ToolCallPair {
  /** The host's call id; the same id on the call and the result. */
  readonly id: string
  /** The result's name when it carries one, otherwise the call's name. */
  readonly name: string
  /** False when the result reports an error, a failure or a non-zero exit. */
  readonly ok: boolean
  /** Zero-based order in which the result arrived; calls without a result are absent. */
  readonly order: number
}

export interface PairToolCallsOptions {
  /** Ignore messages after this index (inclusive). Defaults to the whole list. */
  readonly throughIndex?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The result part and the value shapes a host may put its status fields in. */
function statusSources(part: ToolResultPart): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [part as unknown as Record<string, unknown>]
  if (isObject(part.result)) {
    sources.push(part.result as unknown as Record<string, unknown>)
    if (isObject(part.result.value)) sources.push(part.result.value)
  }
  const loose = part as unknown as Record<string, unknown>
  if (isObject(loose.value)) sources.push(loose.value)
  return sources
}

function nonZero(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value !== 0
  if (typeof value === "string") {
    const text = value.trim()
    if (!/^-?\d+$/u.test(text)) return false
    return Number(text) !== 0
  }
  return false
}

/** `code` also carries symbolic errors such as `ENOENT`; a non-empty non-success string is a failure. */
function failedCode(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value !== 0
  if (typeof value === "string") {
    const text = value.trim()
    if (/^-?\d+$/u.test(text)) return Number(text) !== 0
    return text.length > 0 && !/^(?:0|ok|success|successful)$/iu.test(text)
  }
  return false
}

/**
 * Failure detection is explicit and conservative: only fields a host uses to
 * report an error count. A missing status is a success, because a tool that ran
 * and returned text did not fail merely by returning text.
 */
export function isFailedToolResult(part: ToolResultPart): boolean {
  for (const source of statusSources(part)) {
    if (source.isError === true || source.is_error === true) return true
    if (source.error !== undefined && source.error !== null && source.error !== false && source.error !== "") {
      return true
    }
    if (source.success === false) return true
    // A wire shape whose whole value is an error.
    if (source.type === "error") return true
    if (nonZero(source.exitCode) || nonZero(source.exit_code) || failedCode(source.code)) return true
    const status = source.status
    if (typeof status === "string" && /^(?:error|failed|failure)$/iu.test(status.trim())) return true
    if (typeof status === "number" && Number.isFinite(status) && status !== 0) return true
  }
  return false
}

/**
 * Pair completed calls with their results by id, in result order.
 *
 * A call with no result is ignored: the turn is still running, or the host
 * dropped it, and counting it would invent an outcome. A duplicate result is
 * ignored because the first one already consumed the call. A result with no
 * matching call is ignored for the same reason.
 */
export function pairToolCalls(
  messages: ReadonlyArray<Message>,
  options: PairToolCallsOptions = {},
): ToolCallPair[] {
  const limit = options.throughIndex === undefined
    ? messages.length - 1
    : Math.min(options.throughIndex, messages.length - 1)
  const calls = new Map<string, string>()
  const pairs: ToolCallPair[] = []

  for (let index = 0; index <= limit; index += 1) {
    const message = messages[index]
    for (const part of message.content ?? []) {
      if (part.type !== "tool-call") continue
      const call = part as ToolCallPart
      if (typeof call.id !== "string" || call.id.length === 0) continue
      if (calls.has(call.id)) continue
      calls.set(call.id, typeof call.name === "string" ? call.name : "")
    }
    for (const part of message.content ?? []) {
      if (part.type !== "tool-result") continue
      const result = part as ToolResultPart
      if (typeof result.id !== "string") continue
      const callName = calls.get(result.id)
      if (callName === undefined) continue
      calls.delete(result.id)
      const resultName = typeof result.name === "string" && result.name.length > 0 ? result.name : callName
      pairs.push({
        id: result.id,
        name: resultName,
        ok: !isFailedToolResult(result),
        order: pairs.length,
      })
    }
  }

  return pairs
}

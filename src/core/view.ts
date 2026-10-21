/**
 * A read-only view of the outbound payload, and the mechanical decisions taken
 * over it: where a turn starts, which turns fit the working budget, and how a
 * result too large to replay is shortened.
 *
 * A *turn* is a real user message and everything after it up to the next real
 * user message. Cutting at a turn start is always safe: a tool call and its
 * result live inside one turn, so a boundary between turns cannot split them.
 * `balanceCuts` still exists as the assertion that this is true, and as the
 * guard for a host that hands over a payload whose turn shape is unusual.
 *
 * The plugin numbers turns itself. The host's payload carries no turn field, and
 * the durable transcript may be trimmed by compaction, so the id is the user
 * message id (stable) rather than the index (which moves).
 *
 * Byte stability: nothing here may depend on a newer turn, or a provider prefix
 * cache above the change goes cold. `erodeToolResults` is a pure function of one
 * message's own bytes, and reasoning is passed through exactly as the host sent
 * it, so once a message is in the window its bytes never change.
 *
 * @module mega-smart-context/view
 */

import { estimateTokens, formatTokens, messageChars } from "./measure.ts"
import type { ContentPart, Message, ToolCallPart, ToolResultPart } from "./types.ts"

/** Every message this plugin mints carries this prefix on its id. */
export const INJECTED_PREFIX = "megasc_"

/** The one message that carries the memory document. */
export const MEMORY_MESSAGE_ID = INJECTED_PREFIX + "memory"

export function isInjected(message: Message | undefined): boolean {
  return typeof message?.id === "string" && message.id.startsWith(INJECTED_PREFIX)
}

export function isMemoryMessage(message: Message | undefined): boolean {
  return message?.id === MEMORY_MESSAGE_ID
}

/** Which kind of message the host injected as a *user* turn. */
export type HostMessageKind = "notice" | "job" | "cue"

/** A message the host injected as a user turn: a standing notice, a job's completion, or a resume cue. */
export interface HostMessage {
  readonly kind: HostMessageKind
  readonly id: string
  readonly text: string
}

/** How the host opens the nudge it appends when a response is cut off at the output-token limit. */
const OUTPUT_LIMIT_PREFIX = "Your last response hit the output token limit"

/**
 * The host's one fixed sentence after a response was interrupted, asking the model to resume.
 *
 * Matched whole: all 23 live rows are byte-identical. A reworded variant falls
 * back to being a turn, which is the old behaviour rather than a new mistake.
 */
const INTERRUPTED_TEXT =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

/**
 * Classify a host-injected user message; `undefined` for a message a person wrote.
 *
 * The host admits four things as a *user* message that no one typed: a Plan/Build
 * mode notice (a `<system-reminder>` block, sometimes with a trailing `@n@`
 * marker), the output-token-limit nudge, a background job's completion (a
 * `<shell>` or `<subagent>` block), and the "previous response was interrupted"
 * resume cue. All four are one text part under an unprefixed id, so the shape is
 * the only tell.
 *
 * - A *notice* is a standing instruction. Left in place it starts a turn: it
 *   inflates the working window and ages a pending turn on a mode switch the
 *   model never made. It is stripped from the window and pinned instead.
 * - A *job* is the tail of the turn that started it. It stays in the window but
 *   starts no turn, so it annexes to the newest span rather than ageing a pending
 *   eviction on work the model already asked for.
 * - A *cue* is the same shape of tail, but not a job's result: one transient
 *   sentence that must reach the model once. It stays in the window and starts no
 *   turn, and it is never pinned - replaying "continue from where you left off"
 *   on every later pass would be a stale instruction, and pinning it would hand
 *   the newest-refusal rail to a nudge instead of the live mode notice.
 */
export function hostMessageOf(message: Message | undefined): HostMessage | undefined {
  if (message?.role !== "user" || isInjected(message)) return undefined
  if (typeof message.id !== "string" || message.id.length === 0) return undefined
  const content = message.content ?? []
  if (content.length !== 1) return undefined
  const part = content[0]
  if (part.type !== "text" || typeof (part as { text?: unknown }).text !== "string") return undefined
  const text = (part as { text: string }).text
    .trim()
    .replace(/\s*@[^@\s]*@\s*$/u, "")
    .trim()
  const id = message.id
  if (/^<system-reminder>[\s\S]*<\/system-reminder>$/u.test(text)) return { kind: "notice", id, text }
  if (text.startsWith(OUTPUT_LIMIT_PREFIX)) return { kind: "notice", id, text }
  if (text === INTERRUPTED_TEXT) return { kind: "cue", id, text }
  if (/^<shell\b[\s\S]*<\/shell>$/u.test(text) || /^<subagent\b[\s\S]*<\/subagent>$/u.test(text)) {
    return { kind: "job", id, text }
  }
  return undefined
}

/** Is this a message the host injected as a user turn, rather than one a person wrote? */
export function isHostMessage(message: Message | undefined): boolean {
  return hostMessageOf(message) !== undefined
}

/** A host job completion: kept in the window, but it starts no turn of its own. */
export function isHostJob(message: Message | undefined): boolean {
  return hostMessageOf(message)?.kind === "job"
}

/** A host resume cue: kept in the window like a job, but it reports no result. */
export function isHostCue(message: Message | undefined): boolean {
  return hostMessageOf(message)?.kind === "cue"
}

/** Is this host message the tail of the turn that started it, rather than a turn of its own? */
export function isHostTail(message: Message | undefined): boolean {
  return isHostJob(message) || isHostCue(message)
}

/**
 * Is this a user message the conversation actually started a turn with?
 *
 * A job completion and a resume cue are excluded: both belong to the turn that
 * was already running. A notice is not excluded here because `splitNotices`
 * removes it before the spans are taken; leaving it a boundary keeps that split
 * the thing that matters.
 */
export function isRealUser(message: Message | undefined): boolean {
  return message?.role === "user" && !isInjected(message) && !isHostTail(message)
}

/** A host notice (a mode reminder, or the output-limit nudge), when this message is one. */
export function noticeOf(message: Message | undefined): { id: string; text: string } | undefined {
  const host = hostMessageOf(message)
  return host?.kind === "notice" ? { id: host.id, text: host.text } : undefined
}

/**
 * Pull the host's notices out of a payload.
 *
 * `rest` is the conversation the window reasons about: no notice, so no phantom
 * turn and no eviction lead burned on a mode switch. `notices` is every notice in
 * transcript order — the mode reminders and the output-token-limit nudge — for the
 * record to pin (deduped by exact text when stored). Job completions and resume
 * cues are not pulled: they stay in the window and are kept out of the turn count
 * instead.
 */
export function splitNotices(messages: ReadonlyArray<Message>): {
  rest: Message[]
  notices: { id: string; text: string }[]
} {
  const rest: Message[] = []
  const notices: { id: string; text: string }[] = []
  for (const message of messages) {
    const notice = noticeOf(message)
    if (notice === undefined) rest.push(message)
    else notices.push(notice)
  }
  return { rest, notices }
}

export function toolCalls(message: Message | undefined): ToolCallPart[] {
  return (message?.content ?? []).filter(
    (part): part is ToolCallPart => part.type === "tool-call" && typeof (part as ToolCallPart).id === "string",
  )
}

export function toolResults(message: Message | undefined): ToolResultPart[] {
  return (message?.content ?? []).filter(
    (part): part is ToolResultPart => part.type === "tool-result" && typeof (part as ToolResultPart).id === "string",
  )
}

/** The text of one message, over its text parts. */
export function textOf(message: Message | undefined): string {
  return (message?.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof (part as any).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/** The text a tool result carries, whether the host handed a string or a value. */
export function valueText(part: ToolResultPart): string {
  const value = part.result?.value
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** One turn's shape, for the budget walk and the eviction preview. */
export interface TurnSpan {
  readonly id: string
  readonly turn: number
  readonly startIdx: number
  readonly endIdx: number
  readonly userText: string
  readonly tools: ReadonlyArray<string>
  readonly chars: number
}

/** Group the payload into turns. Messages before the first user are not a turn. */
export function turnSpans(messages: ReadonlyArray<Message>): TurnSpan[] {
  const spans: TurnSpan[] = []
  let current: { id: string; turn: number; startIdx: number; userText: string; tools: string[]; chars: number } | null = null

  const close = (endIdx: number): void => {
    if (current === null) return
    spans.push({ ...current, endIdx, tools: [...current.tools] })
    current = null
  }

  messages.forEach((message, index) => {
    if (isRealUser(message)) {
      close(index - 1)
      const id = typeof message.id === "string" && message.id.length > 0 ? message.id : `t${index}`
      current = {
        id,
        turn: spans.length + 1,
        startIdx: index,
        userText: textOf(message),
        tools: [],
        chars: 0,
      }
    }
    if (current === null) return
    current.chars += messageChars(message)
    for (const call of toolCalls(message)) current.tools.push(call.name)
  })
  close(messages.length - 1)

  return spans
}

/**
 * Walk back from the newest turn until the working budget is spent.
 *
 * The current turn is always kept, even when it alone exceeds the budget: a
 * request without the tool results the model just asked for is a broken turn,
 * not a smaller one. The overrun is reported so the policy can tell the model to
 * fold sooner.
 */
export interface WorkingWindow {
  readonly startIdx: number
  readonly turns: ReadonlyArray<TurnSpan>
  readonly dropped: ReadonlyArray<TurnSpan>
  readonly chars: number
  readonly overBudget: boolean
}

export function selectWorkingWindow(
  messages: ReadonlyArray<Message>,
  options: { workingTokens: number; charsPerToken: number },
): WorkingWindow {
  const spans = turnSpans(messages)
  if (spans.length === 0) {
    return { startIdx: 0, turns: [], dropped: [], chars: 0, overBudget: false }
  }

  const budgetChars = Math.max(0, options.workingTokens) * Math.max(1, options.charsPerToken)
  let firstKept = spans.length - 1
  let chars = spans[firstKept].chars

  for (let index = spans.length - 2; index >= 0; index -= 1) {
    if (chars + spans[index].chars > budgetChars) break
    chars += spans[index].chars
    firstKept = index
  }

  let startIdx = spans[firstKept].startIdx
  // The turn boundary is safe by construction. The fold is kept as a guard for a
  // host that starts a request mid-turn: moving the cut later keeps more, never less.
  const { cuts } = balanceCuts(messages)
  while (startIdx < messages.length && cuts[startIdx] !== true) startIdx += 1

  return {
    startIdx,
    turns: spans.slice(firstKept),
    dropped: spans.slice(0, firstKept),
    chars,
    overBudget: chars > budgetChars,
  }
}

/**
 * Fold the tool-call/result balance over the payload.
 *
 * `cuts[i]` is true when a cut before message `i` splits no call. A result with
 * no call is a corrupt payload, and every later rule would be reasoning about a
 * conversation that never happened, so it throws.
 */
export function balanceCuts(messages: ReadonlyArray<Message>): { cuts: boolean[]; inFlight: number[] } {
  const cuts = [true]
  const inFlight = [0]
  let open = 0
  messages.forEach((message, index) => {
    open += toolCalls(message).length
    open -= toolResults(message).length
    if (open < 0) {
      throw new Error(`view: a tool result at message ${index} (${message.id ?? "no id"}) has no matching tool call`)
    }
    cuts.push(open === 0)
    inFlight.push(open)
  })
  return { cuts, inFlight }
}

/**
 * Shorten tool results over `maxChars`, keeping a head and a tail.
 *
 * The pair is never broken: the result keeps its id and its place. Only the
 * value is cut, with a marker that says how much is missing, so the model knows
 * the difference between a short result and a shortened one.
 *
 * A result has one of three shapes and erosion keeps each: `text` holds a
 * string, `content` holds an array of parts, `json` holds a structured value.
 * `content` is the shape that bites — the host maps over that array when it
 * prepares the request, so replacing it with a string aborts the whole session.
 * There, only the text parts shrink; the array itself survives. `json` is left
 * alone for the same reason: there is no text to cut without changing its type.
 */
export function erodeToolResults(
  messages: ReadonlyArray<Message>,
  maxChars: number,
): { messages: Message[]; eroded: number } {
  let eroded = 0
  const limit = Math.max(200, maxChars)

  const cut = (text: string): string => {
    const marker = `\n… [${text.length - limit} chars truncated] …\n`
    const head = Math.max(0, Math.floor((limit - marker.length) * 0.6))
    const tail = Math.max(0, limit - marker.length - head)
    return text.slice(0, head) + marker + text.slice(text.length - tail)
  }

  const out = messages.map((message) => {
    const results = toolResults(message)
    if (results.length === 0) return message
    const content = (message.content ?? []).map((part) => {
      if (part.type !== "tool-result") return part
      const result = part as ToolResultPart
      const value = result.result?.value

      if (result.result?.type === "content" && Array.isArray(value)) {
        const parts = value as ReadonlyArray<any>
        let chars = 0
        for (const item of parts) if (typeof item?.text === "string") chars += item.text.length
        if (chars <= limit) return part
        const firstText = parts.findIndex((item) => typeof item?.text === "string")
        if (firstText === -1) return part
        const joined = parts
          .filter((item) => typeof item?.text === "string")
          .map((item) => item.text)
          .join("\n")
        const next: any[] = []
        parts.forEach((item, index) => {
          if (typeof item?.text !== "string") next.push(item)
          else if (index === firstText) next.push({ ...item, text: cut(joined) })
        })
        eroded += 1
        return { ...result, result: { ...result.result, value: next } } as ContentPart
      }

      // A `content` result that already lost its array is repaired rather than
      // passed on, so one bad turn does not poison every later request.
      if (result.result?.type === "content") {
        const text = valueText(result)
        if (text.length <= limit) return part
        eroded += 1
        return { ...result, result: { ...result.result, value: [{ type: "text", text: cut(text) }] } } as ContentPart
      }

      if (typeof value !== "string") return part
      if (value.length <= limit) return part
      eroded += 1
      return { ...result, result: { ...result.result, value: cut(value) } } as ContentPart
    })
    return { ...message, content }
  })
  return { messages: out, eroded }
}

/** A one-line, mechanical preview of a turn for the pending-eviction notice. */
export function previewOf(span: TurnSpan, charsPerToken: number): string {
  const user = span.userText.replace(/\s+/g, " ").trim().slice(0, 90) || "(no text)"
  const tools = span.tools.length > 0 ? [...new Set(span.tools)].join(", ") : "no tools"
  const tokens = formatTokens(estimateTokens(span.chars, charsPerToken))
  return `user: ${JSON.stringify(user)} · tools: ${tools} · ~${tokens} est`
}

/** One rendered part: its text, and where that text starts in the full render. */
interface RenderLine {
  readonly offset: number
  readonly text: string
}

/**
 * One line per content part, in order, with the offset each line starts at.
 *
 * A part is exactly one line, so a line boundary is a safe cut: text, a tool
 * call and a tool result are never split, and an offset reported by a page or a
 * snippet points at the same character `expand offset:` will resume from.
 */
function renderLines(messages: ReadonlyArray<Message>): RenderLine[] {
  const lines: RenderLine[] = []
  let offset = 0
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === "reasoning") continue
      let text: string
      if (part.type === "text") {
        text = `[${message.role}] ${(part as any).text}`
      } else if (part.type === "tool-call") {
        const call = part as ToolCallPart
        text = `[tool-call ${call.name}] ${JSON.stringify(call.input)}`
      } else if (part.type === "tool-result") {
        const result = part as ToolResultPart
        text = `[tool-result ${result.name}] ${valueText(result)}`
      } else {
        continue
      }
      lines.push({ offset, text })
      offset += text.length + 1
    }
  }
  return lines
}

/** The whole turn as text, nothing elided. */
export function renderTurnFull(messages: ReadonlyArray<Message>): string {
  return renderLines(messages)
    .map((line) => line.text)
    .join("\n")
}

/** Render archived messages back to text, shortened to `maxChars` at a part boundary. */
export function renderTurn(messages: ReadonlyArray<Message>, maxChars = 20_000): string {
  const lines = renderLines(messages)
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    if (used >= maxChars) {
      out.push(`[… ${maxChars} chars shown …]`)
      return out.join("\n")
    }
    out.push(line.text)
    used += line.text.length + 1
  }
  return out.join("\n")
}

/** Room a page footer needs; the body is cut short by this so the whole result fits. */
const FOOTER_RESERVE = 140

/** The page size `expand` assumes when nothing says otherwise. */
export const DEFAULT_EXPAND_BUDGET = 4_000

/** One page of a turn, with the honest totals the reader needs to continue. */
export interface TurnPage {
  /** Body and footer together; at most the requested budget. */
  readonly text: string
  /** Offset of the first character shown. */
  readonly from: number
  /** Offset just past the last character shown. */
  readonly to: number
  /** The full turn's length, which the footer reports rather than the page's. */
  readonly total: number
  /** True when this page reaches the end of the turn. */
  readonly done: boolean
}

/**
 * Page the full render of a turn.
 *
 * `expand` used to hand back the first 20,000 characters and claim that was the
 * turn, which told a reader to summarize a prefix as if it were the whole thing.
 * A page instead reports `from`/`to`/`total` and how to continue, so nothing is
 * unreachable and no length is ever misreported.
 *
 * The result is sized to `budget` because the caller's own pass erodes a tool
 * result over `maxResultChars`: a page larger than that would be cut again, in
 * the middle, by `erodeToolResults`.
 *
 * A page starts exactly at `offset` (so continuing is seamless and the footer's
 * `from` is the truth) and ends on a line boundary when the page holds one, so
 * whole parts stay whole. A single part longer than a page is cut at the page
 * edge; its remainder is one `offset:to` away, so nothing is unreachable.
 */
export function turnPage(
  messages: ReadonlyArray<Message>,
  options: { offset?: number; limit?: number; budget?: number } = {},
): TurnPage {
  const full = renderTurnFull(messages)
  const total = full.length
  const budget = Math.max(400, Math.trunc(options.budget ?? DEFAULT_EXPAND_BUDGET))

  let from = Math.trunc(options.offset ?? 0)
  if (from < 0) from = Math.max(0, total + from)
  from = Math.min(Math.max(0, from), total)

  const requested = Math.max(200, Math.min(20_000, Math.trunc(options.limit ?? budget)))
  const room = Math.max(200, Math.min(requested, budget) - FOOTER_RESERVE)
  let to = Math.min(total, from + room)
  if (to < total) {
    const newline = full.lastIndexOf("\n", to)
    if (newline > from) to = newline
  }

  const done = to >= total
  const body = full.slice(from, to)
  const footer =
    (body.length > 0 ? "\n" : "") +
    (done
      ? `(chars ${from}–${to} of ${total}; end of turn)`
      : `(chars ${from}–${to} of ${total}; continue with offset:${to})`)
  return { text: body + footer, from, to, total, done }
}

/** One line per part: where it sits, what it is, and how long it runs. */
export function turnOutline(
  messages: ReadonlyArray<Message>,
  options: { headChars?: number; budget?: number } = {},
): string {
  const lines = renderLines(messages)
  const headChars = Math.max(40, Math.trunc(options.headChars ?? 120))
  const budget = Math.max(400, Math.trunc(options.budget ?? DEFAULT_EXPAND_BUDGET))
  const last = lines.length === 0 ? undefined : lines[lines.length - 1]
  const total = last === undefined ? 0 : last.offset + last.text.length

  const rows = lines.map((line) => {
    const match = /^\[([^\]]*)\] ([\s\S]*)$/.exec(line.text)
    const label = match?.[1] ?? "part"
    const body = match?.[2] ?? line.text
    const flat = body.replace(/\s+/g, " ").trim()
    const head = flat.slice(0, headChars).trimEnd()
    const rest = Math.max(0, flat.length - Math.min(flat.length, headChars))
    return `@${line.offset} [${label}] ${head}${rest > 0 ? ` [+${rest} chars]` : ""}`
  })

  const room = Math.max(200, budget - 200)
  const out: string[] = []
  let used = 0
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (used + row.length + 1 > room) {
      out.push(`[… ${rows.length - index} more parts, first at offset:${lines[index].offset}]`)
      break
    }
    out.push(row)
    used += row.length + 1
  }
  out.push(`(outline: ${lines.length} parts, ${total} chars; read one with offset:<n>)`)
  return out.join("\n")
}

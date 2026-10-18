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

/** Is this a user message the conversation actually started a turn with? */
export function isRealUser(message: Message | undefined): boolean {
  return message?.role === "user" && !isInjected(message)
}

/**
 * A host mode notice, when this message is one.
 *
 * The host admits a Plan/Build switch as a synthetic *user* message whose whole
 * text is a `<system-reminder>` block (some carry a trailing `@n@` marker). Left
 * in place it starts a turn: it inflates the working window and ages a pending
 * turn on a mode switch the model never made. Recognised here, it is stripped
 * from the window and pinned into the system prompt instead.
 */
export function noticeOf(message: Message | undefined): { id: string; text: string } | undefined {
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
  if (!/^<system-reminder>[\s\S]*<\/system-reminder>$/u.test(text)) return undefined
  return { id: message.id, text }
}

/**
 * Pull the host's mode notices out of a payload.
 *
 * `rest` is the conversation the window reasons about: no notice, so no phantom
 * turn and no eviction lead burned on a mode switch. `notices` is every notice in
 * transcript order, for the record to pin (deduped by exact text when stored).
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

/**
 * Drop reasoning from completed turns.
 *
 * The model's conclusions are in memory; replaying its private reasoning costs
 * tokens and adds nothing it cannot re-derive. The current turn keeps its
 * reasoning because the tool call that follows may depend on it.
 */
export function stripReasoning(messages: ReadonlyArray<Message>, keepFromIdx: number): Message[] {
  return messages.map((message, index) => {
    if (index >= keepFromIdx) return message
    if (!(message.content ?? []).some((part) => part.type === "reasoning")) return message
    return { ...message, content: (message.content ?? []).filter((part) => part.type !== "reasoning") }
  })
}

/** A one-line, mechanical preview of a turn for the pending-eviction notice. */
export function previewOf(span: TurnSpan, charsPerToken: number): string {
  const user = span.userText.replace(/\s+/g, " ").trim().slice(0, 90) || "(no text)"
  const tools = span.tools.length > 0 ? [...new Set(span.tools)].join(", ") : "no tools"
  const tokens = formatTokens(estimateTokens(span.chars, charsPerToken))
  return `user: ${JSON.stringify(user)} · tools: ${tools} · ~${tokens} est`
}

/** Render archived messages back to text, for `expand`. */
export function renderTurn(messages: ReadonlyArray<Message>, maxChars = 20_000): string {
  const lines: string[] = []
  let used = 0
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === "reasoning") continue
      if (part.type === "text") {
        const line = `[${message.role}] ${(part as any).text}`
        lines.push(line)
        used += line.length
      } else if (part.type === "tool-call") {
        const call = part as ToolCallPart
        const line = `[tool-call ${call.name}] ${JSON.stringify(call.input)}`
        lines.push(line)
        used += line.length
      } else if (part.type === "tool-result") {
        const result = part as ToolResultPart
        const line = `[tool-result ${result.name}] ${valueText(result)}`
        lines.push(line)
        used += line.length
      }
      if (used >= maxChars) {
        lines.push(`[… ${maxChars} chars shown …]`)
        return lines.join("\n")
      }
    }
  }
  return lines.join("\n")
}

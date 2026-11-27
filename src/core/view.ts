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
 * it, so once a message is in the window its bytes never change - except the
 * opt-in rebuild of a completed turn at a fold (`rebuildTurn`), which stores the
 * turn ids and re-derives the same bytes on every later pass.
 *
 * @module mega-smart-context/view
 */

import { estimateTokens, formatTokens, messageChars } from "./measure.ts"
import { rawId, type RawDraft } from "./raw.ts"
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
 * The sentence `/context resume` sends through the host's synthetic channel.
 *
 * It is the plugin's own copy of the host's interruption cue, and it rides the
 * same tail path: `/context resume` admits a synthetic row, so there is no user
 * message and no new turn (and no pending eviction aged). The bracket marker is
 * deliberately not a `megasc_` id: `context.ts` filters every injected id out of
 * the window, so the cue must arrive under the host's ordinary `msg_` id and be
 * recognised by its text.
 *
 * Matched whole, like `INTERRUPTED_TEXT`. The marker makes an accidental human
 * collision unlikely; a person writing the sentence without it stays a turn.
 */
export const RESUMED_TEXT =
  "[mega-smart-context] Continue from where you left off without repeating completed content."

/**
 * Classify a host-injected message; `undefined` for a message a person wrote.
 *
 * The host admits four kinds of message as a *user* message that no one typed: a
 * Plan/Build mode notice (a `<system-reminder>` block, sometimes with a trailing
 * `@n@` marker), the output-token-limit nudge, a background job's completion (a
 * `<shell>` or `<subagent>` block), and a resume cue - either the host's
 * "previous response was interrupted" sentence or this plugin's `RESUMED_TEXT`,
 * which reaches the transform through the same synthetic channel and has the
 * same shape. All of them are one text part under an unprefixed id, so the shape
 * is the only tell.
 *
 * A mode switch now also arrives as a `system`-role instruction (an instruction
 * update, `metadata.notice: "instructions"`), so the mode is classified by its
 * text on either role. Only the mode sentence qualifies; every other system
 * message is left where it is.
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
  if (message === undefined || isInjected(message)) return undefined
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
  if (message.role === "system") {
    // The host sends the switch as an instruction update on the system role,
    // not as a `<system-reminder>` user message. Pinning it is what keeps the
    // live mode on the record once the turn that carried it leaves the window;
    // only the mode sentence qualifies, so the host's other system messages are
    // left alone.
    return modeReminderOf(text) === undefined ? undefined : { kind: "notice", id, text }
  }
  if (message.role !== "user") return undefined
  if (/^<system-reminder>[\s\S]*<\/system-reminder>$/u.test(text)) return { kind: "notice", id, text }
  // The host repaints an instruction update into the conversation as a
  // `<system-update>` block, and the switch reaches the model through that
  // wrapper. It counts only when the block announces a mode.
  if (/^<system-update>[\s\S]*<\/system-update>$/u.test(text) && modeReminderOf(text) !== undefined) {
    return { kind: "notice", id, text }
  }
  if (text.startsWith(OUTPUT_LIMIT_PREFIX)) return { kind: "notice", id, text }
  if (text === INTERRUPTED_TEXT || text === RESUMED_TEXT) return { kind: "cue", id, text }
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

/** A resume cue: the host's interruption sentence or this plugin's `/context resume` sentence. */
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

/** Which mode a host reminder announces. The two are mutually exclusive. */
export type ModeReminder = "plan" | "build"

/** The sentence that identifies each mode reminder. Both are re-emitted verbatim. */
const PLAN_MODE_CLAUSE = "You are in Plan mode"
const BUILD_MODE_CLAUSE = "You are NO LONGER in Plan mode"
/** The system-role build instruction opens with this sentence instead. */
const BUILD_AGENT_CLAUSE = "You are no longer the Plan agent"
/** The system-role instructions continue past the first sentence; prose alone does not. */
const PLAN_INSTRUCTION_LEAD = "You are in Plan mode. "
const BUILD_INSTRUCTION_LEAD = "You are no longer the Plan agent, so you are NO LONGER in Plan mode. "

/**
 * Which mode a reminder announces, if it is one.
 *
 * These are the only two notices that contradict each other: the Build text says
 * the Plan restrictions no longer apply, so a record that pins every distinct
 * text holds a stale imperative under the live one — in a real session the Plan
 * block (468 B of "do not implement, tell the user to switch agents") outlived
 * the Build switch and read as the instruction. `state.ts` retires the older
 * one.
 *
 * Three shapes are recognised: the `<system-reminder>` block, matched as a
 * substring because the raw text starts with the tag and a newline; the
 * `<system-update>` wrapper the host repaints an instruction update into; and
 * the bare system-role instruction, which must open with its own full sentence
 * and continue past it. Gating on the shape is what keeps prose that merely
 * talks about Plan mode (a nudge, a human question) from classifying.
 */
export function modeReminderOf(text: string): ModeReminder | undefined {
  if (text.startsWith("<system-reminder>")) {
    if (text.includes(BUILD_MODE_CLAUSE)) return "build"
    if (text.includes(PLAN_MODE_CLAUSE)) return "plan"
    return undefined
  }
  const update = /^<system-update>([\s\S]*)<\/system-update>$/u.exec(text)
  if (update !== null && update[1] !== undefined) return modeReminderOf(update[1].trim())
  if (text.startsWith(BUILD_INSTRUCTION_LEAD) || text.startsWith(BUILD_MODE_CLAUSE + ". ")) return "build"
  if (text.startsWith(PLAN_INSTRUCTION_LEAD)) return "plan"
  return undefined
}

/** The agent's name, whether the host hands a string or an agent object. */
export function agentNameOf(agent: unknown): string | undefined {
  if (typeof agent === "string" && agent.length > 0) return agent
  if (typeof agent !== "object" || agent === null) return undefined
  const value = agent as Record<string, unknown>
  for (const key of ["name", "id", "agent"]) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * The mode a host agent names, when its name is one of the two.
 *
 * The request's agent is the authority on the mode: it arrives on every pass, so
 * a switch takes effect even when the host's instruction message never reaches
 * `event.messages` and can never age out of the window.
 */
export function modeOfAgent(agent: unknown): ModeReminder | undefined {
  const name = agentNameOf(agent)
  if (name === "plan") return "plan"
  if (name === "build") return "build"
  return undefined
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

/** Tools whose successful text result becomes a short confirmation. */
const WRITE_TOOLS = new Set(["write", "edit", "create", "patch"])

/** Tools whose successful text output keeps only its tail. */
const SHELL_TOOLS = new Set(["bash", "shell"])

/** A word that marks an error or a refusal; those results are kept verbatim. */
const ERROR_TEXT = /\b(error|failed|failure|exception|denied|cannot|not found)\b/i

export interface RebuiltTurn {
  readonly messages: Message[]
  readonly charsSaved: number
}

/** A call's file argument, under any of the host's key spellings. */
function pathEntryOf(input: any): { key: string; value: string } | undefined {
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof input?.[key] === "string") return { key, value: input[key] }
  }
  return undefined
}

/**
 * Rewrite a grep result to the files and line numbers it matched.
 *
 * A grep result repeats each matched line's text, which a `read` shows in full
 * and the same query can produce again. The durable fact is where the matches
 * are, so each block becomes `path: 5, 22, 40`. Returns undefined when the
 * result has no `Line N:` previews (a summary, a refusal), so those keep their
 * bytes.
 */
function compactGrep(text: string): string | undefined {
  const lines = text.split("\n")
  if (!lines.some((line) => /^\s*Line \d+:/.test(line))) return undefined
  const out: string[] = []
  let header: string | undefined
  let numbers: string[] = []
  const flush = () => {
    if (header === undefined) return
    out.push(numbers.length === 0 ? header : `${header} ${numbers.join(", ")}`)
    numbers = []
  }
  for (const line of lines) {
    const match = /^\s*Line (\d+):/.exec(line)
    if (match !== null) {
      numbers.push(match[1])
      continue
    }
    if (/:\s*$/.test(line)) {
      flush()
      header = line
      continue
    }
    flush()
    header = undefined
    out.push(line)
  }
  flush()
  return out.join("\n")
}

export interface RebuildOptions {
  /** Read call ids a later read of the same path replaced, and that path. */
  readonly supersededReads?: ReadonlyMap<string, string>
}

/**
 * Read calls whose bytes a later read of the same path makes redundant.
 *
 * `turns` is the completed part of the window, in order, and the current turn
 * is excluded: its newest result is what the model is waiting for, and counting
 * its reads would rewrite an earlier turn's bytes mid-turn.
 *
 * A later read replaces an earlier one when it covers the same lines (the same
 * `offset` and `limit`) or reads the whole file (neither given). A write or
 * edit to the path in between clears the chain: the earlier copy is then
 * history, not a duplicate, and stays verbatim. The map holds the replaced call
 * id and the path, so the rebuild can leave a one-line marker and keep the
 * call/result pair whole.
 */
export function supersededReads(turns: ReadonlyArray<ReadonlyArray<Message>>): Map<string, string> {
  const pending = new Map<string, { id: string; offset: unknown; limit: unknown }[]>()
  const out = new Map<string, string>()
  for (const turn of turns) {
    for (const message of turn) {
      for (const part of message.content ?? []) {
        if (part.type !== "tool-call") continue
        const call = part as ToolCallPart
        const path = pathEntryOf(call.input)
        if (path === undefined) continue
        const key = path.value.toLowerCase()
        if (WRITE_TOOLS.has(call.name)) {
          pending.delete(key)
          continue
        }
        if (call.name !== "read") continue
        const offset = call.input?.offset
        const limit = call.input?.limit
        const full = offset === undefined && limit === undefined
        const kept: { id: string; offset: unknown; limit: unknown }[] = []
        for (const read of pending.get(key) ?? []) {
          if (full || (read.offset === offset && read.limit === limit)) out.set(read.id, path.value)
          else kept.push(read)
        }
        kept.push({ id: call.id, offset, limit })
        pending.set(key, kept)
      }
    }
  }
  return out
}

/**
 * Rebuild one completed turn's bytes for the append layout's compaction reset.
 *
 * The cache is already cold at a fold, so rewriting the retained tail is free
 * there - and only there. The rules are conservative: reasoning parts are
 * dropped; a successful write/edit result becomes "<path> ok" and its call
 * keeps only the path (the body is on disk and already confirmed); a long
 * successful bash/shell text keeps its last 20 lines; a grep result keeps the
 * files and line numbers and drops the quoted lines; a read whose path is read
 * again later becomes a one-line marker; any result with an error marker is
 * kept verbatim; content and json results are left alone (their shape is part
 * of the contract); unknown tools are left alone. A call and its result stay
 * paired: nothing is removed.
 */
export function rebuildTurn(messages: ReadonlyArray<Message>, options: RebuildOptions = {}): RebuiltTurn {
  const inputs = new Map<string, any>()
  const results = new Map<string, ToolResultPart>()
  for (const message of messages) {
    for (const call of toolCalls(message)) inputs.set(call.id, call.input)
    for (const result of toolResults(message)) results.set(result.id, result)
  }
  const succeeded = (result: ToolResultPart | undefined): boolean =>
    result !== undefined &&
    result.result?.type === "text" &&
    typeof result.result.value === "string" &&
    !ERROR_TEXT.test(result.result.value)

  const out = messages.map((message) => {
    let touched = false
    const content: ContentPart[] = []
    for (const part of message.content ?? []) {
      if (part.type === "reasoning") {
        touched = true
        continue
      }
      if (part.type === "tool-call") {
        const call = part as ToolCallPart
        const path = pathEntryOf(call.input)
        if (path !== undefined && WRITE_TOOLS.has(call.name) && succeeded(results.get(call.id))) {
          const next = { [path.key]: path.value }
          if (JSON.stringify(next).length < JSON.stringify(call.input ?? {}).length) {
            content.push({ ...call, input: next })
            touched = true
            continue
          }
        }
        content.push(part)
        continue
      }
      if (part.type !== "tool-result") {
        content.push(part)
        continue
      }
      const result = part as ToolResultPart
      const value = result.result?.value
      if (result.result?.type !== "text" || typeof value !== "string" || ERROR_TEXT.test(value)) {
        content.push(part)
        continue
      }
      const name = result.name ?? ""
      if (name === "read") {
        const path = options.supersededReads?.get(result.id)
        if (path !== undefined) {
          const next = `[superseded by a later read of ${path}]`
          if (next.length < value.length) {
            content.push({ ...result, result: { ...result.result, value: next } })
            touched = true
            continue
          }
        }
      }
      if (WRITE_TOOLS.has(name)) {
        const path = pathEntryOf(inputs.get(result.id))
        const next = path === undefined ? `[${name} ok]` : `${path.value} ok`
        if (next.length < value.length) {
          content.push({ ...result, result: { ...result.result, value: next } })
          touched = true
          continue
        }
      }
      if (SHELL_TOOLS.has(name)) {
        const lines = value.split("\n")
        if (lines.length > 20) {
          const next = `… [${lines.length - 20} lines dropped]\n` + lines.slice(-20).join("\n")
          if (next.length < value.length) {
            content.push({ ...result, result: { ...result.result, value: next } })
            touched = true
            continue
          }
        }
      }
      if (name === "grep") {
        const next = compactGrep(value)
        if (next !== undefined && next.length < value.length) {
          content.push({ ...result, result: { ...result.result, value: next } })
          touched = true
          continue
        }
      }
      content.push(part)
    }
    if (!touched || content.length === 0) return message
    return { ...message, content }
  })

  const before = messages.reduce((sum, message) => sum + messageChars(message), 0)
  const after = out.reduce((sum, message) => sum + messageChars(message), 0)
  return { messages: out, charsSaved: Math.max(0, before - after) }
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
 * The append-only window: every turn from `windowStart` to the newest one.
 *
 * There is no per-turn drop here. The era grows until compaction, which is what
 * lets a turn's update block stay beside the turn that wrote it. `undefined`
 * means the marker is absent or the host trimmed it away; the caller then falls
 * back to the ordinary window and seeds a new marker, so a host compaction
 * cannot replay a history the plugin no longer has.
 */
export interface AppendWindow {
  readonly startIdx: number
  readonly turns: ReadonlyArray<TurnSpan>
  readonly dropped: ReadonlyArray<TurnSpan>
  readonly chars: number
}

export function selectAppendWindow(
  messages: ReadonlyArray<Message>,
  windowStart: string | undefined,
): AppendWindow | undefined {
  const spans = turnSpans(messages)
  if (spans.length === 0) return { startIdx: 0, turns: [], dropped: [], chars: 0 }
  if (windowStart === undefined) return undefined
  const index = spans.findIndex((span) => span.id === windowStart)
  if (index < 0) return undefined
  let chars = 0
  for (let position = spans[index].startIdx; position < messages.length; position += 1) {
    chars += messageChars(messages[position])
  }
  return {
    startIdx: spans[index].startIdx,
    turns: spans.slice(index),
    dropped: spans.slice(0, index),
    chars,
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
/**
 * Compact a structured result before the generic head/tail cut.
 *
 * The original is in the raw store, so this pass can be aggressive: keep the
 * shape, the keys and the decisive lines, and leave a marker naming the id.
 * JSON arrays get a sentinel row rather than a broken array; logs keep errors,
 * warnings and the head/tail. Anything unrecognised falls through to the plain
 * cut.
 */
function compactJson(text: string, id: string, limit: number): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(value) || value.length <= 3) return undefined
  const objectRows = value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
  for (const keep of [8, 4, 2, 1]) {
    if (value.length <= keep * 2) continue
    const omitted = value.length - keep * 2
    const sentinel: unknown = objectRows
      ? { _raw: id, _omitted: omitted }
      : `… ${omitted} items omitted; raw: ${id}`
    const out = JSON.stringify([...value.slice(0, keep), sentinel, ...value.slice(-keep)])
    if (out.length <= limit) return out
  }
  return undefined
}

function compactLines(text: string, id: string, limit: number): string | undefined {
  const lines = text.split("\n")
  if (lines.length < 12) return undefined
  const important = lines.filter((line) =>
    /(?:^|\b)(?:error|fatal|panic|exception|traceback|failed|denied|warning|warn)\b/i.test(line),
  )
  if (important.length === 0 || important.length >= lines.length - 6) return undefined
  const head = lines.slice(0, 3)
  const tail = lines.slice(-3)
  const omitted = lines.length - head.length - tail.length
  const marker = `… [${omitted} lines omitted; raw: ${id}]`
  const out = [...head, ...important.slice(0, 40), marker, ...tail].join("\n")
  return out.length <= limit ? out : undefined
}

function compactStructured(text: string, id: string, limit: number): string | undefined {
  const trimmed = text.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const json = compactJson(trimmed, id, limit)
    if (json !== undefined) return json
  }
  return compactLines(text, id, limit)
}

/**
 * A result that is primarily an error is never shortened.
 *
 * A tool that failed is the one result the model must read whole: the exit
 * status, the denial or the first stack frame is the answer. A log that merely
 * contains a fatal line still compacts through `compactLines`, which keeps that
 * line.
 */
function isErrorResult(text: string): boolean {
  return /^(?:error|fatal|panic|exception|traceback|failed|denied|permission denied)\b/i.test(text.trimStart())
}

export interface ErodeOptions {
  /**
   * Leave the newest tool result alone. The current turn's last result is what
   * the model is waiting for; shortening it can destroy the very answer it
   * asked for. Older results in the same turn may still shrink.
   */
  readonly protectNewest?: boolean
  /**
   * Called once for each original shortened. The marker uses its id, so the
   * caller must keep the draft retrievable. Without a sink the marker is the
   * old plain truncation notice and no raw id is promised.
   */
  readonly sink?: (draft: RawDraft) => void
}

export function erodeToolResults(
  messages: ReadonlyArray<Message>,
  maxChars: number,
  options: ErodeOptions = {},
): { messages: Message[]; eroded: number } {
  let eroded = 0
  const limit = Math.max(200, maxChars)

  let newestId: string | undefined
  if (options.protectNewest === true) {
    for (let index = messages.length - 1; index >= 0 && newestId === undefined; index -= 1) {
      const results = toolResults(messages[index])
      if (results.length > 0) newestId = results[results.length - 1].id
    }
  }

  const cut = (text: string, tool: string, raw: string): string => {
    const id = options.sink === undefined ? undefined : rawId(tool, raw)
    if (id !== undefined) options.sink?.({ id, tool, chars: raw.length, text: raw })
    const compacted = id === undefined ? undefined : compactStructured(text, id, limit)
    if (compacted !== undefined && compacted.length <= limit) return compacted
    const source = compacted ?? text
    const omitted = Math.max(0, text.length - limit)
    const marker =
      id === undefined
        ? `\n… [${omitted} chars truncated] …\n`
        : `\n… [${omitted} chars omitted; raw: ${id}] …\n`
    const head = Math.max(0, Math.floor((limit - marker.length) * 0.6))
    const tail = Math.max(0, limit - marker.length - head)
    return source.slice(0, head) + marker + source.slice(source.length - tail)
  }

  const out = messages.map((message) => {
    const results = toolResults(message)
    if (results.length === 0) return message
    const content = (message.content ?? []).map((part) => {
      if (part.type !== "tool-result") return part
      const result = part as ToolResultPart
      if (result.id === newestId) return part
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
        if (isErrorResult(joined)) return part
        const next: any[] = []
        parts.forEach((item, index) => {
          if (typeof item?.text !== "string") next.push(item)
          else if (index === firstText) next.push({ ...item, text: cut(joined, result.name, joined) })
        })
        eroded += 1
        return { ...result, result: { ...result.result, value: next } } as ContentPart
      }

      // A `content` result that already lost its array is repaired rather than
      // passed on, so one bad turn does not poison every later request.
      if (result.result?.type === "content") {
        const text = valueText(result)
        if (isErrorResult(text)) return part
        if (text.length <= limit) return part
        eroded += 1
        return { ...result, result: { ...result.result, value: [{ type: "text", text: cut(text, result.name, text) }] } } as ContentPart
      }

      if (typeof value !== "string") return part
      if (isErrorResult(value)) return part
      if (value.length <= limit) return part
      eroded += 1
      return { ...result, result: { ...result.result, value: cut(value, result.name, value) } } as ContentPart
    })
    return { ...message, content }
  })
  return { messages: out, eroded }
}

/**
 * How much of a turn's own words a mechanical gist keeps: a head for context and
 * a tail for the decisive word.
 *
 * A head-only cut at 90 characters silently dropped the word a spec hung on
 * ("add a new option \"o…"), and a gist is written once, at eviction, so a later
 * reader cannot recover what it dropped. The tail costs 43 characters and is
 * where a name, a path or a verdict usually lands.
 */
export const GIST_HEAD_CHARS = 120
export const GIST_TAIL_CHARS = 40

/** The one-line cut of a user's text that a gist and the eviction preview share. */
export function gistText(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim()
  if (text.length === 0) return "(no text)"
  if (text.length <= GIST_HEAD_CHARS + GIST_TAIL_CHARS) return text
  return `${text.slice(0, GIST_HEAD_CHARS)} … ${text.slice(-GIST_TAIL_CHARS)}`
}

/** A one-line, mechanical preview of a turn for the pending-eviction notice. */
export function previewOf(span: TurnSpan, charsPerToken: number): string {
  const user = gistText(span.userText)
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

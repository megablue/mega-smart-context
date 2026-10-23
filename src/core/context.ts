/**
 * Build the outbound payload from the model-owned memory and the verbatim tail.
 *
 * The durable transcript is read, never written. On every request the host hands
 * over the whole conversation; this pass derives a new payload from it and the
 * session record. Re-running the pass on the same conversation and the same
 * record produces the same bytes, which is what makes the design safe to retry.
 *
 * The order is load-bearing: measure the window that will actually be sent,
 * archive what has left it, render the memory block once, then save. Archiving
 * before rendering means the "Pending eviction" section and the archive count
 * describe the same pass the model is about to see.
 *
 * @module mega-smart-context/context
 */

import { archivePending, knows, mechanicalGist, trimArchive, turnMessages } from "./archive.ts"
import type { ResolvedConfig } from "./config.ts"
import { estimateTokens, memoryChars, messageChars, messagesChars } from "./measure.ts"
import { POLICY, NOTICE_HEADING, renderMemory, renderNotices } from "./prompts.ts"
import { trimHistory, upsertNotices, type SessionStore } from "./state.ts"
import type { Message, PassSample, SessionRecord, SystemPart } from "./types.ts"
import { applyRevert, noteTurn, undoLine } from "./undo.ts"
import {
  MEMORY_MESSAGE_ID,
  erodeToolResults,
  isInjected,
  selectWorkingWindow,
  splitNotices,
  turnSpans,
} from "./view.ts"

export interface ContextInput {
  readonly sessionID: string
  readonly system: ReadonlyArray<SystemPart>
  readonly messages: ReadonlyArray<Message>
  readonly model?: unknown
}

export interface ContextDeps {
  readonly store: SessionStore
  readonly config: ResolvedConfig
  readonly warn?: (line: string) => void
  readonly now?: () => number
}

export interface ContextReport {
  readonly memoryTokens: number
  readonly workingTokens: number
  readonly totalTokens: number
  readonly workingTurns: number
  readonly droppedTurns: number
  readonly overBudget: boolean
  readonly modelContext?: number
  readonly archived: number
  readonly pending: number
  readonly goalEmpty: boolean
}

export interface ContextPlan {
  readonly system: SystemPart[]
  readonly messages: Message[]
  readonly report: ContextReport
}

/** A model window, when the host happens to hand one over. */
function modelContextOf(model: unknown): number | undefined {
  if (typeof model !== "object" || model === null) return undefined
  const value = model as Record<string, any>
  const candidates = [value.limit?.context, value.info?.limit?.context, value.context]
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return candidate
  }
  return undefined
}

function sameTurns(previous: ReadonlyArray<string>, current: ReadonlyArray<string>): boolean {
  if (previous.length !== current.length) return false
  return previous.every((id, index) => id === current[index])
}

export async function buildPayload(input: ContextInput, deps: ContextDeps): Promise<ContextPlan> {
  const config = deps.config
  const now = deps.now ?? (() => Date.now())
  const record: SessionRecord = await deps.store.load(input.sessionID)

  // The host's own instruction set (`core/instructions` and the rest) rides in
  // `event.system` beside the policy this plugin writes. It is measured for
  // display only — no budget counts it — and only when a part is actually there,
  // so a host that does not hand its instructions over shows nothing rather than
  // a zero. The debug line names what was found, which is how the shape of
  // `event.system` is checked after a restart.
  const hostSystem = input.system.filter(
    (part) => typeof part.text === "string" && part.text !== POLICY && !part.text.startsWith(NOTICE_HEADING),
  )
  const hostSystemTokens =
    hostSystem.length === 0
      ? undefined
      : estimateTokens(
          hostSystem.reduce((sum, part) => sum + part.text.length, 0),
          config.charsPerToken,
        )
  if (config.debug && hostSystem.length > 0) {
    deps.warn?.(
      `context ${input.sessionID}: host system ~${hostSystemTokens} est in ${hostSystem.length} part(s): ` +
        hostSystem.map((part) => JSON.stringify(part.text.replace(/\s+/g, " ").slice(0, 40))).join(", "),
    )
  }

  // The host rebuilds from the durable transcript, so an injected message here
  // would only be a stale copy. The mode notices are pulled out of the window and
  // pinned instead: left in place each one starts a turn, which inflates the
  // working window and ages a pending turn on a mode switch the model never made.
  const clean = input.messages.filter((message) => !isInjected(message))
  const split = splitNotices(clean)
  const raw = split.rest
  const spans = turnSpans(raw)
  // A committed host revert lands here, before the window and the change
  // detection run: the record must speak about the transcript the host kept,
  // and the same pass must already see the corrected pending/archive lists.
  // Only the dedicated event sets the marker, so a host compaction (which also
  // shortens the transcript) can never roll the memory back.
  const undo = record.revert === undefined ? undefined : applyRevert(record, record.revert, now())
  const window = selectWorkingWindow(raw, {
    workingTokens: config.workingTokens,
    charsPerToken: config.charsPerToken,
  })

  const workingRaw = raw.slice(window.startIdx)
  // Exactly one rewrite touches a window message: `erodeToolResults`, which is a
  // pure function of that message's own bytes, so the message is identical on
  // every later pass and the prefix above it stays cached. Reasoning is left
  // alone: dropping it from a completed turn would change bytes already sent.
  const working = erodeToolResults(workingRaw, config.maxResultChars).messages

  const currentIds = window.turns.map((span) => span.id)
  if (undo !== undefined) {
    // The undo line is rendered for the turn the rollback landed in; noteTurn
    // clears it once a newer user turn arrives.
    record.lastUndo = { ...undo, seen: currentIds[currentIds.length - 1] }
    if (config.debug) deps.warn?.(`context ${input.sessionID}: ${undoLine(undo)}`)
  }
  // Snapshot pending before this pass can evict, age or auto-archive anything.
  noteTurn(record, currentIds[currentIds.length - 1], now())

  const bootstrap = record.seenTurns.length === 0
  const changed = !bootstrap && !sameTurns(record.seenTurns, currentIds)

  if (bootstrap) {
    // The first pass has nothing to compare against. It must not archive turns it
    // has never seen: enabling the plugin mid-session is not an eviction.
    record.seenTurns = [...currentIds]
  } else if (changed) {
    const kept = new Set(currentIds)
    for (const id of record.seenTurns) {
      if (kept.has(id) || knows(record, id)) continue
      const span = spans.find((entry) => entry.id === id)
      if (span === undefined) continue
      // The host may have trimmed the transcript already. A span that is gone is
      // not recoverable; the model had the same chance to fold it as any other.
      const messages = erodeToolResults(turnMessages(raw, span), config.maxResultChars).messages
      const gist = mechanicalGist(span, config.charsPerToken)
      let chars = gist.length
      for (const message of messages) chars += messageChars(message)
      record.pending.push({ id, gist, chars, messages, createdAt: now(), age: 0 })
    }
    record.seenTurns = [...currentIds]

    // Age only on a new user turn, not on a tool continuation: a ten-call turn
    // must not consume ten eviction leads.
    for (const pending of record.pending) pending.age += 1
    if (config.autoArchive) {
      for (const pending of [...record.pending]) {
        if (pending.age <= config.evictionLead) continue
        archivePending(record, pending.id, pending.gist, true, {
          now: now(),
          maxTurns: config.archiveMaxTurns,
          maxChars: config.archiveMaxChars,
        })
      }
    } else {
      record.pending = record.pending.filter((pending) => pending.age <= config.evictionLead)
    }
    trimArchive(record, config.archiveMaxTurns, config.archiveMaxChars)
  }

  // A mode notice is a standing instruction, not a turn: keep every distinct text
  // on the record so it survives the window it was stripped from. A text the model
  // retired is skipped while it is still in the window, so a removal sticks.
  if (split.notices.length > 0) {
    const folded = upsertNotices(record.notices ?? [], split.notices, now(), record.retired ?? [])
    record.notices = folded.notices
    if (folded.retired.length > 0) record.retired = folded.retired
    else delete record.retired
  }

  const memoryTokens = estimateTokens(memoryChars(record.memory), config.charsPerToken)
  const workingTokens = estimateTokens(messagesChars(working), config.charsPerToken)
  const modelContext = modelContextOf(input.model)
  const overBudget =
    memoryTokens > config.memoryTokens ||
    workingTokens > config.workingTokens ||
    (modelContext !== undefined && memoryTokens + workingTokens > Math.floor(modelContext * 0.9))

  record.lastReport = {
    memoryTokens,
    workingTokens,
    totalTokens: memoryTokens + workingTokens,
    workingTurns: window.turns.length,
    droppedTurns: window.dropped.length,
    overBudget,
    modelContext,
    hostSystemTokens,
    hostSystemParts: hostSystem.length,
  }

  // The counterfactual, recorded at the only moment both sides are exact: the
  // input we were handed is what a disabled plugin would send. `history` is not
  // part of the payload, so this appends on every pass without changing bytes.
  const policyTokens = estimateTokens(POLICY.length, config.charsPerToken)
  const noticeChars = (record.notices ?? []).reduce((sum, notice) => sum + notice.text.length, 0)
  const sample: PassSample = {
    at: now(),
    turn: currentIds.length > 0 ? currentIds[currentIds.length - 1] : undefined,
    transcriptTokens: messagesChars(input.messages),
    policyTokens,
    noticeTokens: estimateTokens(noticeChars, config.charsPerToken),
    hostSystemTokens,
    hostSystemParts: hostSystem.length,
    memoryTokens,
    workingTokens,
    totalTokens: memoryTokens + workingTokens + policyTokens,
    workingTurns: window.turns.length,
    droppedTurns: window.dropped.length,
    overBudget,
    modelContext,
  }
  record.history = trimHistory([...(record.history ?? []), sample])

  const report: ContextReport = {
    ...record.lastReport,
    archived: record.archive.length,
    pending: record.pending.length,
    goalEmpty: record.memory.goal.trim().length === 0,
  }

  const memoryText = renderMemory(record)
  const memoryMessage: Message = {
    id: MEMORY_MESSAGE_ID,
    role: "user",
    content: [{ type: "text", text: memoryText }],
  }
  const messages: Message[] = [memoryMessage, ...working]

  // Drop a stale pinned-notices part the host may be carrying, then append the
  // current one: the block changes when the mode does, unlike the static policy.
  const system = input.system.filter((part) => !part.text.startsWith(NOTICE_HEADING))
  if (!system.some((part) => part.text === POLICY)) system.push({ type: "text", text: POLICY })
  const noticesText = renderNotices(record)
  if (noticesText !== undefined) system.push({ type: "text", text: noticesText })

  await deps.store.save(input.sessionID, record)

  if (config.debug) {
    deps.warn?.(
      `context ${input.sessionID}: memory ${report.memoryTokens}/${config.memoryTokens}, working ${report.workingTokens}/${config.workingTokens}, ` +
        `${report.workingTurns} kept, ${report.droppedTurns} dropped, ${report.pending} pending, ${report.archived} archived`,
    )
  }

  return { system, messages, report }
}

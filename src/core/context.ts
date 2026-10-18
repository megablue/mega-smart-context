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
import { POLICY, budgetOf, renderMemory } from "./prompts.ts"
import { trimHistory, type SessionStore } from "./state.ts"
import type { Message, PassSample, SessionRecord, SystemPart } from "./types.ts"
import {
  MEMORY_MESSAGE_ID,
  erodeToolResults,
  isInjected,
  selectWorkingWindow,
  stripReasoning,
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

  // The host rebuilds from the durable transcript, so an injected message here
  // would only be a stale copy. Filter defensively; the transcript itself is
  // never edited.
  const raw = input.messages.filter((message) => !isInjected(message))
  const spans = turnSpans(raw)
  const window = selectWorkingWindow(raw, {
    workingTokens: config.workingTokens,
    charsPerToken: config.charsPerToken,
  })

  const workingRaw = raw.slice(window.startIdx)
  const eroded = erodeToolResults(workingRaw, config.maxResultChars)
  const currentTurnStart =
    window.turns.length > 0 ? Math.max(0, window.turns[window.turns.length - 1].startIdx - window.startIdx) : 0
  const working = stripReasoning(eroded.messages, currentTurnStart)

  const currentIds = window.turns.map((span) => span.id)
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
  }

  // The counterfactual, recorded at the only moment both sides are exact: the
  // input we were handed is what a disabled plugin would send. `history` is not
  // part of the payload, so this appends on every pass without changing bytes.
  const policyTokens = estimateTokens(POLICY.length, config.charsPerToken)
  const sample: PassSample = {
    at: now(),
    turn: currentIds.length > 0 ? currentIds[currentIds.length - 1] : undefined,
    transcriptTokens: messagesChars(input.messages),
    policyTokens,
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

  const memoryText = renderMemory(record, config, budgetOf(record, config))
  const memoryMessage: Message = {
    id: MEMORY_MESSAGE_ID,
    role: "user",
    content: [{ type: "text", text: memoryText }],
  }
  const messages: Message[] = [memoryMessage, ...working]

  const system = [...input.system]
  if (!system.some((part) => part.text === POLICY)) system.push({ type: "text", text: POLICY })

  await deps.store.save(input.sessionID, record)

  if (config.debug) {
    deps.warn?.(
      `context ${input.sessionID}: memory ${report.memoryTokens}/${config.memoryTokens}, working ${report.workingTokens}/${config.workingTokens}, ` +
        `${report.workingTurns} kept, ${report.droppedTurns} dropped, ${report.pending} pending, ${report.archived} archived`,
    )
  }

  return { system, messages, report }
}

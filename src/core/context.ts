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
import { checkpointAppend, invalidateAppend, migrateAppend } from "./append.ts"
import type { ResolvedConfig } from "./config.ts"
import { estimateTokens, memoryChars, messageChars, messagesChars } from "./measure.ts"
import { APPEND_NOTE, POLICY, NOTICE_HEADING, renderMemory, renderNotices, renderSnapshot, renderTailState, renderUpdate } from "./prompts.ts"
import { applyProfile, choiceLabel, chooseProfile, stampModel } from "./profiles.ts"
import { mergeRaw, type RawDraft } from "./raw.ts"
import { trimHistory, upsertNotices, type SessionStore } from "./state.ts"
import type { Message, MemoryUpdate, PassSample, SessionRecord, SystemPart } from "./types.ts"
import { applyRevert, noteTurn, undoLine } from "./undo.ts"
import {
  INJECTED_PREFIX,
  MEMORY_MESSAGE_ID,
  erodeToolResults,
  isInjected,
  previewOf,
  rebuildTurn,
  selectAppendWindow,
  selectWorkingWindow,
  splitNotices,
  supersededReads,
  turnSpans,
  type TurnSpan,
} from "./view.ts"

/** Most leaving-turn previews the tail note lists before counting the rest. */
const MAX_LEAVING_LISTED = 6

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

/**
 * Move the turns the new window no longer keeps into pending, age the queue and
 * archive what the lead has outlived.
 *
 * Shared by both layouts. In the snapshot layout the window drops turns when the
 * working budget is spent; in the append layout it drops them only when a
 * compaction resets the era. The rule is the same: a turn that is no longer in
 * the window and is not already pending or archived is new pending material.
 */
function evictTurns(options: {
  readonly record: SessionRecord
  readonly spans: ReadonlyArray<TurnSpan>
  readonly raw: ReadonlyArray<Message>
  readonly currentIds: ReadonlyArray<string>
  readonly config: ResolvedConfig
  readonly now: () => number
  /**
   * Archive each newly dropped turn at once instead of leaving it pending.
   *
   * The compaction fold is the one drop whose decision window already happened:
   * the commit window was the model's chance to summarize the turn into
   * memory. Straight to the archive with the raw kept, searchable via
   * `recall`/`expand`, rather than sitting in a queue that begs to be purged.
   */
  readonly archiveNow?: boolean
  /** Collect originals for the shortened results; the view owns the marker. */
  readonly rawSink?: (draft: RawDraft) => void
}): void {
  const { record, spans, raw, currentIds, config } = options
  const bootstrap = record.seenTurns.length === 0
  const changed = !bootstrap && !sameTurns(record.seenTurns, currentIds)

  if (bootstrap) {
    // The first pass has nothing to compare against. It must not archive turns it
    // has never seen: enabling the plugin mid-session is not an eviction.
    record.seenTurns = [...currentIds]
    return
  }
  if (!changed) return

  const kept = new Set(currentIds)
  for (const id of record.seenTurns) {
    if (kept.has(id) || knows(record, id)) continue
    const span = spans.find((entry) => entry.id === id)
    if (span === undefined) continue
    // The host may have trimmed the transcript already. A span that is gone is
    // not recoverable; the model had the same chance to fold it as any other.
    const messages = erodeToolResults(turnMessages(raw, span), config.maxResultChars, {
      sink: options.rawSink,
    }).messages
    const gist = mechanicalGist(span, config.charsPerToken)
    let chars = gist.length
    for (const message of messages) chars += messageChars(message)
    record.pending.push({ id, gist, chars, messages, createdAt: options.now(), age: 0 })
    if (options.archiveNow === true) {
      archivePending(record, id, gist, true, {
        now: options.now(),
        maxTurns: config.archiveMaxTurns,
        maxChars: config.archiveMaxChars,
      })
    }
  }
  record.seenTurns = [...currentIds]

  // Age only on a new user turn, not on a tool continuation: a ten-call turn
  // must not consume ten eviction leads.
  for (const pending of record.pending) pending.age += 1
  if (config.autoArchive) {
    for (const pending of [...record.pending]) {
      if (pending.age <= config.evictionLead) continue
      archivePending(record, pending.id, pending.gist, true, {
        now: options.now(),
        maxTurns: config.archiveMaxTurns,
        maxChars: config.archiveMaxChars,
      })
    }
  } else {
    record.pending = record.pending.filter((pending) => pending.age <= config.evictionLead)
  }
  trimArchive(record, config.archiveMaxTurns, config.archiveMaxChars)
}

/**
 * The window with the rebuilt turns applied, then eroded.
 *
 * The rebuild is stored as turn ids (`record.rebuilt`), not as bytes, so every
 * pass re-derives the same result from the raw transcript. The current turn is
 * never rebuilt: its newest tool result is what the model is waiting for.
 */
function renderWindow(
  raw: ReadonlyArray<Message>,
  window: { readonly startIdx: number; readonly turns: ReadonlyArray<TurnSpan> },
  rebuilt: ReadonlySet<string>,
  config: ResolvedConfig,
  rawSink?: (draft: RawDraft) => void,
): { messages: Message[]; saved: number } {
  if (rebuilt.size === 0 || window.turns.length === 0) {
    return {
      messages: erodeToolResults(raw.slice(window.startIdx), config.maxResultChars, {
        protectNewest: true,
        sink: rawSink,
      }).messages,
      saved: 0,
    }
  }
  const currentId = window.turns[window.turns.length - 1].id
  const replaced = supersededReads(
    window.turns.filter((span) => span.id !== currentId).map((span) => raw.slice(span.startIdx, span.endIdx + 1)),
  )
  const pieces: Message[] = []
  let saved = 0
  for (const span of window.turns) {
    const turn = raw.slice(span.startIdx, span.endIdx + 1)
    if (span.id !== currentId && rebuilt.has(span.id)) {
      const result = rebuildTurn(turn, { supersededReads: replaced })
      pieces.push(...result.messages)
      saved += result.charsSaved
    } else {
      pieces.push(...turn)
    }
  }
  return {
    messages: erodeToolResults(pieces, config.maxResultChars, { protectNewest: true, sink: rawSink }).messages,
    saved,
  }
}

export async function buildPayload(input: ContextInput, deps: ContextDeps): Promise<ContextPlan> {
  const now = deps.now ?? (() => Date.now())
  const record: SessionRecord = await deps.store.load(input.sessionID)

  // Stamp the model before choosing the profile: an automatic profile is a
  // function of the model, and the tool, `/context` and the status RPC never see
  // a request event, so they re-derive the same choice from this stamp. A pass
  // that names no model leaves the previous stamp alone.
  const model = stampModel(input.model)
  if (model !== undefined) record.lastModel = model
  const profile = chooseProfile(deps.config, record.profile, record.lastModel)
  // Everything below uses the session's effective config, not the base one: a
  // profile changes the real window, erosion, the caps and the archive bounds.
  const config = applyProfile(deps.config, profile)

  // The host's own instruction set (`core/instructions` and the rest) rides in
  // `event.system` beside the policy this plugin writes. It is measured for
  // display only — no budget counts it — and only when a part is actually there,
  // so a host that does not hand its instructions over shows nothing rather than
  // a zero. The debug line names what was found, which is how the shape of
  // `event.system` is checked after a restart.
  const hostSystem = input.system.filter(
    (part) =>
      typeof part.text === "string" &&
      part.text !== POLICY &&
      part.text !== APPEND_NOTE &&
      !part.text.startsWith(NOTICE_HEADING),
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
  return buildAppendPlan({
      input,
      deps,
      record,
      config,
      hostSystem,
      hostSystemTokens,
      raw,
      spans,
      notices: split.notices,
      now,
    })
}

interface AppendPlanInput {
  readonly input: ContextInput
  readonly deps: ContextDeps
  readonly record: SessionRecord
  readonly config: ResolvedConfig
  readonly hostSystem: SystemPart[]
  readonly hostSystemTokens: number | undefined
  readonly raw: Message[]
  readonly spans: TurnSpan[]
  readonly notices: ReadonlyArray<{ id: string; text: string }>
  readonly now: () => number
}

/**
 * The append-only pass.
 *
 * The order is the layout: a checkpoint first, then the turns, each completed
 * turn's accepted delta beside it, then the current turn, then one tail state
 * note. A patch therefore appends after its turn instead of rewriting the first
 * block. Compaction is the only step that moves the checkpoint: it folds the
 * log, keeps the newest turns that fit the working share, and evicts the rest
 * through the same pending/archive path as the snapshot layout.
 */
async function buildAppendPlan(options: AppendPlanInput): Promise<ContextPlan> {
  const { input, deps, record, config, hostSystem, hostSystemTokens, raw, spans, notices, now } = options

  migrateAppend(record)

  // Originals for this pass's shortened tool results. The view computes the
  // stable id and calls the sink; the record gets the merged store before save.
  const rawDrafts = new Map<string, RawDraft>()
  const rawSink = (draft: RawDraft): void => {
    if (!rawDrafts.has(draft.id)) rawDrafts.set(draft.id, draft)
  }

  // A committed host revert replaces memory; the log from the undone turn
  // cannot stay beside it. This is the one cache reset the model already paid
  // for by reverting.
  let undo: ReturnType<typeof applyRevert> | undefined
  if (record.revert !== undefined) {
    undo = applyRevert(record, record.revert, now())
    checkpointAppend(record)
  }

  // The era starts at `windowStart`. When the marker is missing (a fresh record,
  // or a host that trimmed the turn away), seed it from the ordinary window so
  // enabling the layout mid-session does not replay history the plugin never
  // managed.
  let window = record.windowStart === undefined ? undefined : selectAppendWindow(raw, record.windowStart)
  if (window === undefined) {
    const fallback = selectWorkingWindow(raw, {
      workingTokens: config.workingTokens,
      charsPerToken: config.charsPerToken,
    })
    window = selectAppendWindow(raw, fallback.turns[0]?.id) ?? {
      startIdx: fallback.startIdx,
      turns: fallback.turns,
      dropped: fallback.dropped,
      chars: fallback.chars,
    }
    record.windowStart = fallback.turns[0]?.id
  }

  // A fold rebuilds the retained tail's bytes; the switch is re-read every pass,
  // so turning it off returns the original transcript bytes. The current turn is
  // never rebuilt: its newest tool result is what the model is waiting for.
  if (!config.rebuildOnCompaction) {
    delete record.rebuilt
    delete record.rebuildSaved
  } else if (record.rebuilt !== undefined) {
    const known = new Set(spans.map((span) => span.id))
    record.rebuilt = record.rebuilt.filter((id) => known.has(id))
    if (record.rebuilt.length === 0) delete record.rebuilt
  }
  let workingTurns = renderWindow(raw, window, new Set(record.rebuilt ?? []), config, rawSink).messages
  let currentIds = window.turns.map((span) => span.id)

  if (undo !== undefined) {
    // The undo line is rendered for the turn the rollback landed in; noteTurn
    // clears it once a newer user turn arrives.
    record.lastUndo = { ...undo, seen: currentIds[currentIds.length - 1] }
    if (config.debug) deps.warn?.(`context ${input.sessionID}: ${undoLine(undo)}`)
  }
  noteTurn(record, currentIds[currentIds.length - 1], now())

  // The shared pool, in characters. `memoryTokens` and `workingTokens` are
  // estimates, so convert once and compare the rendered bytes.
  const poolChars = (config.memoryTokens + config.workingTokens) * Math.max(1, config.charsPerToken)
  let snapshotText = renderSnapshot(record.base ?? record.memory)
  let updateTexts = (record.updates ?? []).map(renderUpdate)
  let turnChars = messagesChars(workingTurns)
  let footChars = snapshotText.length + updateTexts.reduce((sum, text) => sum + text.length, 0) + turnChars
  let over = footChars > poolChars

  // A `due` mark is a commit window, not an order to fold at once. It records
  // the turn it was raised in; every pass of that same turn keeps the window
  // open — a real context window has room the estimated pool does not — and the
  // state note lists what will leave so the model can write it into memory
  // first. The fold runs on the first pass whose current turn is newer: the
  // next prompt. A mark without a turn is a legacy record; it folds on the next
  // over-cap pass, as it always did. `requested` folds at once: the model
  // called for it, so it has already written what matters.
  const mark = record.compact
  const currentTurnId = currentIds.length > 0 ? currentIds[currentIds.length - 1] : ""
  const dueFolds =
    mark !== undefined &&
    mark.mode === "due" &&
    over &&
    (mark.turn === undefined || mark.turn !== currentTurnId)
  const folds = (mark !== undefined && mark.mode === "requested") || dueFolds
  if (folds) {
    // The retained tail is `compactKeepTokens`, not the working share: the
    // fold is the one step that shrinks the era, and a working-share tail would
    // keep almost everything and free nothing. What falls outside the tail is
    // archived immediately with the raw kept — the commit window was the
    // model's chance to summarize it into memory.
    const tail = selectWorkingWindow(raw, {
      workingTokens: config.compactKeepTokens,
      charsPerToken: config.charsPerToken,
    })
    checkpointAppend(record)
    record.windowStart = tail.turns[0]?.id
    window = selectAppendWindow(raw, record.windowStart) ?? {
      startIdx: tail.startIdx,
      turns: tail.turns,
      dropped: tail.dropped,
      chars: tail.chars,
    }
    const tailCurrent = window.turns.length > 0 ? window.turns[window.turns.length - 1].id : ""
    if (config.rebuildOnCompaction) {
      record.rebuilt = window.turns.filter((span) => span.id !== tailCurrent).map((span) => span.id)
    } else {
      delete record.rebuilt
      delete record.rebuildSaved
    }
    const rendered = renderWindow(raw, window, new Set(record.rebuilt ?? []), config, rawSink)
    workingTurns = rendered.messages
    if (config.rebuildOnCompaction) record.rebuildSaved = rendered.saved
    currentIds = window.turns.map((span) => span.id)
    snapshotText = renderSnapshot(record.base ?? record.memory)
    updateTexts = []
    turnChars = messagesChars(workingTurns)
  } else if (over && record.compact === undefined) {
    record.compact = { mode: "due", at: now(), turn: currentTurnId }
  } else if (!over && record.compact?.mode === "due") {
    delete record.compact
  }

  evictTurns({ record, spans, raw, currentIds, config, now, archiveNow: folds, rawSink })

  // What the commit window would drop: the era turns outside the retained
  // tail. The note names them so the model can write them into memory before
  // the fold; the list is recomputed every pass because the tail depends on
  // the checkpoint, which the commits are growing.
  let leaving: string[] = []
  if (record.compact?.mode === "due") {
    const tailIds = new Set(
      selectWorkingWindow(raw, {
        workingTokens: config.compactKeepTokens,
        charsPerToken: config.charsPerToken,
      }).turns.map((span) => span.id),
    )
    const going = window.turns.filter((span) => !tailIds.has(span.id))
    leaving = going.slice(0, MAX_LEAVING_LISTED).map(
      (span) => `${span.id} · ${previewOf(span, config.charsPerToken)}`,
    )
    if (going.length > MAX_LEAVING_LISTED) {
      leaving.push(`… and ${going.length - MAX_LEAVING_LISTED} more older turn(s)`)
    }
  }

  // The mode is a tail line now, so the system keeps only the non-mode
  // notices. A Plan/Build switch does not move the system prefix.
  if (notices.length > 0) {
    const folded = upsertNotices(record.notices ?? [], notices, now(), record.retired ?? [])
    record.notices = folded.notices
    if (folded.retired.length > 0) record.retired = folded.retired
    else delete record.retired
  }
  const noticesText = renderNotices(record, { excludeModes: true })

  // An update stays beside the turn that wrote it. The current turn's own patch
  // is deferred: the model just wrote it, and the next pass will show it.
  const currentTurn = currentIds.length > 0 ? currentIds[currentIds.length - 1] : ""
  const byTurn = new Map<string, string[]>()
  const orphans: string[] = []
  const updateList = record.updates ?? []
  updateList.forEach((update, index) => {
    if (currentTurn.length > 0 && update.turn === currentTurn) return
    const text = updateTexts[index]
    if (text === undefined) return
    if (update.turn.length === 0 || !currentIds.includes(update.turn)) {
      orphans.push(text)
      return
    }
    const list = byTurn.get(update.turn) ?? []
    list.push(text)
    byTurn.set(update.turn, list)
  })

  const sentUpdateChars =
    [...byTurn.values()].reduce((sum, texts) => sum + texts.join("\n").length, 0) +
    orphans.reduce((sum, text) => sum + text.length, 0)

  const working: Message[] = []
  const turnEnds = new Map<number, string>()
  for (const span of window.turns) {
    const end = span.endIdx - window.startIdx
    if (end >= 0) turnEnds.set(end, span.id)
  }
  const currentSpan = window.turns.length > 0 ? window.turns[window.turns.length - 1] : undefined
  const currentStart = currentSpan === undefined ? -1 : currentSpan.startIdx - window.startIdx

  let tailIndex = -1
  for (let index = 0; index < workingTurns.length; index += 1) {
    if (index === currentStart) tailIndex = working.length
    working.push(workingTurns[index])
    const turn = turnEnds.get(index)
    if (turn === undefined) continue
    const texts = byTurn.get(turn)
    if (texts === undefined) continue
    working.push({
      id: INJECTED_PREFIX + "update_" + turn,
      role: "user",
      content: [{ type: "text", text: texts.join("\n") }],
    })
  }
  if (tailIndex < 0) tailIndex = working.length

  if (orphans.length > 0) {
    working.splice(tailIndex, 0, {
      id: INJECTED_PREFIX + "update_orphan",
      role: "user",
      content: [{ type: "text", text: orphans.join("\n") }],
    })
  }

  // The tail note is part of the working share. Render it once with the
  // turns-only number, then once with the number that includes the note; the
  // second render is the one inserted, so the printed split is honest.
  //
  // It goes after the current turn, not before it. These numbers change on
  // every pass inside a turn, and a byte that changes before the current turn
  // makes the provider re-read the whole turn on each tool loop. Trailing keeps
  // the turn a stable prefix and the note is still the last thing the model
  // reads before it replies.
  const poolCap = config.memoryTokens + config.workingTokens
  const modelContext = modelContextOf(input.model)
  const snapshotTokens = estimateTokens(snapshotText.length, config.charsPerToken)
  const updateTokens = estimateTokens(sentUpdateChars, config.charsPerToken)
  let workingTokens = estimateTokens(turnChars, config.charsPerToken)
  let tail = renderTailState(record, {
    poolTokens: snapshotTokens + updateTokens + workingTokens,
    poolCap,
    snapshotTokens,
    updateTokens,
    workingTokens,
    compactDue: record.compact?.mode === "due",
    keepTokens: config.compactKeepTokens,
    leaving,
    modelContext,
  })
  workingTokens = estimateTokens(turnChars + tail.length, config.charsPerToken)
  tail = renderTailState(record, {
    poolTokens: snapshotTokens + updateTokens + workingTokens,
    poolCap,
    snapshotTokens,
    updateTokens,
    workingTokens,
    compactDue: record.compact?.mode === "due",
    keepTokens: config.compactKeepTokens,
    leaving,
    modelContext,
  })
  workingTokens = estimateTokens(turnChars + tail.length, config.charsPerToken)

  working.push({
    id: INJECTED_PREFIX + "state",
    role: "user",
    content: [{ type: "text", text: tail }],
  })

  const memoryTokens = snapshotTokens + updateTokens
  const totalTokens = memoryTokens + workingTokens
  const overBudget =
    totalTokens > poolCap ||
    (modelContext !== undefined && totalTokens > Math.floor(modelContext * 0.9))

  record.lastReport = {
    memoryTokens,
    workingTokens,
    totalTokens,
    workingTurns: window.turns.length,
    droppedTurns: window.dropped.length,
    overBudget,
    modelContext,
    hostSystemTokens,
    hostSystemParts: hostSystem.length,
  }

  const policyTokens = estimateTokens((POLICY + "\n\n" + APPEND_NOTE).length, config.charsPerToken)
  const noticeTokens = noticesText === undefined ? 0 : estimateTokens(noticesText.length, config.charsPerToken)
  const sample: PassSample = {
    at: now(),
    turn: currentTurn.length > 0 ? currentTurn : undefined,
    transcriptTokens: messagesChars(input.messages),
    policyTokens,
    noticeTokens,
    hostSystemTokens,
    hostSystemParts: hostSystem.length,
    memoryTokens,
    workingTokens,
    totalTokens: totalTokens + policyTokens,
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

  const memoryMessage: Message = {
    id: MEMORY_MESSAGE_ID,
    role: "user",
    content: [{ type: "text", text: snapshotText }],
  }
  const messages: Message[] = [memoryMessage, ...working]

  const system: SystemPart[] = [...hostSystem]
  system.push({ type: "text", text: POLICY })
  system.push({ type: "text", text: APPEND_NOTE })
  if (noticesText !== undefined) system.push({ type: "text", text: noticesText })

  if (rawDrafts.size > 0 || record.raw !== undefined) {
    record.raw = mergeRaw(record.raw, rawDrafts.values(), now())
  }

  await deps.store.save(input.sessionID, record)

  if (config.debug) {
    deps.warn?.(
      `context ${input.sessionID}: append snapshot ${report.memoryTokens}/${config.memoryTokens}, ` +
        `updates ${updateTokens} est, working ${report.workingTokens}/${config.workingTokens}, ` +
        `pool ${report.totalTokens}/${poolCap}, ${report.workingTurns} kept, ${report.droppedTurns} dropped, ` +
        `${record.rebuildSaved === undefined ? "" : `rebuild ${record.rebuildSaved} chars saved, `}` +
        `${report.pending} pending, ${report.archived} archived, ` +
        `profile ${choiceLabel(chooseProfile(deps.config, record.profile, record.lastModel))}`,
    )
  }

  return { system, messages, report }
}

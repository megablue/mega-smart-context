/**
 * The text the model reads: the standing policy, the memory document, and the
 * compact status the `/context` command prints.
 *
 * The policy is static so the system prefix stays stable and a provider's prefix
 * cache stays warm. The memory document carries no live numbers either: it
 * changes only when the record does. The numbers are read on demand from
 * `action:"stats"` or `/context`. `docs/SPEC.md` owns the user-facing defaults,
 * and the feature pages own the mechanism.
 *
 * @module mega-smart-context/prompts
 */

import { estimateTokens, formatTokens, memoryChars } from "./measure.ts"
import { isMemoryEmpty, MEMORY_FIELDS } from "./schema.ts"
import { choiceLabel, chooseProfile, configForRecord, modelLabel } from "./profiles.ts"
import { snapshotMemory } from "./append.ts"
import { modeReminderOf } from "./view.ts"
import type { ResolvedConfig } from "./config.ts"
import type { Memory, MemoryUpdate, SessionRecord } from "./types.ts"
import { isPlainObject } from "./types.ts"

/**
 * The name a person reads. The `/context` report puts it on its first line, and
 * every drawn surface in the terminal half (the sidebar block, the panel, the
 * dialog's title, the update toast) reads it from `status.ts`, which re-exports
 * this one definition. The identifiers - the RPC id, the panel name, the command
 * ids and the config filename - stay lowercase, because the host routes them.
 *
 * It lives here, not in `status.ts`, so both halves can reach it: `status.ts`
 * already imports this module, and a constant in `status.ts` would have to be
 * imported back into the file that renders the report.
 */
export const PRODUCT_NAME = "Mega Smart Context"

/** The standing policy, pushed once into the request's system parts. */
export const POLICY = `## Smart context

You own this session's context. The host does not replay the conversation to you.
Each request contains, in order: this memory document, the newest turns that fit
the working budget (verbatim), and the current turn.

- The memory document is the durable record: your goal, plan, facts, files,
  decisions, open threads and feature-map references.
- The working window is short-term. A turn that leaves it is gone from your view.
  On the first turn, write the user's request into \`goal\` before you finish; the
  raw request is only guaranteed to survive there.
- When you learn something durable, call \`smart_context\` with action:"patch" and
  only the keys that changed. Maps merge; lists replace; \`null\` resets a key (or
  deletes one map entry). Unknown keys are dropped and an over-cap write is
  rejected rather than silently trimmed.
- \`smart_context\` is a direct tool: call it by name, never as
  \`tools.smart_context(...)\` inside \`execute\`. The Code Mode catalog does not
  contain it, so such a call comes back as "Unknown tool" and nothing is written.
  Batch independent direct calls in one assistant message instead.
- Before a turn leaves the window it appears under "Pending eviction". Archive it
  with a one-line gist (action:"archive", optionally keepRaw:true) or purge it
  (action:"purge"). With auto-archive on, an unhandled turn is archived under a
  mechanical gist; purge what is irrelevant.
- Do not search the archive out of habit. \`recall\` requires \`lost:true\`: use it
  only when a fact you need is missing from memory and the working window.
- A deep archive search is delegable: task a subagent to run \`recall\`/\`expand\`
  with from:"parent". Delegate only when the turn will not fit here - a child is
  minutes, not seconds - and ask for a digest: only the head and tail of a long
  answer survive into this window.
- Host notices (a Plan/Build switch, an output-limit nudge) are pinned, not
  replayed: they stay in the system prompt until a newer one replaces them, so a
  mode switch never evicts a turn. List them with action:"notice"; retire a
  superseded one with remove:"<id>" (the newest is the live instruction and a
  removal of it is refused).
- For project knowledge, prefer a feature-map reference over pasted prose when
  the reference is shorter. action:"ref" reports the gist and section costs.
- This block carries no live numbers. Read them with action:"stats" (or the
  /context command) and keep memory lean; compact before it is over.`

/**
 * The extra static system part the append layout pushes after {@link POLICY}.
 *
 * It is one stable block, so it rides the prefix cache with the policy. It
 * explains the two shapes the model will see: the checkpoint first, then the
 * per-turn update blocks.
 */
export const APPEND_NOTE = `## Append-only memory

The first block is a checkpoint, not the live document. A \`<smart-context-update>\`
block after a turn carries that turn's accepted patches; the newest value wins.
\`action:"read"\` returns the merged document. At compaction the checkpoint is
replaced, the log is cleared, and a short tail is kept. The live mode, pool usage
and pending evictions are in \`<smart-context-state>\`, the last block after the
current turn, not in the header.`

export interface BudgetReport {
  readonly layout: "snapshot" | "append"
  readonly memoryTokens: number
  readonly workingTokens: number
  readonly totalTokens: number
  readonly memoryCap: number
  readonly workingCap: number
  /** The shared pool: `memoryCap + workingCap`, and the request's current share. */
  readonly poolTokens: number
  readonly poolCap: number
  /** The checkpoint and the update log, split out for the append surfaces. */
  readonly snapshotTokens: number
  readonly updateTokens: number
  readonly updateCount: number
  readonly refs: number
  readonly pending: number
  readonly archive: number
  readonly workingTurns: number
  readonly droppedTurns: number
  readonly overBudget: boolean
  readonly goalEmpty: boolean
  readonly modelContext?: number
  /** The request's own system parts this plugin did not write, for display only. */
  readonly hostSystemTokens?: number
  readonly hostSystemParts?: number
}

/** Measure the current record. The working numbers come from the last pass. */
export function budgetOf(record: SessionRecord, config: ResolvedConfig): BudgetReport {
  // The caps a session is actually held to, not the install's: a profile is a
  // real budget change, and every surface must report the numbers enforced.
  const effective = configForRecord(config, record)
  const snapshotText = renderSnapshot(snapshotMemory(record))
  const updateText = (record.updates ?? []).map(renderUpdate).join("\n")
  const snapshotTokens = estimateTokens(snapshotText.length, effective.charsPerToken)
  const updateTokens = estimateTokens(updateText.length, effective.charsPerToken)
  const memoryTokens =
    effective.contextLayout === "append"
      ? snapshotTokens + updateTokens
      : estimateTokens(memoryChars(record.memory), effective.charsPerToken)
  const workingTokens = record.lastReport?.workingTokens ?? 0
  const totalTokens = memoryTokens + workingTokens
  const poolCap = effective.memoryTokens + effective.workingTokens
  const modelContext = record.lastReport?.modelContext
  const overBudget =
    effective.contextLayout === "append"
      ? totalTokens > poolCap || (modelContext !== undefined && totalTokens > Math.floor(modelContext * 0.9))
      : memoryTokens > effective.memoryTokens || workingTokens > effective.workingTokens
  return {
    layout: effective.contextLayout,
    memoryTokens,
    workingTokens,
    totalTokens,
    memoryCap: effective.memoryTokens,
    workingCap: effective.workingTokens,
    poolTokens: totalTokens,
    poolCap,
    snapshotTokens,
    updateTokens,
    updateCount: (record.updates ?? []).length,
    refs: record.memory.refs.length,
    pending: record.pending.length,
    archive: record.archive.length,
    workingTurns: record.lastReport?.workingTurns ?? 0,
    droppedTurns: record.lastReport?.droppedTurns ?? 0,
    overBudget,
    goalEmpty: record.memory.goal.trim().length === 0,
    modelContext,
    hostSystemTokens: record.lastReport?.hostSystemTokens,
    hostSystemParts: record.lastReport?.hostSystemParts,
  }
}

function q(value: string): string {
  return JSON.stringify(value)
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function budgetLine(report: BudgetReport): string {
  const parts = [
    `memory ${formatTokens(report.memoryTokens)}/${formatTokens(report.memoryCap)} est`,
    `working ${formatTokens(report.workingTokens)}/${formatTokens(report.workingCap)} est`,
    `refs ${report.refs}`,
    `pending ${report.pending}`,
    `archive ${report.archive}`,
  ]
  if (report.modelContext !== undefined && report.modelContext > 0) {
    parts.push(`window ${formatTokens(report.totalTokens)}/${formatTokens(report.modelContext)}`)
  }
  if (report.overBudget) parts.push("OVER CAP")
  return parts.join(" · ")
}

/**
 * The shared body of the memory document: goal through notes.
 *
 * `sortMaps` is for the append checkpoint, whose bytes must stay identical
 * across a reload; the snapshot layout keeps insertion order so an existing
 * record's block does not move.
 */
function memoryBody(memory: Memory, sortMaps: boolean): string[] {
  const lines: string[] = []

  if (memory.goal.trim().length === 0) {
    lines.push("goal: (empty — write the user's request here before it leaves the window)")
  } else {
    lines.push(`goal: ${q(oneLine(memory.goal))}`)
  }

  if (memory.plan.length > 0) {
    lines.push("", "## Plan")
    for (const step of memory.plan) {
      lines.push(`- [${step.status}] ${step.step}. ${oneLine(step.text)}`)
    }
  }

  const maps: Array<[string, Record<string, string>]> = [
    ["Facts", memory.facts],
    ["Files", memory.files],
    ["Decisions", memory.decisions],
  ]
  for (const [title, map] of maps) {
    const keys = sortMaps ? Object.keys(map).sort() : Object.keys(map)
    if (keys.length === 0) continue
    lines.push("", `## ${title}`)
    for (const key of keys) lines.push(`- ${q(key)}: ${q(map[key])}`)
  }

  if (memory.open.length > 0) {
    lines.push("", "## Open")
    for (const item of memory.open) lines.push(`- ${q(item)}`)
  }

  if (memory.refs.length > 0) {
    lines.push("", "## Refs")
    for (const ref of memory.refs) {
      lines.push(
        `- ${ref.page}#${ref.section} — ${q(ref.gist)} (~${formatTokens(ref.tokens)} est; feature_map page:${q(ref.page)} section:${q(ref.section)})`,
      )
    }
  }

  if (memory.notes.trim().length > 0) {
    lines.push("", "## Notes", q(memory.notes))
  }

  return lines
}

function emptyNotice(memory: Memory): string[] {
  return isMemoryEmpty(memory) ? ["", "(memory is empty — it stays that way until you write it)"] : []
}

/**
 * Render the memory document.
 *
 * The block is data, not instructions: values are JSON-quoted so a newline or a
 * delimiter inside a model-written note cannot change the shape. The only prose
 * is the fixed labels and the mechanical pending-eviction notice.
 *
 * Deliberately no live numbers: a `budget:` line here would be rewritten on
 * every pass, so nothing before it in the prefix could stay cached. The numbers
 * live in `action:"stats"` and `/context` only.
 */
export function renderMemory(record: SessionRecord): string {
  const lines: string[] = ["<smart-context>", ...memoryBody(record.memory, false)]

  if (record.lastUndo !== undefined) {
    // Shown for the turn the rollback landed in only: the model that wrote the
    // undone memory needs to know it is gone, and a later turn does not.
    lines.push("", "## Undo")
    lines.push(
      `The host reverted this session to before ${q(record.lastUndo.turn)}. ` +
        "Memory written in the undone turn was rolled back; this document is the state as of that point.",
    )
  }

  if (record.pending.length > 0) {
    lines.push("", "## Pending eviction")
    for (const pending of record.pending) {
      lines.push(`- ${pending.id} · ${q(pending.gist)}`)
      lines.push(
        `  → smart_context action:"archive" turn:${q(pending.id)} gist:"…" (or action:"purge" turn:${q(pending.id)})`,
      )
    }
  }

  lines.push(...emptyNotice(record.memory))
  lines.push("</smart-context>")
  return lines.join("\n")
}

/**
 * Render the append checkpoint: the eight memory keys, no live state.
 *
 * Sorted maps make the bytes a function of the content rather than of the
 * order the model happened to mention entries in, so a re-run over the same
 * record cannot move the checkpoint.
 */
export function renderSnapshot(memory: Memory): string {
  const lines = ["<smart-context>", ...memoryBody(memory, true), ...emptyNotice(memory), "</smart-context>"]
  return lines.join("\n")
}

/**
 * Render one turn's accepted delta.
 *
 * A map is partial: only the entries that changed, with `null` for a deletion.
 * A list or a string is the full new value. No timestamp: the turn id is the
 * stable key, and a live clock would make the block churn.
 */
export function renderUpdate(update: MemoryUpdate): string {
  const lines = [`<smart-context-update turn=${q(update.turn)}>`]
  for (const field of MEMORY_FIELDS) {
    if (!(field.key in update.patch)) continue
    const value = update.patch[field.key]
    if (value === null) {
      lines.push(`## ${field.key}`, "null")
      continue
    }
    if (field.kind === "map") {
      if (!isPlainObject(value)) continue
      const keys = Object.keys(value).sort()
      if (keys.length === 0) continue
      lines.push(`## ${field.key}`)
      for (const key of keys) {
        const entry = value[key]
        lines.push(`- ${q(key)}: ${entry === null ? "null" : q(String(entry))}`)
      }
      continue
    }
    if (field.kind === "list") {
      lines.push(`## ${field.key}`, JSON.stringify(value))
      continue
    }
    lines.push(`## ${field.key}`, q(String(value)))
  }
  lines.push("</smart-context-update>")
  return lines.join("\n")
}

/** The real model context window below which the note may print the pool cap. */
export const SMALL_WINDOW_MAX = 300_000

/** The numbers the tail state note prints. Kept separate so `renderTailState` stays pure. */
export interface TailBudget {
  readonly poolTokens: number
  readonly poolCap: number
  readonly snapshotTokens: number
  readonly updateTokens: number
  readonly workingTokens: number
  readonly compactDue: boolean
  /** The verbatim tail a fold would keep, so the due line can name its size. */
  readonly keepTokens: number
  /** Pre-rendered previews of the turns a fold would archive. */
  readonly leaving: ReadonlyArray<string>
  /**
   * The model's real context window when the host supplies one; gates the cap.
   * Above the threshold (or when unknown) the note prints usage without a cap:
   * a small cap makes a big-window model conserve instead of keep going.
   */
  readonly modelContext?: number
}

/**
 * The tail state note: the only part of the prefix that is allowed to churn.
 *
 * It is the last message, after the current turn. It carries live numbers that
 * change on every pass, so anywhere earlier would invalidate the current turn
 * on each tool loop. The mode is a compact label rather than the full host
 * reminder; the full text is still on the record for `action:"notice"`.
 */
export function renderTailState(record: SessionRecord, budget: TailBudget): string {
  const lines = ["<smart-context-state>"]

  const notices = record.notices ?? []
  let mode: "plan" | "build" | undefined
  for (let index = notices.length - 1; index >= 0 && mode === undefined; index -= 1) {
    mode = modeReminderOf(notices[index].text)
  }
  if (mode === "plan") lines.push("mode: plan — do not modify files; tell the user to switch agents")
  else if (mode === "build") lines.push("mode: build — edit and run commands")

  const smallWindow = budget.modelContext !== undefined && budget.modelContext < SMALL_WINDOW_MAX
  const cap = smallWindow ? `/${formatTokens(budget.poolCap)}` : ""
  const over = smallWindow && budget.poolTokens > budget.poolCap ? " · over cap" : ""
  lines.push(
    `pool: ${formatTokens(budget.poolTokens)}${cap}` +
      ` (snapshot ${formatTokens(budget.snapshotTokens)} · updates ${formatTokens(budget.updateTokens)} · turns ${formatTokens(budget.workingTokens)})${over}`,
  )

  for (const pending of record.pending) {
    lines.push(`pending: ${pending.id} · ${q(pending.gist)}`)
    lines.push(
      `  → smart_context action:"archive" turn:${q(pending.id)} gist:"…" (or action:"purge" turn:${q(pending.id)})`,
    )
  }

  if (record.lastUndo !== undefined) {
    lines.push(
      `undo: the host reverted this session to before ${q(record.lastUndo.turn)}; ` +
        "memory written in the undone turn was rolled back",
    )
  }

  if (budget.compactDue) {
    lines.push(
      `compaction due: the pool is full; the newest ~${formatTokens(budget.keepTokens)} of turns stay, the rest is archived at the next prompt. ` +
        'Write what still matters from the turns below into memory now — they stay searchable (recall/expand); do not purge them. ' +
        'Call smart_context action:"compact" to fold sooner.',
    )
    for (const line of budget.leaving) lines.push(`  leaving: ${line}`)
  }

  lines.push("</smart-context-state>")
  return lines.join("\n")
}

/** The heading of the pinned-notices system part; also how a stale part is found. */
export const NOTICE_HEADING = "## Pinned host notices"

/** The first line of a notice, collapsed, for a one-line listing. */
export function noticePreview(text: string): string {
  return oneLine(text).slice(0, 100)
}

function isoDate(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "(unknown)"
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Render the pinned mode notices as one system part, newest first.
 *
 * Deterministic: `at` moves only when a new notice id arrives, so a re-run over
 * the same record is byte-identical and a provider prefix cache stays warm.
 * `undefined` when there is nothing to pin, so the caller adds no part.
 */
export function renderNotices(
  record: SessionRecord,
  options: { excludeModes?: boolean } = {},
): string | undefined {
  const notices = (record.notices ?? []).filter(
    (notice) => options.excludeModes !== true || modeReminderOf(notice.text) === undefined,
  )
  if (notices.length === 0) return undefined
  const lines = [NOTICE_HEADING, ""]
  for (let index = notices.length - 1; index >= 0; index -= 1) {
    const notice = notices[index]
    lines.push(`### ${notice.id} · seen ${isoDate(notice.at)}`, notice.text, "")
  }
  while (lines[lines.length - 1] === "") lines.pop()
  return lines.join("\n")
}

/**
 * The multi-line status `/context` prints.
 *
 * `version` is the loaded build's own `package.json` version, passed by the
 * adapter; the core does not read it, so a caller without one still gets the
 * status.
 */
export function renderStats(record: SessionRecord, config: ResolvedConfig, version?: string): string {
  const report = budgetOf(record, config)
  const profile = chooseProfile(config, record.profile, record.lastModel)
  const lines = [
    `${PRODUCT_NAME}${version === undefined ? "" : ` v${version}`} · ${budgetLine(report)}`,
    `profile: ${choiceLabel(profile)}${record.lastModel === undefined ? "" : ` · ${modelLabel(record.lastModel)}`}`,
    `window: ${report.workingTurns} turns kept, ${report.droppedTurns} dropped · over budget: ${report.overBudget ? "yes" : "no"}`,
  ]
  if (report.layout === "append") {
    lines.push(
      `layout: append · pool ${formatTokens(report.poolTokens)}/${formatTokens(report.poolCap)}` +
        ` (snapshot ${formatTokens(report.snapshotTokens)} · updates ${formatTokens(report.updateTokens)} · turns ${formatTokens(report.workingTokens)})`,
    )
  }
  if (record.lastUndo !== undefined) {
    lines.push(
      `last undo: before ${record.lastUndo.turn} · ${record.lastUndo.memory} memory key(s) restored, ` +
        `${record.lastUndo.dropped} turn(s) dropped` +
        (record.lastUndo.lost > 0 ? `, ${record.lastUndo.lost} not restorable` : ""),
    )
  }
  if ((record.undo ?? []).length > 0) {
    lines.push(
      `undo journal: ${record.undo?.length} turn(s), oldest ${record.undo?.[0].turn || "(no turn yet)"} · /undo rolls these back`,
    )
  }
  if (report.hostSystemTokens !== undefined) {
    lines.push(
      `host system ~${formatTokens(report.hostSystemTokens)} est (${report.hostSystemParts ?? 0} parts) · not counted`,
    )
  }
  lines.push(`goal: ${report.goalEmpty ? "(empty)" : q(oneLine(record.memory.goal))}`)
  if ((record.notices ?? []).length > 0) {
    lines.push("", NOTICE_HEADING)
    for (const notice of [...(record.notices ?? [])].reverse()) {
      lines.push(`- ${notice.id} · ${noticePreview(notice.text)}`)
    }
  }
  if (record.pending.length > 0) {
    lines.push("", "## Pending eviction")
    for (const pending of record.pending) lines.push(`- ${pending.id} · ${pending.gist}`)
  }
  if (record.archive.length > 0) {
    lines.push("", "## Archive", `(${record.archive.length} turns)`)
    for (const entry of record.archive.slice(-10)) {
      lines.push(`- ${entry.id} · ${entry.gist}${entry.messages === undefined ? " (gist only)" : ""}`)
    }
    if (record.archive.length > 10) lines.push(`- … ${record.archive.length - 10} older`)
  }
  return lines.join("\n")
}

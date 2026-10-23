/**
 * The TUI surfaces that read the server half: what one session's record reports,
 * how a reply becomes dialog rows, how it becomes the sidebar's block, and how
 * it fills the full panel.
 *
 * The two halves of the plugin run in different processes and share no memory:
 * the server half owns the session record in the host's KV, the TUI half owns a
 * store of its own. This module is the bridge's contract. It is pure - no host
 * import, no clock, no IO - so both entrypoints can import the same definition
 * and the smoke test can drive it without a TUI.
 *
 * The values are Standard Schema v1 objects, implemented here rather than
 * imported: the host accepts the spec shape for a portable RPC definition, and
 * the plugin keeps its "no runtime dependency on the host's package" rule.
 *
 * @module mega-smart-context/status
 */

import type { ResolvedConfig } from "./config.ts"
import { formatTokens } from "./measure.ts"
import { budgetOf, noticePreview } from "./prompts.ts"
import type { SessionRecord } from "./types.ts"

/** The RPC id both halves agree on; the host routes `rpc.<id>.<method>`. */
export const STATUS_RPC_ID = "mega-smart-context"

/** The two actions the dialog offers below the status rows. */
export const RESUME_ACTION = "resume"
export const PURGE_ACTION = "purge"

/**
 * The panel's selected-content name. The host hands every `session.panel` claim
 * the name `ui.panel.open` was called with, and a contribution draws only when
 * it recognises its own.
 */
export const PANEL_NAME = "mega-smart-context"

/** The dialog row and the palette command that open the panel. */
export const PANEL_ACTION = "panel"

/** How many history samples the sparkline keeps; one cell per pass. */
export const PANEL_HISTORY_WIDTH = 40

/** How many archived turns the panel lists before it collapses the rest. */
export const PANEL_ARCHIVE_ROWS = 12

/** The eight heights a sparkline cell can take. */
export const SPARK_CHARS = "▁▂▃▄▅▆▇█"

/** Cells in one bar. Ten is readable at a sidebar-ish width and leaves the numbers room. */
export const STATUS_BAR_WIDTH = 10

/** One dialogs entry: the shape `dialog.select` takes, minus anything host-specific. */
export interface StatusRow {
  readonly title: string
  readonly value: string
  readonly description?: string
  readonly disabled?: boolean
}

/** A turn the dialog can purge, without the raw messages. */
export interface StatusTurn {
  readonly id: string
  readonly gist: string
  /** Whether the raw messages survive, which the purge select says. */
  readonly raw: boolean
  /** Recorded size, so the panel shows what a purge frees. */
  readonly chars: number
  /** New user turns since eviction; the archive only shrinks, so it is `0` there. */
  readonly age: number
}

/** A pinned notice as the panel lists it; the text never has to cross whole. */
export interface StatusNotice {
  readonly id: string
  readonly preview: string
  /** The newest emission: the live instruction, which the rail refuses to retire. */
  readonly live: boolean
}

/** What the last applied undo changed, for the panel's Undo section. */
export interface StatusUndo {
  readonly turn: string
  readonly memory: number
  readonly dropped: number
  readonly lost: number
}

export interface StatsRequest {
  readonly sessionID: string
}

/**
 * The numbers the dialog needs. Deliberately not `renderStats`'s text: the TUI
 * builds its own rows, and a gist or a notice preview never has to cross the
 * process boundary for the status view.
 */
export interface StatsReply {
  readonly version?: string
  readonly memoryTokens: number
  readonly memoryCap: number
  readonly workingTokens: number
  readonly workingCap: number
  readonly workingTurns: number
  readonly droppedTurns: number
  readonly refs: number
  readonly overBudget: boolean
  readonly goalEmpty: boolean
  /** The goal, flattened to one line and head-kept for the panel. */
  readonly goal: string
  readonly hostSystemTokens?: number
  readonly hostSystemParts?: number
  readonly pending: ReadonlyArray<StatusTurn>
  readonly archive: ReadonlyArray<StatusTurn>
  /** Newest first. The last entry of the record's own array is the live one. */
  readonly notices: ReadonlyArray<StatusNotice>
  /** Working-window tokens per pass, oldest first, for the sparkline. */
  readonly history: ReadonlyArray<number>
  readonly lastUndo?: StatusUndo
  /** Journal entries still waiting for an undo. */
  readonly undoTurns: number
}

export interface PurgeRequest {
  readonly sessionID: string
  readonly turn: string
}

export interface PurgeReply {
  readonly ok: boolean
  readonly text: string
}

/** Retire one pinned notice by id; the newest one is refused server-side. */
export interface NoticeRequest {
  readonly sessionID: string
  readonly id: string
}

export interface NoticeReply {
  readonly ok: boolean
  readonly text: string
}

/** One reply the dialog can render, or the reason the values were refused. */
export type SchemaResult<T> =
  | { readonly value: T }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> }

/** The Standard Schema v1 props the host reads; no vendor library needed. */
export type StatusSchema<T> = {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: "mega-smart-context"
    validate: (value: unknown) => SchemaResult<T>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isTurn(value: unknown): value is StatusTurn {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.gist === "string" &&
    typeof value.raw === "boolean" &&
    isCount(value.chars) &&
    isCount(value.age)
  )
}

function isNotice(value: unknown): value is StatusNotice {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.preview === "string" &&
    typeof value.live === "boolean"
  )
}

function isUndo(value: unknown): value is StatusUndo {
  return (
    isRecord(value) &&
    typeof value.turn === "string" &&
    isCount(value.memory) &&
    isCount(value.dropped) &&
    isCount(value.lost)
  )
}

/** The request guards reject an empty session id, not just a wrong type. */
export function isStatsRequest(value: unknown): value is StatsRequest {
  return isRecord(value) && typeof value.sessionID === "string" && value.sessionID.length > 0
}

export function isPurgeRequest(value: unknown): value is PurgeRequest {
  return (
    isRecord(value) &&
    typeof value.sessionID === "string" &&
    value.sessionID.length > 0 &&
    typeof value.turn === "string" &&
    value.turn.length > 0
  )
}

export function isStatsReply(value: unknown): value is StatsReply {
  if (!isRecord(value)) return false
  if (value.version !== undefined && typeof value.version !== "string") return false
  const required = [
    "memoryTokens",
    "memoryCap",
    "workingTokens",
    "workingCap",
    "workingTurns",
    "droppedTurns",
    "refs",
  ] as const
  for (const key of required) if (!isCount(value[key])) return false
  if (typeof value.overBudget !== "boolean" || typeof value.goalEmpty !== "boolean") return false
  if (typeof value.goal !== "string") return false
  if (value.hostSystemTokens !== undefined && !isCount(value.hostSystemTokens)) return false
  if (value.hostSystemParts !== undefined && !isCount(value.hostSystemParts)) return false
  if (!Array.isArray(value.pending) || !value.pending.every(isTurn)) return false
  if (!Array.isArray(value.archive) || !value.archive.every(isTurn)) return false
  if (!Array.isArray(value.notices) || !value.notices.every(isNotice)) return false
  if (!Array.isArray(value.history) || !value.history.every(isCount)) return false
  if (value.lastUndo !== undefined && !isUndo(value.lastUndo)) return false
  if (!isCount(value.undoTurns)) return false
  return true
}

export function isPurgeReply(value: unknown): value is PurgeReply {
  return isRecord(value) && typeof value.ok === "boolean" && typeof value.text === "string"
}

export function isNoticeRequest(value: unknown): value is NoticeRequest {
  return (
    isRecord(value) &&
    typeof value.sessionID === "string" &&
    value.sessionID.length > 0 &&
    typeof value.id === "string" &&
    value.id.length > 0
  )
}

export function isNoticeReply(value: unknown): value is NoticeReply {
  return isRecord(value) && typeof value.ok === "boolean" && typeof value.text === "string"
}

function schema<T>(name: string, accept: (value: unknown) => value is T): StatusSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "mega-smart-context",
      validate: (value) =>
        accept(value) ? { value } : { issues: [{ message: `${name} is malformed` }] },
    },
  }
}

export const statsRequestSchema = schema("stats input", isStatsRequest)
export const statsReplySchema = schema("stats output", isStatsReply)
export const purgeRequestSchema = schema("purge input", isPurgeRequest)
export const purgeReplySchema = schema("purge output", isPurgeReply)
export const noticeRequestSchema = schema("notice input", isNoticeRequest)
export const noticeReplySchema = schema("notice output", isNoticeReply)

/**
 * The portable definition. The id is the plugin's: the host routes
 * `/api/rpc/mega-smart-context/stats` to the last registered handler, and the TUI
 * half gets a typed client by passing this same object to `client.rpc`.
 */
export const STATUS_RPC = {
  id: STATUS_RPC_ID,
  methods: {
    stats: { input: statsRequestSchema, output: statsReplySchema },
    purge: { input: purgeRequestSchema, output: purgeReplySchema },
    notice: { input: noticeRequestSchema, output: noticeReplySchema },
  },
  events: {},
} as const

/** Build the reply the TUI renders. `version` is the loaded build's own number. */
export function statsOf(record: SessionRecord, config: ResolvedConfig, version?: string): StatsReply {
  const report = budgetOf(record, config)
  return {
    ...(version === undefined ? {} : { version }),
    memoryTokens: report.memoryTokens,
    memoryCap: report.memoryCap,
    workingTokens: report.workingTokens,
    workingCap: report.workingCap,
    workingTurns: report.workingTurns,
    droppedTurns: report.droppedTurns,
    refs: report.refs,
    overBudget: report.overBudget,
    goalEmpty: report.goalEmpty,
    goal: previewLine(record.memory.goal),
    ...(report.hostSystemTokens === undefined ? {} : { hostSystemTokens: report.hostSystemTokens }),
    ...(report.hostSystemParts === undefined ? {} : { hostSystemParts: report.hostSystemParts }),
    pending: record.pending.map((turn) => ({
      id: turn.id,
      gist: turn.gist,
      raw: turn.messages !== undefined,
      chars: turn.chars,
      age: turn.age,
    })),
    archive: record.archive.map((turn) => ({
      id: turn.id,
      gist: turn.gist,
      raw: turn.messages !== undefined,
      chars: turn.chars,
      age: 0,
    })),
    notices: [...(record.notices ?? [])].reverse().map((notice, index) => ({
      id: notice.id,
      preview: noticePreview(notice.text),
      live: index === 0,
    })),
    history: (record.history ?? []).slice(-PANEL_HISTORY_WIDTH).map((sample) => sample.workingTokens),
    ...(record.lastUndo === undefined
      ? {}
      : {
          lastUndo: {
            turn: record.lastUndo.turn,
            memory: record.lastUndo.memory,
            dropped: record.lastUndo.dropped,
            lost: record.lastUndo.lost,
          },
        }),
    undoTurns: (record.undo ?? []).length,
  }
}

/** A ten-cell bar, split so the filled cells can carry their own colour. */
export function statusBarParts(value: number, cap: number): { readonly filled: string; readonly empty: string } {
  const ratio = cap > 0 && Number.isFinite(value) ? Math.max(0, value / cap) : 0
  const filled = Math.min(STATUS_BAR_WIDTH, Math.round(ratio * STATUS_BAR_WIDTH))
  return { filled: "█".repeat(filled), empty: "░".repeat(STATUS_BAR_WIDTH - filled) }
}

/** A ten-cell bar. Over-cap fills every cell rather than overflowing the width. */
export function statusBar(value: number, cap: number): string {
  const { filled, empty } = statusBarParts(value, cap)
  return filled + empty
}

function count(value: number): string {
  return value === 1 ? "1" : String(value)
}

/** One line, trimmed, and head-kept: a goal or a notice preview for the panel. */
export function previewLine(value: string, width = 200): string {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length <= width ? line : line.slice(0, Math.max(0, width - 1)).trimEnd() + "…"
}

/** A gist one line and short enough for a dialog row. */
export function turnLabel(gist: string, width = 64): string {
  const line = gist.replace(/\s+/g, " ").trim()
  if (line.length === 0) return "(no gist)"
  return line.length <= width ? line : line.slice(0, Math.max(0, width - 1)).trimEnd() + "…"
}

/**
 * The status rows, then the two actions.
 *
 * The status rows are disabled so the selection lands on an action; the action
 * rows are what the command handles. Purge is disabled only when there is
 * nothing to purge, and carries the count so the dialog says why.
 */
export function statusRows(reply: StatsReply): StatusRow[] {
  const rows: StatusRow[] = [
    {
      title: `memory ${statusBar(reply.memoryTokens, reply.memoryCap)} ${formatTokens(reply.memoryTokens)} / ${formatTokens(reply.memoryCap)}`,
      value: "",
      description: "the memory document the model owns",
      disabled: true,
    },
    {
      title:
        `working ${statusBar(reply.workingTokens, reply.workingCap)} ` +
        `${formatTokens(reply.workingTokens)} / ${formatTokens(reply.workingCap)}` +
        (reply.overBudget ? " · over cap" : ""),
      value: "",
      description: "at the last pass; the current turn is always kept, so a long turn can sit over cap",
      disabled: true,
    },
    {
      title: `${count(reply.workingTurns)} kept · ${count(reply.droppedTurns)} dropped`,
      value: "",
      description: "turns in the working window",
      disabled: true,
    },
    {
      title: `${count(reply.pending.length)} pending · ${count(reply.archive.length)} archive · ${count(reply.refs)} ref`,
      value: "",
      description: "turns waiting for a gist, gist-only or raw turns, feature-map pointers",
      disabled: true,
    },
  ]
  if (reply.hostSystemTokens !== undefined) {
    rows.push({
      title: `host system ~${formatTokens(reply.hostSystemTokens)} est (${reply.hostSystemParts ?? 0} parts) · not counted`,
      value: "",
      description: "the request's own system prompt, outside this plugin's budget",
      disabled: true,
    })
  }
  rows.push({
    title: "Resume",
    value: RESUME_ACTION,
    description: "start a turn with no user message",
  })
  const turns = reply.pending.length + reply.archive.length
  rows.push({
    title: "Purge a turn…",
    value: PURGE_ACTION,
    description: turns === 0 ? "nothing pending or archived" : `${count(turns)} turn(s) can be purged`,
    ...(turns === 0 ? { disabled: true } : {}),
  })
  return rows
}

// ---------------------------------------------------------------------------
// The sidebar
// ---------------------------------------------------------------------------

/**
 * How long a pull stays good enough for the sidebar.
 *
 * The sidebar is a mirror, not a meter: a pass ends, the host goes idle, and one
 * pull follows. A new session, a returning route or a live turn can ask again,
 * but not more than once per window, so a chatty render cannot become a request
 * loop.
 */
export const SIDEBAR_STALE_MS = 15_000

/** One pulled reply and the moment it arrived. */
export interface StatusSnapshot {
  readonly reply: StatsReply
  readonly at: number
}

/** Whether the sidebar needs a fresh pull rather than what it already holds. */
export function snapshotStale(
  snapshot: StatusSnapshot | undefined,
  now: number,
  stale = SIDEBAR_STALE_MS,
): boolean {
  if (snapshot === undefined) return true
  if (!Number.isFinite(snapshot.at)) return true
  return now - snapshot.at >= stale
}

/**
 * A span is text plus the one tone the sidebar paints it with. Tones are names,
 * not colours: the TUI half owns the theme, and a pure module cannot import one.
 */
export type SidebarTone = "title" | "meter" | "value" | "muted" | "alert"

export interface StatusSpan {
  readonly text: string
  readonly tone: SidebarTone
}

/** One line of the sidebar block, as spans. */
export interface SidebarLine {
  readonly spans: ReadonlyArray<StatusSpan>
}

function meterLine(label: string, value: number, cap: number, alert: boolean, suffix = ""): SidebarLine {
  const { filled, empty } = statusBarParts(value, cap)
  return {
    spans: [
      { text: `${label} `, tone: "muted" },
      { text: filled, tone: alert ? "alert" : "meter" },
      { text: empty, tone: "muted" },
      { text: ` ${formatTokens(value)}/${formatTokens(cap)}`, tone: alert ? "alert" : "value" },
      ...(suffix.length > 0 ? [{ text: suffix, tone: "alert" as const }] : []),
    ],
  }
}

/**
 * The sidebar's block: a title, the two budgets, and two count lines.
 *
 * Deliberately nothing that grows with the session: no gists, no notice text, no
 * archive list. Those live behind the dialog, where the user asked for them.
 * Over cap is painted as a warning on the working line only - `workingTokens`
 * includes the current turn, which is always kept, so a long turn sits over cap
 * by design and a red block would be crying wolf.
 */
export function sidebarLines(reply: StatsReply): SidebarLine[] {
  const lines: SidebarLine[] = [
    {
      spans: [
        { text: "mega-smart-context", tone: "title" },
        ...(reply.version === undefined ? [] : [{ text: ` v${reply.version}`, tone: "muted" as const }]),
      ],
    },
    meterLine("mem", reply.memoryTokens, reply.memoryCap, reply.memoryTokens > reply.memoryCap),
    meterLine("win", reply.workingTokens, reply.workingCap, reply.overBudget, reply.overBudget ? " over" : ""),
    {
      spans: [
        { text: `${count(reply.workingTurns)} kept · ${count(reply.droppedTurns)} dropped`, tone: "muted" },
      ],
    },
    {
      spans: [
        {
          text: `${count(reply.pending.length)} pending · ${count(reply.archive.length)} archive · ${count(reply.refs)} ref`,
          tone: "muted",
        },
      ],
    },
  ]
  if (reply.hostSystemTokens !== undefined) {
    lines.push({
      spans: [
        { text: `host ~${formatTokens(reply.hostSystemTokens)} est · not counted`, tone: "muted" },
      ],
    })
  }
  return lines
}

/** The whole block as plain text, which is what a test can compare. */
export function sidebarText(reply: StatsReply): string {
  return sidebarLines(reply)
    .map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n")
}

/**
 * A sparkline of the working window over the recent passes.
 *
 * The scale tops out at the largest sample rather than at the cap: the point is
 * the shape of the curve, and a window that never nears its cap would otherwise
 * be a flat line of one character. An over-cap sample is simply the tallest cell.
 */
export function sparkline(values: ReadonlyArray<number>, width = PANEL_HISTORY_WIDTH): string {
  if (values.length === 0) return ""
  const recent = values.slice(-Math.max(1, width))
  const peak = Math.max(1, ...recent.map((value) => (Number.isFinite(value) ? value : 0)))
  return recent
    .map((value) => {
      const ratio = Math.max(0, Math.min(1, (Number.isFinite(value) ? value : 0) / peak))
      return SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.round(ratio * (SPARK_CHARS.length - 1)))]
    })
    .join("")
}

/** What a click on a panel row asks the TUI half to do. */
export type PanelActionKind = "purge" | "retire" | "resume"

export interface PanelAction {
  readonly kind: PanelActionKind
  /** The turn id (`purge`) or the notice id (`retire`); `resume` has none. */
  readonly id: string
}

/** One panel line: the same spans the sidebar uses, plus an optional action. */
export interface PanelRow {
  readonly spans: ReadonlyArray<StatusSpan>
  readonly action?: PanelAction
}

export interface PanelSection {
  readonly title: string
  readonly rows: ReadonlyArray<PanelRow>
}

function plain(spans: ReadonlyArray<StatusSpan>): string {
  return spans.map((span) => span.text).join("")
}

function turnRow(turn: StatusTurn, place: "pending" | "archive"): PanelRow {
  const notes = [`${turn.chars} ch`, turn.raw ? "gist + raw" : "gist only"]
  if (place === "pending" && turn.age > 0) notes.push(`age ${count(turn.age)}`)
  return {
    spans: [
      { text: turnLabel(turn.gist, 72), tone: "value" },
      { text: ` · ${notes.join(" · ")}`, tone: "muted" },
      { text: ` · ${turn.id}`, tone: "muted" },
    ],
    action: { kind: "purge", id: turn.id },
  }
}

/**
 * The full panel, as sections of rows.
 *
 * This is the sidebar's opposite: every list the user asked to see, including the
 * parts that grow with the session. It is built here, in a pure function, so the
 * smoke test can pin what the panel says without a TUI; `panel.tsx` only maps
 * spans to colours and rows to click handlers.
 */
export function panelSections(reply: StatsReply): PanelSection[] {
  const budget: PanelRow[] = [
    { spans: meterLine("mem ", reply.memoryTokens, reply.memoryCap, reply.memoryTokens > reply.memoryCap).spans },
    {
      spans: meterLine(
        "win ",
        reply.workingTokens,
        reply.workingCap,
        reply.overBudget,
        reply.overBudget ? " over" : "",
      ).spans,
    },
  ]
  if (reply.hostSystemTokens !== undefined) {
    budget.push({
      spans: [
        {
          text:
            `host system ~${formatTokens(reply.hostSystemTokens)} est ` +
            `(${count(reply.hostSystemParts ?? 0)} parts) · outside this plugin's budget`,
          tone: "muted",
        },
      ],
    })
  }

  const window: PanelRow[] = [
    {
      spans: [
        { text: `${count(reply.workingTurns)} kept · ${count(reply.droppedTurns)} dropped`, tone: "muted" },
      ],
    },
    {
      spans: [
        {
          text: reply.goalEmpty ? "goal: (empty)" : `goal: ${reply.goal}`,
          tone: reply.goalEmpty ? "alert" : "value",
        },
      ],
    },
  ]
  if (reply.history.length >= 2) {
    window.push({
      spans: [
        { text: "passes ", tone: "muted" },
        { text: sparkline(reply.history), tone: reply.overBudget ? "alert" : "meter" },
        {
          text: ` ${count(reply.history.length)} samples · peak ${formatTokens(Math.max(...reply.history))}`,
          tone: "muted",
        },
      ],
    })
  }

  const undo: PanelRow[] = []
  if (reply.lastUndo !== undefined) {
    undo.push({
      spans: [
        {
          text:
            `last undo: before ${reply.lastUndo.turn} · ${reply.lastUndo.memory} memory key(s), ` +
            `${reply.lastUndo.dropped} turn(s) dropped` +
            (reply.lastUndo.lost > 0 ? `, ${reply.lastUndo.lost} not restorable` : ""),
          tone: "muted",
        },
      ],
    })
  }
  if (reply.undoTurns > 0) {
    undo.push({
      spans: [{ text: `journal: ${count(reply.undoTurns)} turn(s) still restorable by /undo`, tone: "muted" }],
    })
  }
  if (undo.length === 0) undo.push({ spans: [{ text: "nothing to undo", tone: "muted" }] })

  const notices: PanelRow[] = reply.notices.map((notice) => ({
    spans: [
      { text: notice.preview, tone: "value" },
      { text: notice.live ? " · live" : "", tone: "muted" },
      { text: ` · ${notice.id}`, tone: "muted" },
    ],
    ...(notice.live ? {} : { action: { kind: "retire" as const, id: notice.id } }),
  }))
  if (notices.length === 0) notices.push({ spans: [{ text: "none pinned", tone: "muted" }] })

  const pending: PanelRow[] = reply.pending.map((turn) => turnRow(turn, "pending"))
  if (pending.length === 0) pending.push({ spans: [{ text: "nothing waiting", tone: "muted" }] })

  const archiveRows = reply.archive.slice(-PANEL_ARCHIVE_ROWS).reverse()
  const archive: PanelRow[] = archiveRows.map((turn) => turnRow(turn, "archive"))
  if (archive.length === 0) archive.push({ spans: [{ text: "empty", tone: "muted" }] })
  else if (reply.archive.length > archiveRows.length) {
    archive.push({
      spans: [{ text: `… ${count(reply.archive.length - archiveRows.length)} older`, tone: "muted" }],
    })
  }

  return [
    { title: "Budget", rows: budget },
    { title: "Window", rows: window },
    { title: `Pending eviction (${count(reply.pending.length)})`, rows: pending },
    { title: `Archive (${count(reply.archive.length)})`, rows: archive },
    { title: `Pinned notices (${count(reply.notices.length)})`, rows: notices },
    { title: "Undo", rows: undo },
  ]
}

/** The panel as plain text, one row per line, which is what a test can compare. */
export function panelText(reply: StatsReply): string {
  const lines: string[] = []
  for (const section of panelSections(reply)) {
    lines.push(`## ${section.title}`)
    for (const row of section.rows) {
      lines.push(`${plain(row.spans)}${row.action === undefined ? "" : ` [${row.action.kind}]`}`)
    }
  }
  return lines.join("\n")
}


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
import { PRODUCT_NAME, budgetOf, noticePreview } from "./prompts.ts"
import { choiceLabel, chooseProfile, modelLabel, type ProfileSource } from "./profiles.ts"
import type { SessionRecord } from "./types.ts"

/**
 * The name a person reads, spelled once in `prompts.ts` because the `/context`
 * report prints it on its first line. Re-exported here so the terminal half
 * takes everything it draws from this one module.
 */
export { PRODUCT_NAME }

/** The RPC id both halves agree on; the host routes `rpc.<id>.<method>`. */
export const STATUS_RPC_ID = "mega-smart-context"

/** The two actions the dialog offers below the status rows. */
export const RESUME_ACTION = "resume"
export const PURGE_ACTION = "purge"
/** The dialog value that opens the profile picker. */
export const PROFILE_ACTION = "profile"

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

/**
 * Cells in one bar.
 *
 * Eighteen is about double the old ten and still fits the sidebar block at the
 * observed width: the `mem ` label, the bar and the widest numbers (`*122k / 40k`)
 * come to 35 cells, so the flexible gap before the numbers keeps a few cells of
 * slack. A narrower sidebar is one constant away from a shorter bar.
 */
export const STATUS_BAR_WIDTH = 18

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

/**
 * The profile a session runs on, as it crosses the process boundary.
 *
 * `source` is where it came from, not what the user last clicked: `model` and
 * `default` both mean auto. `missing` names a pin the config no longer defines.
 */
export interface StatusProfile {
  readonly name?: string
  readonly source: ProfileSource
  readonly model?: string
  readonly missing?: string
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
  /**
   * When the record behind this reply was last written, in ms since the epoch.
   *
   * A reply built without a clock (the smoke test, an older caller) omits both
   * this and `ageMs`; the block then draws no freshness line rather than a lie.
   */
  readonly updatedAt?: number
  /** How old that write was when the reply was built, for the "measured" line. */
  readonly ageMs?: number
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
  /**
   * The profile in force. Optional so a reply from an older build still parses;
   * this build always fills it.
   */
  readonly profile?: StatusProfile
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

/** Choose this session's profile: auto, the base config, or a named bundle. */
export type ProfileMode = "auto" | "base" | "profile"

/**
 * A manual switch. `auto` clears the pin, `base` pins the plain config, and
 * `profile` pins a name. A pin survives a model change; only `auto` clears it.
 */
export interface ProfileRequest {
  readonly sessionID: string
  readonly mode: ProfileMode
  /** Required with `mode:"profile"`; ignored otherwise. */
  readonly name?: string
}

export interface ProfileReply {
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

function isProfile(value: unknown): value is StatusProfile {
  return (
    isRecord(value) &&
    (value.name === undefined || (typeof value.name === "string" && value.name.length > 0)) &&
    (value.source === "pin" || value.source === "model" || value.source === "default" || value.source === "base") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.missing === undefined || typeof value.missing === "string")
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
  if (value.updatedAt !== undefined && !isCount(value.updatedAt)) return false
  if (value.ageMs !== undefined && !isCount(value.ageMs)) return false
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
  if (value.profile !== undefined && !isProfile(value.profile)) return false
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

export function isProfileRequest(value: unknown): value is ProfileRequest {
  if (!isRecord(value) || typeof value.sessionID !== "string" || value.sessionID.length === 0) return false
  if (value.mode !== "auto" && value.mode !== "base" && value.mode !== "profile") return false
  if (value.mode === "profile") return typeof value.name === "string" && value.name.length > 0
  return value.name === undefined || typeof value.name === "string"
}

export function isProfileReply(value: unknown): value is ProfileReply {
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
export const profileRequestSchema = schema("profile input", isProfileRequest)
export const profileReplySchema = schema("profile output", isProfileReply)

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
    profile: { input: profileRequestSchema, output: profileReplySchema },
  },
  events: {},
} as const

/**
 * Build the reply the TUI renders.
 *
 * `version` is the loaded build's own number. `now` is the moment the reply is
 * built: when it is given, the reply carries the record's stamp and its age, so
 * a block can say how old the numbers are. It is optional because the reply is
 * also built in tests and by callers with no clock.
 */
export function statsOf(
  record: SessionRecord,
  config: ResolvedConfig,
  version?: string,
  now?: number,
): StatsReply {
  const report = budgetOf(record, config)
  const profile = chooseProfile(config, record.profile, record.lastModel)
  return {
    ...(version === undefined ? {} : { version }),
    ...(now === undefined
      ? {}
      : { updatedAt: record.updatedAt, ageMs: Math.max(0, now - record.updatedAt) }),
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
    profile: {
      ...(profile.name === undefined ? {} : { name: profile.name }),
      source: profile.source,
      ...(profile.missing === undefined ? {} : { missing: profile.missing }),
      ...(record.lastModel === undefined ? {} : { model: modelLabel(record.lastModel) }),
    },
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
  const widths = meterWidths(reply)
  const rows: StatusRow[] = [
    {
      title: `${"memory".padEnd(7)} ${statusBar(reply.memoryTokens, reply.memoryCap)} ${meterNumbers(
        reply.memoryTokens,
        reply.memoryCap,
        reply.memoryTokens > reply.memoryCap,
        widths,
      )}`,
      value: "",
      description: "the memory document the model owns",
      disabled: true,
    },
    {
      title:
        `working ${statusBar(reply.workingTokens, reply.workingCap)} ` +
        meterNumbers(reply.workingTokens, reply.workingCap, reply.overBudget, widths) +
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
  if (reply.profile !== undefined) {
    rows.splice(2, 0, {
      title: `profile ${choiceLabel(reply.profile)}`,
      value: "",
      description:
        reply.profile.model === undefined
          ? "one named bundle of this session's settings"
          : `this session's settings · model ${reply.profile.model}`,
      disabled: true,
    })
  }
  if (reply.hostSystemTokens !== undefined) {
    rows.push({
      title: `host system ~${formatTokens(reply.hostSystemTokens)} est (${reply.hostSystemParts ?? 0} parts) · not counted`,
      value: "",
      description: "the request's own system prompt, outside this plugin's budget",
      disabled: true,
    })
  }
  rows.push({
    title: "Switch profile…",
    value: PROFILE_ACTION,
    description: "auto follows the model; base is the plain config; a pin stays until you pick auto",
  })
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

/**
 * How old a reply's record must be before the panel says so.
 *
 * The sidebar always carries the line (it took the slot of the host-system size,
 * which the glance did not need). The panel is opened on purpose and usually
 * reads a record written seconds ago, where "measured just now" is only noise;
 * it shows the line once a minute has passed without a write.
 */
export const PANEL_MEASURED_STALE_MS = 60_000

/**
 * How old a reply's numbers are, in words a narrow block can hold.
 *
 * Coarse on purpose: the line exists to make a frozen mirror visible, not to be
 * a stopwatch, and rounding down keeps "1m ago" from appearing at 61 seconds.
 */
export function ageLabel(ageMs: number): string {
  const ms = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0
  if (ms < 5_000) return "just now"
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

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
  /**
   * Push the LAST span to the right edge of the block; every span before it
   * stays together on the left. That is how a header's version and a budget
   * line's numbers reach the block's own border whatever the sidebar's width is.
   *
   * Only a renderer can do that (it is a layout, not a byte), and it has to be a
   * spacer rather than `space-between`: a budget line has four spans and
   * `space-between` would pull the label, the filled cells and the empty cells
   * apart too. `sidebarText` falls back to a single space where the gap would
   * stretch.
   */
  readonly spread?: boolean
}

/** The widest value and cap across the two budgets, in characters. */
interface MeterWidths {
  readonly value: number
  readonly cap: number
}

/**
 * The widths both budget lines pad to, measured over the pair rather than one
 * line at a time: that is what puts `18k` and `124k` on the same right edge.
 */
function meterWidths(reply: StatsReply): MeterWidths {
  const value = Math.max(formatTokens(reply.memoryTokens).length, formatTokens(reply.workingTokens).length)
  const cap = Math.max(formatTokens(reply.memoryCap).length, formatTokens(reply.workingCap).length)
  return { value, cap }
}

/**
 * The numbers after a bar: a one-cell gutter that carries the over-cap `*`, the
 * value right-aligned so both lines line up digit to digit, then ` / ` and the
 * cap (also right-aligned). The star takes the gutter rather than the end of the
 * line so it never shifts the digits it marks.
 */
function meterNumbers(value: number, cap: number, over: boolean, widths: MeterWidths): string {
  const valueText = formatTokens(value).padStart(widths.value)
  const capText = formatTokens(cap).padStart(widths.cap)
  return `${over ? "*" : " "}${valueText} / ${capText}`
}

/**
 * One budget line: the label and the bar stay left, the numbers go to the right
 * edge.
 *
 * `spread` is what asks for that: the renderer keeps everything before the last
 * span together and lets the gap before it absorb the width, so the numbers sit
 * on the block's own right border rather than where a guess puts them. That is
 * also why the bar is a fixed length - the slack lives between the bar and the
 * numbers, and a longer bar would eat into it.
 */
function meterLine(label: string, value: number, cap: number, over: boolean, widths: MeterWidths): SidebarLine {
  const { filled, empty } = statusBarParts(value, cap)
  return {
    spread: true,
    spans: [
      { text: `${label} `, tone: "muted" },
      { text: filled, tone: over ? "alert" : "meter" },
      { text: empty, tone: "muted" },
      { text: ` ${meterNumbers(value, cap, over, widths)}`, tone: over ? "alert" : "value" },
    ],
  }
}

/**
 * The sidebar's block: a title, the two budgets, two count lines and how old the
 * numbers are.
 *
 * Deliberately nothing that grows with the session: no gists, no notice text, no
 * archive list. Those live behind the dialog, where the user asked for them.
 * Over cap is painted as a warning on the working line only - `workingTokens`
 * includes the current turn, which is always kept, so a long turn sits over cap
 * by design and a red block would be crying wolf.
 *
 * The host-system size is not here: it is outside this plugin's budget and the
 * glance cannot act on it, so its line carries the freshness instead. The dialog
 * and the panel still print it.
 */
export function sidebarLines(reply: StatsReply): SidebarLine[] {
  const widths = meterWidths(reply)
  const title: StatusSpan = { text: PRODUCT_NAME, tone: "title" }
  const lines: SidebarLine[] = [
    // A header: the name against the left edge, the build against the right one.
    // `spread` asks the renderer for that edge-to-edge layout, so the version
    // lands at the sidebar's own width instead of at a number guessed here.
    reply.version === undefined
      ? { spans: [title] }
      : { spans: [title, { text: `v${reply.version}`, tone: "muted" }], spread: true },
    meterLine("mem", reply.memoryTokens, reply.memoryCap, reply.memoryTokens > reply.memoryCap, widths),
    meterLine("win", reply.workingTokens, reply.workingCap, reply.overBudget, widths),
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
  if (reply.profile !== undefined) {
    // Right under the header: the one setting the glance can act on, and the
    // `[profile]` target below switches it. `base` is still worth saying, because
    // it is the answer to "which bundle is this session on?".
    lines.splice(1, 0, { spans: [{ text: `profile ${choiceLabel(reply.profile)}`, tone: "muted" }] })
  }
  if (reply.ageMs !== undefined) {
    // This line took the slot the host-system size used to occupy: a size the
    // glance cannot act on was less useful than knowing how old the numbers are.
    lines.push({
      spans: [{ text: `measured ${ageLabel(reply.ageMs)}`, tone: "muted" }],
    })
  }
  return lines
}

/**
 * The whole block as plain text, which is what a test can compare.
 *
 * A `spread` line is a layout, not a string: with no width to stretch across,
 * this joins the left spans with nothing and puts one space where the flexible
 * gap sits ("Mega Smart Context v0.1.30", "mem ████░░ 18.5k / 36k"), the same
 * way it looks when the renderer has no room to push the last span right.
 */
export function sidebarText(reply: StatsReply): string {
  return sidebarLines(reply).map(flatLine).join("\n")
}

/** One line with its spans joined, and the stretch rendered as a single space. */
function flatLine(line: SidebarLine): string {
  const texts = line.spans.map((span) => span.text)
  if (line.spread !== true || texts.length < 2) return texts.join("")
  return `${texts.slice(0, -1).join("")} ${texts[texts.length - 1]}`
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
  const widths = meterWidths(reply)
  const budget: PanelRow[] = [
    {
      spans: meterLine("mem", reply.memoryTokens, reply.memoryCap, reply.memoryTokens > reply.memoryCap, widths)
        .spans,
    },
    {
      spans: meterLine("win", reply.workingTokens, reply.workingCap, reply.overBudget, widths).spans,
    },
  ]
  if (reply.profile !== undefined) {
    const spans: StatusSpan[] = [{ text: `profile ${choiceLabel(reply.profile)}`, tone: "value" }]
    if (reply.profile.model !== undefined) spans.push({ text: ` · model ${reply.profile.model}`, tone: "muted" })
    if (reply.profile.source === "pin") spans.push({ text: " · pinned until you pick auto", tone: "muted" })
    budget.push({ spans })
  }
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
  if (reply.ageMs !== undefined && reply.ageMs >= PANEL_MEASURED_STALE_MS) {
    budget.push({
      spans: [{ text: `measured ${ageLabel(reply.ageMs)}`, tone: "muted" }],
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


/**
 * The TUI status dialog: what the server half reports about one session, and how
 * a reply becomes dialog rows.
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
import { budgetOf } from "./prompts.ts"
import type { SessionRecord } from "./types.ts"

/** The RPC id both halves agree on; the host routes `rpc.<id>.<method>`. */
export const STATUS_RPC_ID = "mega-smart-context"

/** The two actions the dialog offers below the status rows. */
export const RESUME_ACTION = "resume"
export const PURGE_ACTION = "purge"

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
  readonly hostSystemTokens?: number
  readonly hostSystemParts?: number
  readonly pending: ReadonlyArray<StatusTurn>
  readonly archive: ReadonlyArray<StatusTurn>
}

export interface PurgeRequest {
  readonly sessionID: string
  readonly turn: string
}

export interface PurgeReply {
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
    typeof value.raw === "boolean"
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
  if (value.hostSystemTokens !== undefined && !isCount(value.hostSystemTokens)) return false
  if (value.hostSystemParts !== undefined && !isCount(value.hostSystemParts)) return false
  if (!Array.isArray(value.pending) || !value.pending.every(isTurn)) return false
  if (!Array.isArray(value.archive) || !value.archive.every(isTurn)) return false
  return true
}

export function isPurgeReply(value: unknown): value is PurgeReply {
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
    ...(report.hostSystemTokens === undefined ? {} : { hostSystemTokens: report.hostSystemTokens }),
    ...(report.hostSystemParts === undefined ? {} : { hostSystemParts: report.hostSystemParts }),
    pending: record.pending.map((turn) => ({
      id: turn.id,
      gist: turn.gist,
      raw: turn.messages !== undefined,
    })),
    archive: record.archive.map((turn) => ({
      id: turn.id,
      gist: turn.gist,
      raw: turn.messages !== undefined,
    })),
  }
}

/** A ten-cell bar. Over-cap fills every cell rather than overflowing the width. */
export function statusBar(value: number, cap: number): string {
  const ratio = cap > 0 && Number.isFinite(value) ? Math.max(0, value / cap) : 0
  const filled = Math.min(STATUS_BAR_WIDTH, Math.round(ratio * STATUS_BAR_WIDTH))
  return "█".repeat(filled) + "░".repeat(STATUS_BAR_WIDTH - filled)
}

function count(value: number): string {
  return value === 1 ? "1" : String(value)
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

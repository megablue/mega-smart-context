/**
 * The read-only tool usage report.
 *
 * Tool usage is measured, never enforced. The module counts completed calls per
 * project, keeps a per-session cursor so a replayed request is a no-op, and
 * renders what the model has and has not used. It never stores arguments,
 * output, paths, commands or user text: a tool name, an outcome and a time are
 * the whole record.
 *
 * The cursor is written in place on the session record, after the project write.
 * The caller already owns the session lock (a context pass loads and saves the
 * record), so a second `SessionStore.mutate` here would deadlock or race the
 * caller's save. On a project conflict the cursor is left alone; the usage-fold
 * keys make the replay safe.
 */

import { createHash } from "node:crypto"

import {
  SESSIONS_SEEN_MAX,
  TOOL_COUNTER_MAX,
  TOOL_NAME_MAX,
  TOOL_SESSIONS_MAX,
  TOOL_UNUSED_MAX,
  TOOL_USAGE_MAX,
  USAGE_SEEN_MAX,
  emptyToolUsage,
  type ProjectKey,
  type ProjectRecord,
  type ProjectToolUsage,
} from "./project.ts"
import { pairToolCalls } from "./tool-calls.ts"
import { messageOf, type Message, type SessionRecord } from "./types.ts"
import { turnSpans, type TurnSpan } from "./view.ts"

/** How many completed turns the first fold backfills. */
export const TOOL_USAGE_BACKFILL = 20
/** Used rows shown before `all:true`. */
export const TOOL_USAGE_REPORT_LIMIT = 10
/** Unused prompts required before a tool is reported as removable. */
export const TOOL_USAGE_UNUSED_PROMPTS = 10
/** Distinct sessions required before a tool is reported as removable. */
export const TOOL_USAGE_UNUSED_SESSIONS = 5

/**
 * Tools whose removal needs twice the evidence: a destructive or broad tool is
 * worth keeping even when the counts look idle.
 */
export const HIGH_RISK_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "write",
  "edit",
  "patch",
  "multiedit",
  "delete",
  "remove",
  "rm",
  "mv",
  "kill",
])

/** The session fields this module owns; `SessionRecord` is not edited here. */
export interface ToolUsageSession {
  /** The newest completed turn whose usage is folded, and when. */
  toolsFolded?: { turn: string; at: number }
  /** The tool names the host offered in this session, for the never-used list. */
  offeredTools?: string[]
}

/** One tool's completed calls inside one prompt-turn. */
export interface ToolUsageTurnCount {
  readonly name: string
  readonly calls: number
  readonly ok: number
  readonly failed: number
}

/** A completed prompt-turn and the tools it called; no raw content. */
export interface ToolUsageTurn {
  readonly id: string
  readonly tools: ReadonlyArray<ToolUsageTurnCount>
}

/** The minimal project-store shape; `ProjectStore` satisfies it. */
export interface ToolUsageProjectStore {
  mutate<T>(project: ProjectKey, fn: (record: ProjectRecord) => T | Promise<T>): Promise<T>
}

export interface FoldToolUsageOptions {
  /** The project store; one `mutate` per fold, under the project lock. */
  readonly store: ToolUsageProjectStore
  /** The project key the usage belongs to. */
  readonly key: ProjectKey
  /** The session id: the hash salt for `sessionMarks` and the usage key. */
  readonly sessionID: string
  /** Fold time, or a clock for a `ProjectSessionDeps` spread; defaults to `Date.now()`. */
  readonly now?: number | (() => number)
  readonly warn?: (line: string) => void
}

export interface ApplyToolUsageOptions {
  readonly sessionID: string
  readonly now?: number
}

function normalizeToolName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").slice(0, TOOL_NAME_MAX)
}

/** A stable short session mark; the full id never enters the project record. */
export function sessionMark(sessionID: string): string {
  return createHash("sha256").update(sessionID).digest("hex").slice(0, 16)
}

/**
 * Remember the tool names the host offered this session. The context event is
 * the only place those names exist, and `/context tools` has no event, so the
 * normalized list rides on the session record until the next save.
 */
export function noteOfferedTools(
  session: SessionRecord & ToolUsageSession,
  offered: ReadonlyArray<string>,
): void {
  session.offeredTools = normalizeOffered(offered).slice(0, TOOL_USAGE_MAX)
}

/** Count the completed calls in one slice of messages, grouped by tool name. */
export function toolUsageCounts(messages: ReadonlyArray<Message>): ToolUsageTurnCount[] {
  const counts = new Map<string, { calls: number; ok: number; failed: number }>()
  for (const pair of pairToolCalls(messages)) {
    const name = normalizeToolName(pair.name)
    if (name.length === 0) continue
    const entry = counts.get(name) ?? { calls: 0, ok: 0, failed: 0 }
    entry.calls += 1
    if (pair.ok) entry.ok += 1
    else entry.failed += 1
    counts.set(name, entry)
  }
  return [...counts].map(([name, entry]) => ({ name, ...entry }))
}

/** The completed turns and their tool counts, newest turn last. */
export function toolUsageTurns(messages: ReadonlyArray<Message>): ToolUsageTurn[] {
  return turnSpans(messages).map((span) => ({
    id: span.id,
    tools: toolUsageCounts(messages.slice(span.startIdx, span.endIdx + 1)),
  }))
}

function completeTurns(messages: ReadonlyArray<Message>): TurnSpan[] {
  const spans = turnSpans(messages)
  return spans.length < 2 ? [] : spans.slice(0, -1)
}

function addSeen(list: string[], key: string, max: number): string[] {
  const next = list.includes(key) ? list : [...list, key]
  return next.length > max ? next.slice(-max) : next
}

/**
 * Fold turns into a project record, in order. A turn whose usage key is already
 * in `envelope.usageSeen` is skipped, so replaying a request is a no-op.
 *
 * Unused prompts are a sweep over the rows that already exist: every recorded
 * tool that the turn did not call gains one, and a tool the turn called resets
 * to zero. A tool first seen in a later turn was not offered before it existed,
 * so it starts at zero rather than inheriting the sweep.
 */
export function applyToolUsage(
  record: ProjectRecord,
  turns: ReadonlyArray<ToolUsageTurn>,
  options: ApplyToolUsageOptions,
): number {
  const now = options.now ?? Date.now()
  const mark = sessionMark(options.sessionID)
  let folded = 0

  for (const turn of turns) {
    const usageKey = mark + "|" + turn.id
    if (record.envelope.usageSeen.includes(usageKey)) continue

    const called = new Map<string, ToolUsageTurnCount>()
    for (const tool of turn.tools) {
      const name = normalizeToolName(tool.name)
      if (name.length === 0 || tool.calls <= 0) continue
      const existing = called.get(name)
      if (existing === undefined) {
        called.set(name, { name, calls: tool.calls, ok: tool.ok, failed: tool.failed })
      } else {
        called.set(name, {
          name,
          calls: existing.calls + tool.calls,
          ok: existing.ok + tool.ok,
          failed: existing.failed + tool.failed,
        })
      }
    }

    for (const [name, row] of Object.entries(record.toolUsage)) {
      if (name === "(other)" || called.has(name)) continue
      row.unusedPrompts = Math.min(TOOL_UNUSED_MAX, row.unusedPrompts + 1)
    }

    for (const [name, tool] of called) {
      const row = record.toolUsage[name] ?? emptyToolUsage()
      row.calls = Math.min(TOOL_COUNTER_MAX, row.calls + tool.calls)
      row.ok = Math.min(TOOL_COUNTER_MAX, row.ok + tool.ok)
      row.failed = Math.min(TOOL_COUNTER_MAX, row.failed + tool.failed)
      row.prompts = Math.min(TOOL_COUNTER_MAX, row.prompts + 1)
      row.unusedPrompts = 0
      row.lastAt = now
      if (!row.sessionMarks.includes(mark) && row.sessionMarks.length < TOOL_SESSIONS_MAX) {
        row.sessionMarks.push(mark)
      }
      row.sessions = Math.min(TOOL_SESSIONS_MAX, Math.max(row.sessions, row.sessionMarks.length))
      record.toolUsage[name] = row
    }

    record.envelope.promptTurns = Math.min(TOOL_COUNTER_MAX, record.envelope.promptTurns + 1)
    record.envelope.usageSeen = addSeen(record.envelope.usageSeen, usageKey, USAGE_SEEN_MAX)
    record.envelope.sessionsSeen = addSeen(record.envelope.sessionsSeen, mark, SESSIONS_SEEN_MAX)
    folded += 1
  }

  return folded
}

/**
 * Fold the completed turns that the session cursor has not seen.
 *
 * Returns true when at least one new turn was folded. No completed turn (a
 * one-turn conversation), a cursor already at the newest turn, or a lost cursor
 * all return false. A lost cursor re-anchors on the newest completed turn and
 * folds nothing, so a transcript that was trimmed cannot replay old counts.
 */
export async function foldToolUsage(
  session: SessionRecord & ToolUsageSession,
  messages: ReadonlyArray<Message>,
  options: FoldToolUsageOptions,
): Promise<boolean> {
  const now = typeof options.now === "function" ? options.now() : options.now ?? Date.now()
  const warn = options.warn ?? (() => {})
  const complete = completeTurns(messages)
  if (complete.length === 0) return false

  const newest = complete[complete.length - 1].id
  const cursor = session.toolsFolded
  if (cursor?.turn === newest) return false

  let selected: TurnSpan[]
  let reanchor = false
  if (cursor === undefined) {
    selected = complete.slice(-TOOL_USAGE_BACKFILL)
  } else {
    const index = complete.findIndex((span) => span.id === cursor.turn)
    if (index < 0) {
      reanchor = true
      selected = []
    } else {
      selected = complete.slice(index + 1)
    }
  }

  const turns: ToolUsageTurn[] = selected.map((span) => ({
    id: span.id,
    tools: toolUsageCounts(messages.slice(span.startIdx, span.endIdx + 1)),
  }))

  let folded = 0
  if (turns.length > 0) {
    try {
      folded = await options.store.mutate(options.key, (record) =>
        applyToolUsage(record, turns, { sessionID: options.sessionID, now }),
      )
    } catch (error) {
      // Project write first: a conflict leaves the cursor where it was, so the
      // next pass retries. The usage keys make a partially applied fold a no-op.
      warn("tool usage fold failed; the session cursor is unchanged: " + messageOf(error))
      return false
    }
  }

  // Session cursor second: the caller's own save persists it. On a project
  // failure above this line is never reached.
  session.toolsFolded = { turn: newest, at: now }
  if (reanchor) return false
  return folded > 0
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** A compact age: `just now`, `3m`, `2h`, `5d`, `2mo`, `1y`. */
export function toolAgeLabel(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return "never"
  const delta = Math.max(0, now - at)
  if (delta < 60_000) return "just now"
  if (delta < 60 * 60_000) return Math.floor(delta / 60_000) + "m"
  if (delta < DAY) return Math.floor(delta / (60 * 60_000)) + "h"
  if (delta < 30 * DAY) return Math.floor(delta / DAY) + "d"
  if (delta < YEAR) return Math.floor(delta / MONTH) + "mo"
  return Math.floor(delta / YEAR) + "y"
}

function normalizeOffered(offered: ReadonlyArray<string>): string[] {
  const seen = new Set<string>()
  for (const raw of offered) {
    const name = normalizeToolName(raw)
    if (name.length > 0) seen.add(name)
  }
  return [...seen].sort((left, right) => left.localeCompare(right))
}

function usedRows(record: ProjectRecord): Array<[string, ProjectToolUsage]> {
  return Object.entries(record.toolUsage)
    .filter(([, usage]) => usage.calls > 0)
    .sort((left, right) => right[1].lastAt - left[1].lastAt || left[0].localeCompare(right[0]))
}

function isHighRisk(name: string): boolean {
  return HIGH_RISK_TOOLS.has(name.toLowerCase())
}

function unusedRows(record: ProjectRecord): Array<[string, ProjectToolUsage]> {
  return usedRows(record)
    .filter(([name, usage]) => {
      const prompts = isHighRisk(name) ? TOOL_USAGE_UNUSED_PROMPTS * 2 : TOOL_USAGE_UNUSED_PROMPTS
      const sessions = isHighRisk(name) ? TOOL_USAGE_UNUSED_SESSIONS * 2 : TOOL_USAGE_UNUSED_SESSIONS
      return usage.unusedPrompts >= prompts || usage.sessions >= sessions
    })
    .sort(
      (left, right) =>
        right[1].unusedPrompts - left[1].unusedPrompts ||
        right[1].sessions - left[1].sessions ||
        left[0].localeCompare(right[0]),
    )
}

function neverUsed(record: ProjectRecord, offered: ReadonlyArray<string>): string[] {
  return offered.filter((name) => record.toolUsage[name] === undefined)
}

function rowLine(name: string, usage: ProjectToolUsage, now: number, width: number): string {
  return (
    "  " +
    name.padEnd(width) +
    "  " +
    usage.calls +
    " calls (" +
    usage.ok +
    ", " +
    usage.failed +
    ") · " +
    usage.prompts +
    " prompts · " +
    usage.sessions +
    " sessions · last " +
    toolAgeLabel(usage.lastAt, now)
  )
}

/**
 * Render the report. `all` lifts the used-row limit from 10 to 64; the unused and
 * never-used sections are not truncated.
 */
export function toolUsageReport(
  record: ProjectRecord,
  offered: ReadonlyArray<string> = [],
  now = Date.now(),
  all = false,
): string {
  const names = normalizeOffered(offered)
  const used = usedRows(record)
  const unused = unusedRows(record)
  const never = neverUsed(record, names)
  const visible = used.slice(0, all ? TOOL_USAGE_MAX : TOOL_USAGE_REPORT_LIMIT)
  const hidden = used.length - visible.length
  const width = Math.min(24, Math.max(4, ...used.map(([name]) => name.length), ...names.map((name) => name.length)))
  const lines: string[] = [
    "tool usage · " +
      record.root +
      " · " +
      record.envelope.promptTurns +
      " prompts · " +
      record.envelope.sessionsSeen.length +
      " sessions · measured " +
      toolAgeLabel(record.updatedAt, now),
  ]

  if (used.length === 0) {
    lines.push("no tool calls recorded yet")
  } else {
    for (const [name, usage] of visible) lines.push(rowLine(name, usage, now, width))
    if (hidden > 0) lines.push("  " + hidden + " more used tool(s) · /context tools all")
  }

  if (unused.length > 0) {
    lines.push("unused (10+ prompts or 5 sessions; high-risk thresholds doubled)")
    for (const [name, usage] of unused) {
      lines.push(rowLine(name, usage, now, width) + " · " + usage.unusedPrompts + " unused")
    }
  } else if (used.length > 0) {
    lines.push("no unused tools")
  }

  if (never.length > 0) {
    lines.push("never used (offered, no completed call)")
    for (const name of never) lines.push("  " + name)
  } else if (names.length > 0) {
    lines.push("every offered tool has been used")
  }

  return lines.join("\n")
}

export interface ToolUsageSummary {
  /** Recorded tools with at least one completed call; `(other)` is not a tool. */
  used: number
  /** Distinct names the host offered. */
  offered: number
  /** Offered names with no completed call; omitted when nothing was offered. */
  unused?: number
  /** Completed prompt-turns folded. */
  prompts: number
  /** Distinct sessions that folded usage, capped by the project record. */
  sessions: number
}

/** The status-line summary; never-used names only make sense with an offer list. */
export function toolSummaryOf(
  record: ProjectRecord,
  offered: ReadonlyArray<string> = [],
  _now = Date.now(),
): ToolUsageSummary {
  const names = normalizeOffered(offered)
  const used = Object.entries(record.toolUsage).filter(([name, usage]) => name !== "(other)" && usage.calls > 0).length
  const summary: ToolUsageSummary = {
    used,
    offered: names.length,
    prompts: record.envelope.promptTurns,
    sessions: record.envelope.sessionsSeen.length,
  }
  if (names.length > 0) summary.unused = neverUsed(record, names).length
  return summary
}

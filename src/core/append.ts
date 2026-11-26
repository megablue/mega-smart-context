/**
 * The append-only layout's record arithmetic.
 *
 * The merged document (`record.memory`) is the source of truth for `read`,
 * `stats` and undo. The request carries a checkpoint (`record.base`) plus one
 * accepted delta per turn (`record.updates`). A patch therefore appends, and the
 * bytes before it stay put; only a compaction replaces the checkpoint.
 *
 * Nothing here renders or measures: this module only mutates a record. That
 * keeps it usable from both the context pass and the memory tool, and keeps the
 * prompt renderer the one place that decides what the model reads.
 *
 * @module mega-smart-context/append
 */

import { MEMORY_FIELDS } from "./schema.ts"
import type { Memory, MemoryUpdate, SessionRecord } from "./types.ts"
import { isPlainObject } from "./types.ts"

const MAP_KEYS: ReadonlySet<string> = new Set(
  MEMORY_FIELDS.filter((field) => field.kind === "map").map((field) => field.key),
)

/** A deep enough copy for the schema: maps and the two object lists. */
export function cloneMemory(memory: Memory): Memory {
  return {
    goal: memory.goal,
    directives: memory.directives.map((directive) => ({ ...directive })),
    plan: memory.plan.map((step) => ({ ...step })),
    facts: { ...memory.facts },
    files: { ...memory.files },
    decisions: { ...memory.decisions },
    open: [...memory.open],
    refs: memory.refs.map((ref) => ({ ...ref })),
    notes: memory.notes,
  }
}

/**
 * Give an append record its checkpoint.
 *
 * A record written by the snapshot layout has only `memory`. The first append
 * pass makes that document the checkpoint; a log without a checkpoint is
 * cleared, because the merged document already contains it. Calling this on an
 * already-migrated record is a no-op.
 */
export function migrateAppend(record: SessionRecord): void {
  if (record.base === undefined) {
    // `memory` is always the merged document. If a log survived without a base
    // (a hand-written record, or a write from before the field existed), the
    // document already contains it; keeping the log would render it twice.
    record.base = cloneMemory(record.memory)
    record.updates = []
  }
  if (record.updates === undefined) record.updates = []
}

/** The document the request renders first: the checkpoint, or the merged memory before migration. */
export function snapshotMemory(record: SessionRecord): Memory {
  return record.base ?? record.memory
}

/** Fold every delta into the checkpoint and clear the log. */
export function checkpointAppend(record: SessionRecord): void {
  record.base = cloneMemory(record.memory)
  record.updates = []
  delete record.compact
}

/**
 * Drop the append fields after a write outside the append layout.
 *
 * A session can switch layouts with a profile. A patch made while the snapshot
 * layout is active updates `memory` but not the log, so the old checkpoint and
 * log are stale. Dropping them makes the next append pass migrate from the
 * merged document instead of rendering a log that no longer describes it.
 */
export function invalidateAppend(record: SessionRecord): void {
  if (
    record.base === undefined &&
    record.updates === undefined &&
    record.windowStart === undefined &&
    record.compact === undefined
  ) {
    return
  }
  delete record.base
  delete record.updates
  delete record.windowStart
  delete record.compact
}

/** The turn the tool call belongs to: the newest turn the last pass kept. */
export function currentTurnOf(record: SessionRecord): string {
  return record.seenTurns.length === 0 ? "" : record.seenTurns[record.seenTurns.length - 1]
}

function clonePatchValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (isPlainObject(item) ? { ...item } : item))
  if (isPlainObject(value)) return { ...value }
  return value
}

function mergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      out[key] = null
      continue
    }
    const previous = out[key]
    if (MAP_KEYS.has(key) && isPlainObject(previous) && isPlainObject(value)) {
      out[key] = { ...previous, ...value }
    } else {
      out[key] = clonePatchValue(value)
    }
  }
  return out
}

/**
 * Append one accepted patch, coalescing repeated writes in the same turn.
 *
 * One block per turn keeps the request compact and the log bounded by the era,
 * not by the number of `patch` calls. The newest value of a repeated map entry
 * wins; a `null` entry stays a deletion.
 */
export function appendUpdate(
  record: SessionRecord,
  patch: Record<string, unknown>,
  turn: string,
  at: number,
): void {
  if (Object.keys(patch).length === 0) return
  if (record.updates === undefined) record.updates = []
  const last = record.updates[record.updates.length - 1]
  if (last !== undefined && last.turn === turn) {
    last.patch = mergePatch(last.patch, patch)
    last.at = at
    return
  }
  record.updates.push({ turn, at, patch: mergePatch({}, patch) })
}

/**
 * The accepted delta between two documents.
 *
 * `applyPatch` reports which top-level keys changed, but not which map entries
 * it rejected. Comparing before and after gives the delta the model actually
 * stored, so an invalid entry cannot reappear in the rendered update. A map is
 * partial (only changed entries; `null` for a deletion); a list or a string is
 * the full new value.
 */
export function acceptedPatch(before: Memory, after: Memory, changed: ReadonlyArray<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of changed) {
    const field = MEMORY_FIELDS.find((candidate) => candidate.key === key)
    if (field === undefined) continue
    if (field.kind === "map") {
      const beforeMap = before[key as "facts" | "files" | "decisions"]
      const afterMap = after[key as "facts" | "files" | "decisions"]
      const delta: Record<string, string | null> = {}
      let any = false
      for (const name of new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])) {
        if (beforeMap[name] === afterMap[name]) continue
        delta[name] = afterMap[name] ?? null
        any = true
      }
      if (any) out[key] = delta
      continue
    }
    if (field.kind === "list") {
      const value = after[key as "plan" | "open" | "refs"]
      out[key] = value.map((item) => (isPlainObject(item) ? { ...item } : item))
      continue
    }
    out[key] = after[key as "goal" | "notes"]
  }
  return out
}

/** Run a log entry through the same parser the renderer uses. */
export function normalizeUpdate(value: unknown): MemoryUpdate | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.turn !== "string") return undefined
  if (!isPlainObject(value.patch)) return undefined
  return {
    turn: value.turn,
    at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
    patch: value.patch,
  }
}

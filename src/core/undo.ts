/**
 * Undo: make the plugin's own state follow the host's revert.
 *
 * `/undo` in OpenCode stages a revert and commits it on the next prompt. The
 * commit deletes the boundary user message and every row after it, then emits
 * `session.revert.committed` with `{ sessionID, to }`. The plugin's record lives
 * in its own KV entry, so nothing in the host's deletion touches it — without
 * this module an undone turn would leave its memory writes, its archived turns
 * and its pending entry behind, and the model would keep reading a record that
 * describes work the transcript no longer contains.
 *
 * The record only ever holds the *current* document, so a rollback is only
 * possible with a journal. One entry per turn captures the previous value of
 * every top-level memory key the model writes, the notices it retires, the turns
 * it purges, and `pending` as it stood before the turn's pass. The journal is
 * bounded: the oldest whole entry is dropped first, so a rollback is exact for
 * the recent turns and best-effort beyond them.
 *
 * Three limits are deliberate, and documented on the feature page:
 *
 * 1. archive trims are not reversible (the raw messages were dropped by the cap);
 * 2. a pending turn whose raw messages are gone cannot be restored;
 * 3. the journal is in the KV record, not the transcript, so a host compaction
 *    never triggers a rollback: only the host's own revert event does.
 *
 * @module mega-smart-context/undo
 */

import { purgeTurn } from "./archive.ts"
import { MEMORY_KEYS } from "./schema.ts"
import type {
  ArchivedTurn,
  LastUndo,
  Memory,
  Notice,
  NoticeSnapshot,
  PendingSnapshot,
  PendingTurn,
  PurgedSnapshot,
  RevertMark,
  SessionRecord,
  UndoEntry,
} from "./types.ts"
import { isPlainObject } from "./types.ts"

/**
 * How many turns the journal keeps.
 *
 * Not a config key: the journal is a safety net for the last few undoable turns,
 * and a fixed cap keeps the record bounded without another knob. `/context`
 * reports the oldest turn still covered.
 */
export const MAX_UNDO_TURNS = 8

/**
 * How many bytes the journal may add to the record.
 *
 * A single turn can touch every key of a full memory document, so the turn bound
 * alone is not enough; this cap drops whole oldest entries until the journal
 * fits. The newest entry always survives, because an undo with no journal at all
 * would be worse than a large one.
 */
export const MAX_UNDO_CHARS = 40_000

/**
 * The pseudo-turn a write gets when no pass has named a turn yet.
 *
 * `""` sorts before every host id, so it can only be restored by being included
 * explicitly — which is what happens: an entry with no turn belongs to the turn
 * in progress and any committed revert unwinds it.
 */
const UNKNOWN_TURN = ""

/** A deep copy, because every captured value must survive later mutation. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sizeOf(entries: ReadonlyArray<UndoEntry>): number {
  return JSON.stringify(entries).length
}

/** What a committed host revert names. */
export interface RevertTarget {
  readonly sessionID: string
  readonly to: string
}

/**
 * Read a host event, returning the revert it commits or `undefined`.
 *
 * Only the committed event counts: a staged revert can still be cleared by
 * `/redo` before a prompt, and nothing in the record should move for a rollback
 * that never happened.
 */
export function revertTarget(event: unknown): RevertTarget | undefined {
  if (!isPlainObject(event) || event.type !== "session.revert.committed") return undefined
  const data = event.data
  if (!isPlainObject(data)) return undefined
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : ""
  const to = typeof data.to === "string" ? data.to : ""
  if (sessionID.length === 0 || to.length === 0) return undefined
  return { sessionID, to }
}

/**
 * Queue a committed revert on the record.
 *
 * The earliest boundary wins: if two commits arrive before a pass, the wider
 * rollback subsumes the narrower one. A no-op returns `false` so the caller can
 * skip a save.
 */
export function queueRevert(record: SessionRecord, to: string, at: number): boolean {
  const current = record.revert
  if (current !== undefined && current.to <= to) return false
  record.revert = { to, at }
  return true
}

/** The journal, or an empty list, without forcing the caller to branch. */
export function undoJournal(record: SessionRecord): UndoEntry[] {
  return record.undo ?? []
}

/** Drop the oldest entries until both caps hold; always keeps at least one. */
function trimEntries(entries: UndoEntry[]): UndoEntry[] | undefined {
  while (entries.length > MAX_UNDO_TURNS) entries.shift()
  while (entries.length > 1 && sizeOf(entries) > MAX_UNDO_CHARS) entries.shift()
  return entries.length === 0 ? undefined : entries
}

/** Trim the record's journal in place. */
export function trimUndo(record: SessionRecord): void {
  if (record.undo === undefined) return
  const next = trimEntries(record.undo)
  if (next === undefined) delete record.undo
  else record.undo = next
}

/**
 * Get this turn's entry, creating it with `pending` as it stands right now.
 *
 * Called at the top of a pass, before the pass can move anything to pending or
 * the archive, and by a write when no pass has run yet. A re-entry for the same
 * turn keeps the original snapshot and the original "before" values.
 */
export function noteTurn(record: SessionRecord, turn: string | undefined, now: number): UndoEntry | undefined {
  const current = turn ?? UNKNOWN_TURN
  const entries = record.undo ?? []
  const last = entries[entries.length - 1]

  // The memory-block line belongs to the turn the rollback landed in; the next
  // turn clears it. This runs on every pass, so it does not depend on a write.
  if (record.lastUndo !== undefined && record.lastUndo.seen !== undefined && record.lastUndo.seen !== current) {
    delete record.lastUndo
  }

  if (last !== undefined && last.turn === current) return last
  // Never journal backwards: a turn older than the newest entry is either a
  // replayed pass (same ids, handled above) or a revert still being applied.
  if (last !== undefined && current !== UNKNOWN_TURN && current < last.turn) return undefined
  if (current === UNKNOWN_TURN) return last

  return pushEntry(record, current, now)
}

function snapshotPending(record: SessionRecord): PendingSnapshot[] {
  return record.pending.map((pending) => ({
    id: pending.id,
    gist: pending.gist,
    chars: pending.chars,
    createdAt: pending.createdAt,
    age: pending.age,
  }))
}

function pushEntry(record: SessionRecord, turn: string, now: number): UndoEntry {
  const entries = record.undo ?? []
  const entry: UndoEntry = { turn, at: now, pending: snapshotPending(record) }
  entries.push(entry)
  record.undo = entries
  trimUndo(record)
  return entry
}

/** This turn's entry, created if a write beats the pass to it. */
function entryFor(record: SessionRecord, now: number): UndoEntry {
  const turn = record.seenTurns.length > 0 ? record.seenTurns[record.seenTurns.length - 1] : undefined
  const existing = noteTurn(record, turn, now)
  if (existing !== undefined) return existing
  const last = record.undo?.[record.undo.length - 1]
  return last ?? pushEntry(record, UNKNOWN_TURN, now)
}

/**
 * Capture the previous values of the memory keys a patch is about to change.
 *
 * `before` is the document *before* the patch. A key already captured this turn
 * keeps its earlier value: two writes in one turn must still undo to the turn's
 * start, not to the midpoint.
 */
export function captureMemory(record: SessionRecord, before: Memory, keys: ReadonlyArray<string>, now: number): void {
  if (keys.length === 0) return
  const entry = entryFor(record, now)
  const memory = entry.memory ?? {}
  let captured = false
  for (const key of keys) {
    if (key in memory) continue
    const value = (before as unknown as Record<string, unknown>)[key]
    if (value === undefined) continue
    memory[key] = clone(value)
    captured = true
  }
  if (captured) {
    entry.memory = memory
    trimUndo(record)
  }
}

/** Remember a notice the model retired, with the slot it occupied. */
export function captureNotice(record: SessionRecord, notice: Notice, index: number, now: number): void {
  const entry = entryFor(record, now)
  entry.notices = [...(entry.notices ?? []), { notice: clone(notice), index }]
  trimUndo(record)
}

/** Remember a turn the model purged, so the undo can put it back whole. */
export function capturePurge(
  record: SessionRecord,
  list: "pending" | "archive",
  entry: PendingTurn | ArchivedTurn,
  index: number,
  now: number,
): void {
  const target = entryFor(record, now)
  target.purged = [...(target.purged ?? []), { list, index, entry: clone(entry) }]
  trimUndo(record)
}

/**
 * Purge one turn and journal it, whichever surface asked.
 *
 * The tool always journaled its purges; `/context purge` and the TUI's purge row
 * went straight to `purgeTurn`, so a later `/undo` could not put those turns
 * back. Keeping the sequence here - look up both lists first, then remove, then
 * capture the entry that vanished - is what makes the gap impossible to reopen
 * from a new surface.
 *
 * Returns whether the turn existed. The caller owns the save, because the three
 * callers persist through the same store but not at the same point in their own
 * flow.
 */
export function purgeWithUndo(record: SessionRecord, turn: string, now: number): boolean {
  const pendingIndex = record.pending.findIndex((entry) => entry.id === turn)
  const archiveIndex = record.archive.findIndex((entry) => entry.id === turn)
  const pendingEntry = pendingIndex < 0 ? undefined : record.pending[pendingIndex]
  const archiveEntry = archiveIndex < 0 ? undefined : record.archive[archiveIndex]
  if (!purgeTurn(record, turn)) return false
  // The whole entry (raw messages included) is kept for the undo: once purged,
  // nothing else in the record can reconstruct it.
  if (pendingEntry !== undefined) capturePurge(record, "pending", pendingEntry, pendingIndex, now)
  else if (archiveEntry !== undefined) capturePurge(record, "archive", archiveEntry, archiveIndex, now)
  return true
}

function restoreMemory(record: SessionRecord, entry: UndoEntry): number {
  const values = entry.memory
  if (values === undefined) return 0
  let restored = 0
  for (const [key, value] of Object.entries(values)) {
    ;(record.memory as unknown as Record<string, unknown>)[key] = clone(value)
    restored += 1
  }
  return restored
}

function restoreNotices(record: SessionRecord, entry: UndoEntry): void {
  for (const snapshot of entry.notices ?? []) {
    const notices = record.notices ?? []
    // Un-retire first: the fold consults `retired` by text, so a notice put back
    // while its retirement survives would be skipped on the very next pass.
    const retired = (record.retired ?? []).filter((candidate) => candidate.text !== snapshot.notice.text)
    if (retired.length > 0) record.retired = retired
    else delete record.retired
    if (notices.some((notice) => notice.text === snapshot.notice.text)) continue
    const index = Math.max(0, Math.min(snapshot.index, notices.length))
    notices.splice(index, 0, clone(snapshot.notice))
    record.notices = notices
  }
}

function restorePurges(record: SessionRecord, entry: UndoEntry): void {
  for (const snapshot of [...(entry.purged ?? [])].reverse()) {
    const target = snapshot.list === "pending" ? record.pending : record.archive
    if (target.some((candidate) => candidate.id === snapshot.entry.id)) continue
    const index = Math.max(0, Math.min(snapshot.index, target.length))
    if (snapshot.list === "pending") {
      record.pending.splice(index, 0, clone(snapshot.entry as PendingTurn))
    } else {
      record.archive.splice(index, 0, clone(snapshot.entry as ArchivedTurn))
    }
  }
}

/**
 * Put `pending` back as it stood at the boundary turn's start.
 *
 * A pending turn is normally still pending (keep its messages) or was archived
 * during the span (take the raw from the archive entry and pull it back out).
 * When neither holds, its raw messages are gone and the entry is counted as
 * lost rather than fabricated.
 */
function restorePending(record: SessionRecord, snapshot: ReadonlyArray<PendingSnapshot> | undefined): number {
  if (snapshot === undefined) return 0
  const current = new Map(record.pending.map((pending) => [pending.id, pending]))
  const archived = new Map(record.archive.map((entry) => [entry.id, entry]))
  const restored: PendingTurn[] = []
  const pulled: string[] = []
  let lost = 0
  for (const item of snapshot) {
    const still = current.get(item.id)
    if (still !== undefined) {
      // Rebuild from the snapshot so the pass's age increment is undone too; the
      // raw messages are the one thing the snapshot deliberately does not hold.
      restored.push({
        id: item.id,
        gist: item.gist,
        chars: item.chars,
        messages: still.messages,
        createdAt: item.createdAt,
        age: item.age,
      })
      continue
    }
    const entry = archived.get(item.id)
    if (entry !== undefined) {
      pulled.push(item.id)
      restored.push({
        id: item.id,
        gist: item.gist,
        chars: item.chars,
        messages: entry.messages === undefined ? [] : clone(entry.messages),
        createdAt: item.createdAt,
        age: item.age,
      })
      continue
    }
    lost += 1
  }
  record.pending = restored
  if (pulled.length > 0) {
    const gone = new Set(pulled)
    record.archive = record.archive.filter((entry) => !gone.has(entry.id))
  }
  return lost
}

/**
 * Apply a committed revert to the record.
 *
 * Memory, notices and purges unwind newest-first, so the boundary turn's entry
 * ends up holding the state as of that turn's start. The structural side is
 * rebuilt from the boundary entry's `pending` snapshot and then every tracked
 * turn at/after the boundary is dropped: `seenTurns`, `pending`, `archive` and
 * the pass history all speak about turns the host has deleted.
 */
export function applyRevert(record: SessionRecord, mark: RevertMark, now: number): LastUndo {
  const entries = record.undo ?? []
  const first = entries.findIndex((entry) => entry.turn === UNKNOWN_TURN || entry.turn >= mark.to)
  const reverted = first < 0 ? [] : entries.slice(first)

  let memory = 0
  for (let index = reverted.length - 1; index >= 0; index -= 1) {
    const entry = reverted[index]
    memory += restoreMemory(record, entry)
    restoreNotices(record, entry)
    restorePurges(record, entry)
  }

  // Count the span's own turns before the restore can move or drop them.
  const dropped =
    record.pending.filter((pending) => pending.id >= mark.to).length +
    record.archive.filter((entry) => entry.id >= mark.to).length
  const lost = restorePending(record, reverted[0]?.pending)
  record.pending = record.pending.filter((pending) => pending.id < mark.to)
  record.archive = record.archive.filter((entry) => entry.id < mark.to)
  record.seenTurns = record.seenTurns.filter((id) => id < mark.to)
  record.history = (record.history ?? []).filter((sample) => sample.turn === undefined || sample.turn < mark.to)

  // Nothing journaled at/after the boundary means nothing older to keep, but the
  // turns before it must stay reversible: only truncate when an entry matched.
  if (first === 0) delete record.undo
  else if (first > 0) record.undo = entries.slice(0, first)

  delete record.revert
  const lastUndo: LastUndo = { turn: mark.to, at: now, memory, turns: reverted.length, dropped, lost }
  record.lastUndo = lastUndo
  return lastUndo
}

/** One line for the debug log after a rollback. */
export function undoLine(undo: LastUndo): string {
  return (
    `undo ${undo.turn}: ${undo.turns} journal turn(s), ${undo.memory} memory key(s) restored, ` +
    `${undo.dropped} turn(s) dropped${undo.lost > 0 ? `, ${undo.lost} not restorable` : ""}`
  )
}

// ---------------------------------------------------------------------------
// Reading the journal back from storage
// ---------------------------------------------------------------------------

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function normalizePendingSnapshot(value: unknown): PendingSnapshot | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.id !== "string" || value.id.length === 0) return undefined
  if (typeof value.gist !== "string") return undefined
  return {
    id: value.id,
    gist: value.gist,
    chars: finite(value.chars),
    createdAt: finite(value.createdAt),
    age: Math.max(0, Math.round(finite(value.age))),
  }
}

function normalizeNotice(value: unknown): Notice | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.id !== "string" || value.id.length === 0) return undefined
  if (typeof value.text !== "string" || value.text.length === 0) return undefined
  return { id: value.id, text: value.text, at: finite(value.at) }
}

function normalizeNoticeSnapshot(value: unknown): NoticeSnapshot | undefined {
  if (!isPlainObject(value)) return undefined
  const notice = normalizeNotice(value.notice)
  if (notice === undefined) return undefined
  return { notice, index: Math.max(0, Math.round(finite(value.index))) }
}

function normalizePurged(value: unknown): PurgedSnapshot | undefined {
  if (!isPlainObject(value)) return undefined
  if (value.list !== "pending" && value.list !== "archive") return undefined
  const entry = value.entry
  if (!isPlainObject(entry)) return undefined
  if (typeof entry.id !== "string" || entry.id.length === 0) return undefined
  if (typeof entry.gist !== "string") return undefined
  const messages = Array.isArray(entry.messages) ? (entry.messages as PendingTurn["messages"]) : []
  const base = {
    id: entry.id,
    gist: entry.gist,
    chars: finite(entry.chars),
    createdAt: finite(entry.createdAt),
  }
  if (value.list === "pending") {
    return {
      list: "pending",
      index: Math.max(0, Math.round(finite(value.index))),
      entry: { ...base, messages, age: Math.max(0, Math.round(finite(entry.age))) },
    }
  }
  const archived: ArchivedTurn = { ...base }
  if (Array.isArray(entry.messages)) archived.messages = messages
  return { list: "archive", index: Math.max(0, Math.round(finite(value.index))), entry: archived }
}

function normalizeUndoEntry(value: unknown): UndoEntry | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.turn !== "string") return undefined
  const entry: UndoEntry = { turn: value.turn, at: finite(value.at) }
  if (Array.isArray(value.pending)) {
    entry.pending = value.pending
      .map(normalizePendingSnapshot)
      .filter((item): item is PendingSnapshot => item !== undefined)
  }
  if (isPlainObject(value.memory)) {
    const memory: Record<string, unknown> = {}
    // Only schema-owned keys: a corrupted journal must not inject a new field
    // into the document the model reads.
    for (const [key, item] of Object.entries(value.memory)) if (MEMORY_KEYS.has(key)) memory[key] = item
    if (Object.keys(memory).length > 0) entry.memory = memory
  }
  if (Array.isArray(value.notices)) {
    entry.notices = value.notices
      .map(normalizeNoticeSnapshot)
      .filter((item): item is NoticeSnapshot => item !== undefined)
  }
  if (Array.isArray(value.purged)) {
    entry.purged = value.purged.map(normalizePurged).filter((item): item is PurgedSnapshot => item !== undefined)
  }
  return entry
}

/** The journal from storage, bounded and defensive; `undefined` when empty. */
export function normalizeUndo(value: unknown): UndoEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries = value.map(normalizeUndoEntry).filter((entry): entry is UndoEntry => entry !== undefined)
  return trimEntries(entries)
}

/** The pending revert marker from storage, or `undefined`. */
export function normalizeRevert(value: unknown): RevertMark | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.to !== "string" || value.to.length === 0) return undefined
  return { to: value.to, at: finite(value.at) }
}

/** The last-undo summary from storage, or `undefined`. */
export function normalizeLastUndo(value: unknown): LastUndo | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.turn !== "string" || value.turn.length === 0) return undefined
  const undo: LastUndo = {
    turn: value.turn,
    at: finite(value.at),
    memory: Math.max(0, Math.round(finite(value.memory))),
    turns: Math.max(0, Math.round(finite(value.turns))),
    dropped: Math.max(0, Math.round(finite(value.dropped))),
    lost: Math.max(0, Math.round(finite(value.lost))),
  }
  if (typeof value.seen === "string") return { ...undo, seen: value.seen }
  return undo
}

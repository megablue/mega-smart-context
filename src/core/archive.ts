/**
 * The cold store for turns that left the working window.
 *
 * The plugin never writes here on its own semantically. It creates a *pending*
 * entry when a turn is evicted, and the model either archives it with a gist
 * (optionally keeping the raw messages) or purges it. With `autoArchive` on, an
 * unhandled pending turn is archived under a mechanical gist so nothing is
 * irrecoverably lost; the model can still purge it afterwards.
 *
 * Retrieval is deliberately gated: `recall` requires `lost: true`, because an
 * archive searched out of habit is a second working set and the whole point is
 * that it is not one.
 *
 * @module mega-smart-context/archive
 */

import { estimateTokens, messageChars } from "./measure.ts"
import type { ArchivedTurn, Message, PendingTurn, SessionRecord } from "./types.ts"
import type { TurnSpan } from "./view.ts"
import { renderTurn } from "./view.ts"

export const DEFAULT_ARCHIVE_MAX_TURNS = 200
export const DEFAULT_ARCHIVE_MAX_CHARS = 400_000

/** What a turn is, in the one line the model sees before deciding. */
export function mechanicalGist(span: TurnSpan, charsPerToken: number): string {
  const user = span.userText.replace(/\s+/g, " ").trim().slice(0, 90) || "(no text)"
  const tools = span.tools.length > 0 ? [...new Set(span.tools)].join(", ") : "no tools"
  const tokens = estimateTokens(span.chars, charsPerToken)
  return `turn ${span.id}: ${user} · tools: ${tools} · ~${tokens} est`
}

/** A turn's raw messages, as the eviction pass saw them. */
export function turnMessages(messages: ReadonlyArray<Message>, span: TurnSpan): Message[] {
  return messages.slice(span.startIdx, span.endIdx + 1).map((message) => ({
    ...message,
    content: (message.content ?? []).map((part) => ({ ...part })),
  }))
}

function charsOfMessages(messages: ReadonlyArray<Message>): number {
  let total = 0
  for (const message of messages) total += messageChars(message)
  return total
}

function findPending(record: SessionRecord, id: string): PendingTurn | undefined {
  return record.pending.find((entry) => entry.id === id)
}

/**
 * Move one pending turn into the archive.
 *
 * @param gist - the model's gist, or the mechanical one the eviction pass wrote.
 * @param keepRaw - whether the raw messages are kept for `expand`. The gist is
 *   always kept; the raw is optional because it is the expensive half.
 * @returns the archived entry, or `undefined` when the id is not pending.
 */
export function archivePending(
  record: SessionRecord,
  id: string,
  gist: string,
  keepRaw: boolean,
  options: { now?: number; maxTurns?: number; maxChars?: number } = {},
): ArchivedTurn | undefined {
  const index = record.pending.findIndex((entry) => entry.id === id)
  if (index < 0) return undefined
  const pending = record.pending[index]
  record.pending.splice(index, 1)

  const text = (gist.trim().length > 0 ? gist.trim() : pending.gist).slice(0, 600)
  const messages = keepRaw ? pending.messages : undefined
  const entry: ArchivedTurn = {
    id: pending.id,
    gist: text,
    chars: text.length + (messages === undefined ? 0 : charsOfMessages(messages)),
    createdAt: options.now ?? Date.now(),
  }
  if (messages !== undefined) entry.messages = messages
  record.archive.push(entry)
  trimArchive(record, options.maxTurns ?? DEFAULT_ARCHIVE_MAX_TURNS, options.maxChars ?? DEFAULT_ARCHIVE_MAX_CHARS)
  return entry
}

/**
 * Archive every pending turn with its mechanical gist and its raw messages.
 *
 * This is the safety net behind `autoArchive`. The model did not get to write a
 * gist, so the gist is mechanical and the raw is kept: a mechanical gist alone
 * would make `expand` impossible and the archive useless.
 */
export function autoArchivePending(
  record: SessionRecord,
  options: { now?: number; maxTurns?: number; maxChars?: number } = {},
): number {
  let archived = 0
  while (record.pending.length > 0) {
    const pending = record.pending[0]
    if (archivePending(record, pending.id, pending.gist, true, options) !== undefined) archived += 1
    else record.pending.shift()
  }
  return archived
}

/** Remove one turn from pending and archive. */
export function purgeTurn(record: SessionRecord, id: string): boolean {
  let removed = false
  const pendingIndex = record.pending.findIndex((entry) => entry.id === id)
  if (pendingIndex >= 0) {
    record.pending.splice(pendingIndex, 1)
    removed = true
  }
  const archiveIndex = record.archive.findIndex((entry) => entry.id === id)
  if (archiveIndex >= 0) {
    record.archive.splice(archiveIndex, 1)
    removed = true
  }
  return removed
}

function matches(entry: ArchivedTurn, query: string): boolean {
  if (entry.gist.toLowerCase().includes(query)) return true
  if (entry.messages === undefined) return false
  return renderTurn(entry.messages, 40_000).toLowerCase().includes(query)
}

/** Remove every archived turn whose gist or raw text matches the query. */
export function purgeQuery(record: SessionRecord, query: string): number {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return 0
  const before = record.archive.length
  record.archive = record.archive.filter((entry) => !matches(entry, needle))
  return before - record.archive.length
}

export function findArchived(record: SessionRecord, id: string): ArchivedTurn | undefined {
  return record.archive.find((entry) => entry.id === id)
}

/** Newest-first matches. `limit` is clamped to 1..20. */
export function recall(record: SessionRecord, query: string, limit = 5): ArchivedTurn[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  const max = Math.min(20, Math.max(1, Math.trunc(limit)))
  const found: ArchivedTurn[] = []
  for (let index = record.archive.length - 1; index >= 0 && found.length < max; index -= 1) {
    if (matches(record.archive[index], needle)) found.push(record.archive[index])
  }
  return found
}

export function archiveChars(record: SessionRecord): number {
  let total = 0
  for (const entry of record.archive) total += entry.chars
  return total
}

/** Keep the archive inside both caps: newest wins. */
export function trimArchive(record: SessionRecord, maxTurns: number, maxChars: number): void {
  while (record.archive.length > Math.max(0, maxTurns)) record.archive.shift()
  while (record.archive.length > 1 && archiveChars(record) > Math.max(10_000, maxChars)) record.archive.shift()
}

/** Is this turn already known to the cold store (pending or archived)? */
export function knows(record: SessionRecord, id: string): boolean {
  return findPending(record, id) !== undefined || findArchived(record, id) !== undefined
}

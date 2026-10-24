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
import { gistText, renderTurnFull } from "./view.ts"

export const DEFAULT_ARCHIVE_MAX_TURNS = 200
export const DEFAULT_ARCHIVE_MAX_CHARS = 400_000

/** What a turn is, in the one line the model sees before deciding. */
export function mechanicalGist(span: TurnSpan, charsPerToken: number): string {
  const user = gistText(span.userText)
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

/**
 * A turn still waiting in the eviction queue.
 *
 * Exported because `expand` reads it: the raw messages are still in the record,
 * so a turn the window dropped is readable before the model decides whether to
 * archive it.
 */
export function findPending(record: SessionRecord, id: string): PendingTurn | undefined {
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

/**
 * Split a recall query into search terms, longest first.
 *
 * Matching a whole query as one contiguous string is a phrase search, and a
 * model that writes `"UnityPy sprite card texture"` about a turn that says
 * "UnityPy" in one place and "texture" in another gets nothing. Every term must
 * match (AND); the order and the gaps do not. Capped so a pasted paragraph does
 * not become a scan.
 */
export function recallTerms(query: string): string[] {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 0),
    ),
  ]
  return terms.sort((a: string, b: string) => b.length - a.length).slice(0, 8)
}

/** Does every term occur in the gist, or every term in the full render? */
function matchesTerms(entry: ArchivedTurn, terms: ReadonlyArray<string>): boolean {
  if (terms.length === 0) return false
  const gist = entry.gist.toLowerCase()
  if (terms.every((term) => gist.includes(term))) return true
  if (entry.messages === undefined) return false
  const text = renderTurnFull(entry.messages).toLowerCase()
  return terms.every((term) => text.includes(term))
}

/** Where a hit was found: a snippet, and the render offset `expand offset:` resumes from. */
export interface RecallSnippet {
  /** Char offset into `expand`'s render; absent when the hit is the gist. */
  readonly offset?: number
  readonly text: string
}

/** One archived turn that matched, with the evidence that made it match. */
export interface RecallHit {
  readonly entry: ArchivedTurn
  readonly snippets: ReadonlyArray<RecallSnippet>
}

/**
 * Up to `max` windows of `radius` characters around the first occurrences of the
 * terms, so a reader can tell whether the turn is worth expanding.
 *
 * The window is raw turn text, not a replay: two non-overlapping windows per
 * match, and the offset is what turns "maybe this one" into one targeted
 * `expand offset:` instead of reading the whole turn.
 */
function snippetsOf(text: string, terms: ReadonlyArray<string>, radius = 120, max = 2): RecallSnippet[] {
  const lower = text.toLowerCase()
  const out: RecallSnippet[] = []
  const taken: Array<readonly [number, number]> = []
  for (const term of terms) {
    let at = lower.indexOf(term)
    while (at >= 0 && out.length < max) {
      const from = Math.max(0, at - radius)
      const to = Math.min(text.length, at + term.length + radius)
      if (taken.some(([start, end]) => from < end && start < to)) {
        at = lower.indexOf(term, at + term.length)
        continue
      }
      taken.push([from, to])
      const window = text.slice(from, to).replace(/\s+/g, " ").trim()
      out.push({ offset: from, text: `${from > 0 ? "…" : ""}${window}${to < text.length ? "…" : ""}` })
      at = lower.indexOf(term, to)
    }
    if (out.length >= max) break
  }
  return out
}

/** Newest-first matches. `limit` is clamped to 1..20. */
export function recall(record: SessionRecord, query: string, limit = 5): RecallHit[] {
  const terms = recallTerms(query)
  if (terms.length === 0) return []
  const max = Math.min(20, Math.max(1, Math.trunc(limit)))
  const found: RecallHit[] = []
  for (let index = record.archive.length - 1; index >= 0 && found.length < max; index -= 1) {
    const entry = record.archive[index]
    if (!matchesTerms(entry, terms)) continue
    const snippets = entry.messages === undefined ? [] : snippetsOf(renderTurnFull(entry.messages), terms)
    found.push({ entry, snippets: snippets.length > 0 ? snippets : [{ text: entry.gist }] })
  }
  return found
}

/**
 * Remove every archived turn whose gist or raw text contains the query phrase.
 *
 * Exact, unlike `recall`: a destructive action must not broaden because a term
 * happened to be common somewhere in a turn.
 */
export function purgeQuery(record: SessionRecord, query: string): number {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return 0
  const before = record.archive.length
  record.archive = record.archive.filter((entry) => !matchesTerms(entry, [needle]))
  return before - record.archive.length
}

export function findArchived(record: SessionRecord, id: string): ArchivedTurn | undefined {
  return record.archive.find((entry) => entry.id === id)
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

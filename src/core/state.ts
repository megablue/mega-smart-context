/**
 * The per-session store: durable through `ctx.storage`, in memory when there is
 * no store or the store fails.
 *
 * Every session — parent or subagent — is an independent key. There is no
 * inheritance and no shared record: a child's goal is its own task, and a
 * parent's memory cannot be read by the child or written by it.
 *
 * The store is deliberately small. It holds the memory document, the turn ids
 * the last pass kept (so the next pass knows what left the window), the pending
 * evictions and the archive. The raw transcript is never stored here; it comes
 * from the host on every request.
 *
 * @module mega-smart-context/state
 */

import { emptyMemory, normalizeMemory } from "./schema.ts"
import type { ArchivedTurn, Notice, PassSample, PendingTurn, RetiredNotice, SessionRecord, StoragePort } from "./types.ts"
import { isPlainObject, messageOf } from "./types.ts"
import { normalizeLastUndo, normalizeRevert, normalizeUndo } from "./undo.ts"

/** How many sessions the store keeps before the oldest is evicted. */
export const MAX_SESSIONS = 64

/**
 * How many context passes a session record keeps in `history`.
 *
 * Not a config key: the samples are diagnostics, and a per-session cap keeps the
 * record bounded without a second knob. The first sample is always kept — it is
 * the cheap full-arc baseline the analyzer measures growth against.
 */
export const MAX_HISTORY = 200

/**
 * How many distinct host notices a session record pins.
 *
 * Not a config key: the list is a handful of short notices, and a fixed cap keeps
 * the record bounded without a second knob. The oldest non-newest entries are
 * dropped first, so the live instruction always survives.
 */
export const MAX_NOTICES = 8

/** A notice longer than this is head-kept, with a marker, before it is stored. */
export const MAX_NOTICE_CHARS = 4000

/**
 * How many retired notices a record remembers.
 *
 * Not a config key: a retirement is a handful of bytes and clears itself as soon
 * as the host emits the text again under a new id, so the cap only bounds a list
 * that keeps growing without one.
 */
export const MAX_RETIRED = 32

const NOTICE_TRUNCATION_MARKER = "\n… [truncated] …"

const KEY_PREFIX = "session/"

export interface StoreOptions {
  readonly warn?: (line: string) => void
  readonly now?: () => number
  /** Stamped onto records this instance writes, for the startup sweep. */
  readonly directory?: string
}

/** What the host's `session.get` proved about a record's session. */
export type SessionLiveness = "alive" | "gone" | "unknown"

export interface PruneReport {
  removed: number
  kept: number
  skipped: number
  failed: number
}

function keyOf(sessionID: string): string {
  return KEY_PREFIX + sessionID
}

/** Compare two directory spellings the host may report with either slash. */
export function sameDirectory(left: string, right: string): boolean {
  const fold = (value: string): string => value.replaceAll("\\", "/").replace(/\/+$/u, "")
  return fold(left) === fold(right)
}

function normalizePending(value: unknown): PendingTurn | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.id !== "string" || value.id.length === 0) return undefined
  if (typeof value.gist !== "string") return undefined
  const messages = Array.isArray(value.messages) ? (value.messages as PendingTurn["messages"]) : []
  return {
    id: value.id,
    gist: value.gist,
    chars: typeof value.chars === "number" && Number.isFinite(value.chars) ? value.chars : 0,
    messages,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    age: typeof value.age === "number" && Number.isFinite(value.age) ? Math.max(0, Math.round(value.age)) : 0,
  }
}

function normalizeArchived(value: unknown): ArchivedTurn | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.id !== "string" || value.id.length === 0) return undefined
  if (typeof value.gist !== "string") return undefined
  const entry: ArchivedTurn = {
    id: value.id,
    gist: value.gist,
    chars: typeof value.chars === "number" && Number.isFinite(value.chars) ? value.chars : 0,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
  }
  if (Array.isArray(value.messages)) return { ...entry, messages: value.messages as ArchivedTurn["messages"] }
  return entry
}

/** Coerce a stored pass sample, dropping anything without a usable timestamp. */
function normalizeSample(value: unknown): PassSample | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined
  const number = (field: unknown): number => (typeof field === "number" && Number.isFinite(field) ? field : 0)
  const sample: PassSample = {
    at: value.at,
    transcriptTokens: number(value.transcriptTokens),
    policyTokens: number(value.policyTokens),
    memoryTokens: number(value.memoryTokens),
    workingTokens: number(value.workingTokens),
    totalTokens: number(value.totalTokens),
    workingTurns: number(value.workingTurns),
    droppedTurns: number(value.droppedTurns),
    overBudget: value.overBudget === true,
  }
  if (typeof value.turn === "string") sample.turn = value.turn
  if (typeof value.noticeTokens === "number" && Number.isFinite(value.noticeTokens)) {
    sample.noticeTokens = value.noticeTokens
  }
  if (typeof value.modelContext === "number" && Number.isFinite(value.modelContext)) {
    sample.modelContext = value.modelContext
  }
  return sample
}

/** The pass history, or `undefined` when the record has none (a pre-history record). */
function normalizeHistory(value: unknown): PassSample[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(normalizeSample).filter((entry): entry is PassSample => entry !== undefined)
}

/**
 * Keep the first sample (the full-arc baseline) and the newest `MAX_HISTORY - 1`.
 */
export function trimHistory(history: PassSample[]): PassSample[] {
  if (history.length <= MAX_HISTORY) return history
  return [history[0], ...history.slice(history.length - (MAX_HISTORY - 1))]
}

/** Keep the head of an over-long notice so one hostile row cannot bloat the record. */
function headKeepNotice(text: string): string {
  if (text.length <= MAX_NOTICE_CHARS) return text
  return text.slice(0, MAX_NOTICE_CHARS) + NOTICE_TRUNCATION_MARKER
}

/** Coerce a stored notice, dropping anything without an id and usable text. */
function normalizeNotice(value: unknown): Notice | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.id !== "string" || value.id.length === 0) return undefined
  if (typeof value.text !== "string" || value.text.trim().length === 0) return undefined
  return {
    id: value.id,
    text: value.text,
    at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
  }
}

/** The pinned notices, or `undefined` when the record has none (a pre-notice record). */
function normalizeNotices(value: unknown): Notice[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const out: Notice[] = []
  for (const entry of value) {
    const notice = normalizeNotice(entry)
    if (notice === undefined || seen.has(notice.text)) continue
    seen.add(notice.text)
    out.push(notice)
  }
  return out.length > MAX_NOTICES ? out.slice(out.length - MAX_NOTICES) : out
}

/** A retired notice, or `undefined` when the record has none. */
function normalizeRetired(value: unknown): RetiredNotice | undefined {
  if (!isPlainObject(value)) return undefined
  if (typeof value.id !== "string" || value.id.length === 0) return undefined
  if (typeof value.text !== "string" || value.text.length === 0) return undefined
  return { id: value.id, text: value.text }
}

/** The retirements, or `undefined` when the record has none. */
function normalizeRetiredList(value: unknown): RetiredNotice[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const out: RetiredNotice[] = []
  for (const entry of value) {
    const retired = normalizeRetired(entry)
    if (retired === undefined || seen.has(retired.id + "\u0000" + retired.text)) continue
    seen.add(retired.id + "\u0000" + retired.text)
    out.push(retired)
  }
  return out.length > MAX_RETIRED ? out.slice(out.length - MAX_RETIRED) : out
}

/** The result of folding one pass's notices into a record. */
export interface NoticeFold {
  /** The pinned notices, oldest first, bounded by `MAX_NOTICES`. */
  notices: Notice[]
  /** The retirements still live after the fold, bounded by `MAX_RETIRED`. */
  retired: RetiredNotice[]
}

/**
 * Fold the notices found in one pass into the record's list.
 *
 * Dedupe is by exact text: the host re-sends the same notice on every request
 * while a mode is active, so a re-run must not append a second copy, and `at`
 * never moves. The id does move — to the newest occurrence in the transcript —
 * because that is the generation a retirement is checked against.
 *
 * Order is recency, not first sight: the host emits the same two texts all
 * session, so first-sight order freezes and the rail ends up protecting a stale
 * instruction. Re-seeing a text moves it to the end, so the last entry is the
 * one the host emitted most recently. A re-run over the same transcript processes
 * the same `found` in the same order and lands on the same list.
 *
 * A found text whose newest occurrence is retired is skipped outright, which is
 * what makes a removal stick while the text is still in the window. The
 * retirement is dropped once a new emission of the same text carries a new id,
 * so a genuinely live instruction still returns.
 */
export function upsertNotices(
  existing: ReadonlyArray<Notice>,
  found: ReadonlyArray<{ id: string; text: string }>,
  at: number,
  retired: ReadonlyArray<RetiredNotice> = [],
): NoticeFold {
  const newestId = new Map<string, string>()
  for (const entry of found) newestId.set(entry.text, entry.id)
  const nextRetired = retired.filter((entry) => newestId.get(entry.text) === entry.id)
  const retiredText = new Set(nextRetired.map((entry) => entry.text))

  const order: string[] = []
  const byText = new Map<string, Notice>()
  const drop = (text: string): void => {
    if (!byText.delete(text)) return
    const index = order.indexOf(text)
    if (index >= 0) order.splice(index, 1)
  }
  for (const notice of existing) {
    if (byText.has(notice.text)) continue
    byText.set(notice.text, notice)
    order.push(notice.text)
  }

  for (const entry of found) {
    if (retiredText.has(entry.text)) {
      drop(entry.text)
      continue
    }
    const previous = byText.get(entry.text)
    drop(entry.text)
    byText.set(entry.text, { id: entry.id, text: previous?.text ?? headKeepNotice(entry.text), at: previous?.at ?? at })
    order.push(entry.text)
  }

  const notices = order.map((text) => byText.get(text)).filter((notice): notice is Notice => notice !== undefined)
  return {
    notices: notices.length > MAX_NOTICES ? notices.slice(notices.length - MAX_NOTICES) : notices,
    retired: nextRetired,
  }
}

/**
 * Record that the model retired a notice, so the pass cannot re-add its text.
 *
 * Called with the pinned entry, not just its id: the text is what keeps a stale
 * occurrence in the window from resurrecting it.
 */
export function retireNotice(retired: ReadonlyArray<RetiredNotice>, entry: Notice): RetiredNotice[] {
  const next = retired.filter((candidate) => !(candidate.id === entry.id && candidate.text === entry.text))
  next.push({ id: entry.id, text: entry.text })
  return next.length > MAX_RETIRED ? next.slice(next.length - MAX_RETIRED) : next
}

/**
 * Remove records for sessions the host no longer has.
 *
 * Deleting a session at `/sessions` removes the host's rows but not the
 * plugin's KV entry: the host emits no event and the tables have no foreign
 * key between them. The record would otherwise keep the memory, the pending
 * turns and the raw archive on disk for good.
 *
 * Safety is the whole design. The KV is shared by every project this host has
 * opened, so a record stamped with a different directory is left alone. Only a
 * `"gone"` answer from `session.get` deletes anything; an error the caller
 * cannot classify is `"unknown"` and keeps the record. A record with no
 * directory predates the stamp and is still swept, because a not-found answer
 * is proof the session is gone wherever it lived.
 */
export async function pruneOrphans(options: {
  readonly storage: StoragePort
  readonly directory: string
  readonly isAlive: (sessionID: string) => Promise<SessionLiveness>
  readonly warn?: (line: string) => void
}): Promise<PruneReport> {
  const report: PruneReport = { removed: 0, kept: 0, skipped: 0, failed: 0 }
  const warn = options.warn ?? (() => {})
  let after: string | undefined
  for (;;) {
    let page: Awaited<ReturnType<StoragePort["scan"]>>
    try {
      page = await options.storage.scan({
        prefix: KEY_PREFIX,
        ...(after === undefined ? {} : { after }),
        limit: 100,
      })
    } catch (error) {
      warn("storage scan failed; no records were removed: " + messageOf(error))
      return report
    }
    for (const entry of page.entries) {
      const sessionID = entry.key.startsWith(KEY_PREFIX) ? entry.key.slice(KEY_PREFIX.length) : ""
      if (sessionID.length === 0) {
        report.skipped += 1
        continue
      }
      const stamped =
        isPlainObject(entry.value) && typeof entry.value.directory === "string" ? entry.value.directory : undefined
      if (stamped !== undefined && !sameDirectory(stamped, options.directory)) {
        report.skipped += 1
        continue
      }
      let liveness: SessionLiveness
      try {
        liveness = await options.isAlive(sessionID)
      } catch {
        liveness = "unknown"
      }
      if (liveness === "alive") {
        report.kept += 1
        continue
      }
      if (liveness !== "gone") {
        report.skipped += 1
        continue
      }
      try {
        await options.storage.remove(entry.key)
        report.removed += 1
      } catch (error) {
        report.failed += 1
        warn("orphaned record remove failed: " + messageOf(error))
      }
    }
    const next = page.next
    if (next === undefined || next === after) break
    after = next
  }
  return report
}

/** Coerce anything read from storage back into a record the code can trust. */
export function normalizeRecord(value: unknown, now: number): SessionRecord {
  const record: SessionRecord = {
    version: 1,
    memory: emptyMemory(),
    seenTurns: [],
    pending: [],
    archive: [],
    createdAt: now,
    updatedAt: now,
  }
  if (!isPlainObject(value)) return record
  record.memory = normalizeMemory(value.memory)
  if (Array.isArray(value.seenTurns)) record.seenTurns = value.seenTurns.filter((id): id is string => typeof id === "string")
  if (Array.isArray(value.pending)) {
    record.pending = value.pending.map(normalizePending).filter((entry): entry is PendingTurn => entry !== undefined)
  }
  if (Array.isArray(value.archive)) {
    record.archive = value.archive.map(normalizeArchived).filter((entry): entry is ArchivedTurn => entry !== undefined)
  }
  if (typeof value.createdAt === "number") record.createdAt = value.createdAt
  if (typeof value.updatedAt === "number") record.updatedAt = value.updatedAt
  if (typeof value.directory === "string" && value.directory.length > 0) record.directory = value.directory
  if (isPlainObject(value.lastReport)) record.lastReport = value.lastReport as SessionRecord["lastReport"]
  const history = normalizeHistory(value.history)
  if (history !== undefined) record.history = history
  const notices = normalizeNotices(value.notices)
  if (notices !== undefined) record.notices = notices
  const retired = normalizeRetiredList(value.retired)
  if (retired !== undefined) record.retired = retired
  const revert = normalizeRevert(value.revert)
  if (revert !== undefined) record.revert = revert
  const undo = normalizeUndo(value.undo)
  if (undo !== undefined) record.undo = undo
  const lastUndo = normalizeLastUndo(value.lastUndo)
  if (lastUndo !== undefined) record.lastUndo = lastUndo
  return record
}

/**
 * The session store.
 *
 * Reads are cached; writes are serialized per session, because a tool call and
 * the context pass can otherwise interleave a load-modify-save and lose one of
 * the two writes. A storage failure is logged and the in-memory copy remains the
 * truth for this process — a store that cannot persist must not break a turn.
 */
export class SessionStore {
  private readonly cache = new Map<string, SessionRecord>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly storage?: StoragePort
  private readonly warn: (line: string) => void
  private readonly now: () => number
  private readonly directory?: string

  constructor(storage?: StoragePort, options: StoreOptions = {}) {
    this.storage = storage
    this.warn = options.warn ?? (() => {})
    this.now = options.now ?? (() => Date.now())
    this.directory = options.directory
  }

  /** Load a record, or an empty one when this session has never been seen. */
  async load(sessionID: string): Promise<SessionRecord> {
    const cached = this.cache.get(sessionID)
    if (cached !== undefined) {
      // Touch: Map iteration order is the LRU order.
      this.cache.delete(sessionID)
      this.cache.set(sessionID, cached)
      return cached
    }
    let stored: unknown
    if (this.storage !== undefined) {
      try {
        stored = await this.storage.get(keyOf(sessionID))
      } catch (error) {
        this.warn("storage read failed; keeping this session in memory: " + messageOf(error))
      }
    }
    const record = normalizeRecord(stored, this.now())
    this.cache.set(sessionID, record)
    return record
  }

  /** Persist a record and touch its LRU position. */
  async save(sessionID: string, record: SessionRecord): Promise<void> {
    record.updatedAt = this.now()
    if (record.directory === undefined && this.directory !== undefined) record.directory = this.directory
    this.cache.delete(sessionID)
    this.cache.set(sessionID, record)
    if (this.storage !== undefined) {
      try {
        await this.storage.set(keyOf(sessionID), record)
      } catch (error) {
        this.warn("storage write failed; the record stays in memory: " + messageOf(error))
      }
    }
    await this.trim()
  }

  /**
   * Load, mutate and save under a per-session lock.
   *
   * The callback may mutate the record in place; the return value is passed
   * through. A callback that throws leaves the record unsaved, which is the safe
   * direction: the next pass starts from the last good record.
   */
  async mutate<T>(sessionID: string, fn: (record: SessionRecord) => T | Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionID) ?? Promise.resolve()
    const run = async (): Promise<T> => {
      const record = await this.load(sessionID)
      const result = await fn(record)
      await this.save(sessionID, record)
      return result
    }
    const next = previous.then(run, run)
    this.locks.set(
      sessionID,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /** Drop one session from the cache and the store. */
  async remove(sessionID: string): Promise<void> {
    this.cache.delete(sessionID)
    if (this.storage === undefined) return
    try {
      await this.storage.remove(keyOf(sessionID))
    } catch (error) {
      this.warn("storage remove failed: " + messageOf(error))
    }
  }

  /** Keep the newest `MAX_SESSIONS` records; evict the oldest. */
  private async trim(): Promise<void> {
    while (this.cache.size > MAX_SESSIONS) {
      const oldest = this.cache.keys().next()
      if (oldest.done === true) break
      const sessionID = oldest.value
      this.cache.delete(sessionID)
      if (this.storage !== undefined) {
        try {
          await this.storage.remove(keyOf(sessionID))
        } catch (error) {
          this.warn("storage trim failed: " + messageOf(error))
        }
      }
    }
  }
}

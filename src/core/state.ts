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
import type { ArchivedTurn, PendingTurn, SessionRecord, StoragePort } from "./types.ts"
import { isPlainObject, messageOf } from "./types.ts"

/** How many sessions the store keeps before the oldest is evicted. */
export const MAX_SESSIONS = 64

const KEY_PREFIX = "session/"

export interface StoreOptions {
  readonly warn?: (line: string) => void
  readonly now?: () => number
}

function keyOf(sessionID: string): string {
  return KEY_PREFIX + sessionID
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
  if (isPlainObject(value.lastReport)) record.lastReport = value.lastReport as SessionRecord["lastReport"]
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

  constructor(storage?: StoragePort, options: StoreOptions = {}) {
    this.storage = storage
    this.warn = options.warn ?? (() => {})
    this.now = options.now ?? (() => Date.now())
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

/**
 * The project key and the durable project record.
 *
 * A project is a repository, not a session: facts learned in one session are
 * available to the next and to every worktree of the same git root. The key is
 * therefore the git root when the adapter can find one, and the canonical
 * directory otherwise. It is normalized (separators, Windows case), hashed with
 * SHA-256, and never used as a storage key unhashed.
 *
 * This module is host-free. The adapter supplies a small async storage port; a
 * storage failure is logged and the in-memory copy remains the truth for this
 * process, exactly as `SessionStore` does.
 *
 * @module mega-smart-context/project
 */
import { createHash } from "node:crypto"

import { normalizeFact, normalizeRetired, type ProjectFact, type RetiredFact } from "./facts.ts"
import { isPlainObject, messageOf } from "./types.ts"

/** The record version. Bump only when a reader cannot understand the old shape. */
export const PROJECT_RECORD_VERSION = 1
/** How many fold-dedupe keys one record remembers. */
export const PROJECT_SEEN_MAX = 256
/** Most tool entries one project keeps before older ones fold into `(other)`. */
export const TOOL_USAGE_MAX = 64
/** Distinct-session marks one tool keeps; the count saturates here. */
export const TOOL_SESSIONS_MAX = 12
/** Longest stored tool name. */
export const TOOL_NAME_MAX = 64
/** Most usage-fold keys one project remembers. */
export const USAGE_SEEN_MAX = 256
/** Most distinct session marks one project remembers. */
export const SESSIONS_SEEN_MAX = 64
/** Counter ceilings, so a corrupt record cannot grow without bound. */
export const TOOL_COUNTER_MAX = 1_000_000_000
export const TOOL_UNUSED_MAX = 1_000_000

/** The storage port this module needs; the host `StoragePort` satisfies it. */
export interface ProjectStoragePort {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove?(key: string): Promise<void>
}

export interface ProjectKey {
  /** The normalized root; also the identity facts are scoped to. */
  key: string
  /** Full SHA-256 of `key`; the durable address is `project/<hash>`. */
  hash: string
  /** The storage key, `project/<hash>`. */
  storageKey: string
  /** The same normalized root, kept as a readable alias for adapters and status. */
  root: string
  /** Whether the key came from a git root or from the session directory. */
  source: "git" | "directory"
}

export interface ProjectKeyInput {
  /** The session's canonical directory. */
  directory: string
  /** The git root, when the adapter found one. Worktrees share it. */
  gitRoot?: string | null
}

export interface ProjectToolUsage {
  /** Completed calls paired with a result. */
  calls: number
  ok: number
  failed: number
  /** Completed prompt-turns in which this tool was called at least once. */
  prompts: number
  /** Folded prompt-turns since the last call; 0 on a turn that called it. */
  unusedPrompts: number
  /** Fold time of the last call, ms since epoch. */
  lastAt: number
  /** Distinct sessions, saturating at TOOL_SESSIONS_MAX. */
  sessions: number
  /** Short session hashes used to count `sessions`; bounded. */
  sessionMarks: string[]
}

export interface ProjectEnvelope {
  /** Monotonic session-fold counter; the logical clock for recency decay. */
  step: number
  /** How many folds this record has merged. */
  sessions: number
  /** Session+turn fingerprints already folded, so a repeated idle event is a no-op. */
  seen: string[]
  /** Last rendered block, for status only. Never the injection source. */
  rendered?: string
  /** Estimated tokens of `rendered`, for status only. */
  tokens?: number
  /** Completed prompt-turns folded for tool usage. */
  promptTurns: number
  /** Usage-fold dedupe keys, separate namespace from facts. */
  usageSeen: string[]
  /** Short hashes of sessions that have folded usage. */
  sessionsSeen: string[]
}

/**
 * The durable project record.
 *
 * `facts` holds ACTIVE facts, `candidates` holds facts still being confirmed,
 * and `retired` holds contradictions, forgotten facts and expired entries. A
 * retired id is never learned again; forgetting keeps the record so unforget can
 * restore it.
 */
export interface ProjectRecord {
  version: number
  key: string
  root: string
  facts: Record<string, ProjectFact>
  candidates: Record<string, ProjectFact>
  retired: Record<string, RetiredFact>
  toolUsage: Record<string, ProjectToolUsage>
  envelope: ProjectEnvelope
  createdAt: number
  updatedAt: number
}

export interface ProjectStoreOptions {
  readonly warn?: (line: string) => void
  readonly now?: () => number
}

export interface ProjectLoadOptions {
  /** Ignore this instance's cache and read the store again. */
  fresh?: boolean
}

export interface ProjectPruneReport {
  facts: number
  candidates: number
  retired: number
}

/**
 * Normalize a project root: forward slashes, no duplicate separators, no dot
 * segments, no trailing slash (except a drive or POSIX root), and lower case on
 * Windows. A relative path keeps its case; only absolute Windows paths are
 * case-insensitive.
 */
export function normalizeProjectRoot(value: string): string {
  let raw = typeof value === "string" ? value.trim() : ""
  if (raw.length === 0) return ""

  // Windows long-path prefixes; keep the UNC double slash after removing \?UNC.
  if (/^\\\\\?\\UNC\\/iu.test(raw)) raw = "\\\\" + raw.slice(8)
  else if (raw.startsWith("\\\\?\\")) raw = raw.slice(4)

  raw = raw.replaceAll("\\", "/")
  const windows = /^[A-Za-z]:\//u.test(raw) || raw.startsWith("//")
  const unc = raw.startsWith("//")
  const absolute = raw.startsWith("/") && !unc
  const prefix = unc ? "//" : absolute ? "/" : ""
  const body = unc ? raw.slice(2) : absolute ? raw.slice(1) : raw

  const parts: string[] = []
  for (const segment of body.split("/")) {
    if (segment.length === 0 || segment === ".") continue
    if (segment === "..") {
      const atRoot = parts.length === 0 || (parts.length === 1 && /^[A-Za-z]:$/u.test(parts[0]))
      if (!atRoot) parts.pop()
      continue
    }
    parts.push(segment)
  }

  let out = prefix + parts.join("/")
  if (windows) out = out.toLowerCase()
  if (windows && /^[a-z]:$/u.test(out)) out = out + "/"
  if (out.length === 0) return prefix
  return out
}

/** The stable SHA-256 of a normalized key. */
export function projectHash(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/**
 * Build a project key. The git root wins whenever it is present and non-empty,
 * so every worktree of one repository shares its facts; otherwise the canonical
 * directory is the project.
 */
export function projectKeyFor(input: ProjectKeyInput | string, gitRoot?: string | null): ProjectKey {
  const raw: ProjectKeyInput = typeof input === "string" ? { directory: input, gitRoot } : input
  const directory = normalizeProjectRoot(raw.directory)
  const git = normalizeProjectRoot(raw.gitRoot ?? "")
  const key = git.length > 0 ? git : directory
  if (key.length === 0) throw new Error("a project key needs a directory or a git root")
  const hash = projectHash(key)
  return {
    key,
    hash,
    storageKey: "project/" + hash,
    root: key,
    source: git.length > 0 ? "git" : "directory",
  }
}

/** An empty record for a project that has never been seen. */
export function emptyProjectRecord(project: ProjectKey, now = Date.now()): ProjectRecord {
  return {
    version: PROJECT_RECORD_VERSION,
    key: project.key,
    root: project.root,
    facts: {},
    candidates: {},
    retired: {},
    toolUsage: {},
    envelope: {
      step: 0,
      sessions: 0,
      seen: [],
      promptTurns: 0,
      usageSeen: [],
      sessionsSeen: [],
    },
    createdAt: now,
    updatedAt: now,
  }
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function normalizeCount(value: unknown): number {
  return Math.max(0, Math.floor(finite(value)))
}

/** A zeroed tool-usage row; the fold and the normalizer share one shape. */
export function emptyToolUsage(): ProjectToolUsage {
  return {
    calls: 0,
    ok: 0,
    failed: 0,
    prompts: 0,
    unusedPrompts: 0,
    lastAt: 0,
    sessions: 0,
    sessionMarks: [],
  }
}

function normalizeToolName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").slice(0, TOOL_NAME_MAX)
}

function normalizeSessionMarks(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) continue
    seen.add(item.slice(0, 96))
  }
  return [...seen].slice(-TOOL_SESSIONS_MAX)
}

function normalizeToolUsage(value: unknown): Record<string, ProjectToolUsage> {
  if (!isPlainObject(value)) return {}
  const entries: Array<[string, ProjectToolUsage]> = []
  for (const [rawName, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue
    const name = normalizeToolName(rawName)
    if (name.length === 0) continue
    const sessionMarks = normalizeSessionMarks(entry.sessionMarks)
    entries.push([
      name,
      {
        calls: Math.min(TOOL_COUNTER_MAX, normalizeCount(entry.calls)),
        ok: Math.min(TOOL_COUNTER_MAX, normalizeCount(entry.ok)),
        failed: Math.min(TOOL_COUNTER_MAX, normalizeCount(entry.failed)),
        prompts: Math.min(TOOL_COUNTER_MAX, normalizeCount(entry.prompts)),
        unusedPrompts: Math.min(TOOL_UNUSED_MAX, normalizeCount(entry.unusedPrompts)),
        lastAt: Math.max(0, Math.floor(finite(entry.lastAt))),
        sessions: Math.min(TOOL_SESSIONS_MAX, normalizeCount(entry.sessions)),
        sessionMarks,
      },
    ])
  }
  entries.sort((left, right) => right[1].lastAt - left[1].lastAt || left[0].localeCompare(right[0]))
  const out: Record<string, ProjectToolUsage> = {}
  const limit = entries.length > TOOL_USAGE_MAX ? TOOL_USAGE_MAX - 1 : TOOL_USAGE_MAX
  const other = emptyToolUsage()
  for (let index = 0; index < entries.length; index += 1) {
    const [name, usage] = entries[index]
    if (index < limit) {
      out[name] = usage
      continue
    }
    other.calls += usage.calls
    other.ok += usage.ok
    other.failed += usage.failed
    other.prompts += usage.prompts
    other.unusedPrompts = Math.max(other.unusedPrompts, usage.unusedPrompts)
    other.lastAt = Math.max(other.lastAt, usage.lastAt)
    other.sessions = Math.max(other.sessions, usage.sessions)
  }
  if (other.calls > 0) out["(other)"] = other
  return out
}

function normalizeEnvelope(value: unknown): ProjectEnvelope {
  const source = isPlainObject(value) ? value : {}
  const seen = Array.isArray(source.seen)
    ? source.seen.filter((item): item is string => typeof item === "string").slice(-PROJECT_SEEN_MAX)
    : []
  const usageSeen = Array.isArray(source.usageSeen)
    ? source.usageSeen.filter((item): item is string => typeof item === "string").slice(-USAGE_SEEN_MAX)
    : []
  const sessionsSeen = Array.isArray(source.sessionsSeen)
    ? source.sessionsSeen.filter((item): item is string => typeof item === "string").slice(-SESSIONS_SEEN_MAX)
    : []
  return {
    step: Math.max(0, Math.floor(finite(source.step))),
    sessions: Math.max(0, Math.floor(finite(source.sessions))),
    seen,
    rendered: typeof source.rendered === "string" ? source.rendered : undefined,
    tokens: typeof source.tokens === "number" && Number.isFinite(source.tokens) ? source.tokens : undefined,
    promptTurns: normalizeCount(source.promptTurns),
    usageSeen,
    sessionsSeen,
  }
}

/** Defensive read of a stored record; the requested key is authoritative. */
export function normalizeProjectRecord(
  value: unknown,
  project: ProjectKey,
  now = Date.now(),
): ProjectRecord {
  const source = isPlainObject(value) ? value : {}
  const facts: Record<string, ProjectFact> = {}
  const candidates: Record<string, ProjectFact> = {}
  const retired: Record<string, RetiredFact> = {}

  if (isPlainObject(source.facts)) {
    for (const entry of Object.values(source.facts)) {
      const fact = normalizeFact(entry)
      if (fact !== undefined) facts[fact.id] = fact
    }
  }
  if (isPlainObject(source.candidates)) {
    for (const entry of Object.values(source.candidates)) {
      const fact = normalizeFact(entry)
      if (fact !== undefined) candidates[fact.id] = fact
    }
  }
  if (isPlainObject(source.retired)) {
    for (const entry of Object.values(source.retired)) {
      const fact = normalizeRetired(entry)
      if (fact !== undefined) retired[fact.fact.id] = fact
    }
  }

  return {
    version: PROJECT_RECORD_VERSION,
    key: project.key,
    root: project.root,
    facts,
    candidates,
    retired,
    toolUsage: normalizeToolUsage(source.toolUsage),
    envelope: normalizeEnvelope(source.envelope),
    createdAt: finite(source.createdAt, now),
    updatedAt: finite(source.updatedAt, now),
  }
}

function storedUpdatedAt(value: unknown): number | undefined {
  if (!isPlainObject(value)) return undefined
  return typeof value.updatedAt === "number" ? value.updatedAt : undefined
}

/** A save was refused because another instance stored a newer copy. */
export class ProjectStoreConflictError extends Error {
  readonly projectKey: string

  constructor(projectKey: string) {
    super(
      `another plugin instance wrote project ${projectKey} while this copy was being changed; ` +
        "nothing was saved — try again",
    )
    this.name = "ProjectStoreConflictError"
    this.projectKey = projectKey
  }
}

/**
 * The project store.
 *
 * Reads are cached; writes are serialized per project. The optimistic guard is
 * the same as `SessionStore`'s: `save` compares the stored `updatedAt` with the
 * copy it was handed and, when the stored one is newer, refuses, adopts the
 * stored record and returns false. `mutate` then reruns its callback once on the
 * newer copy, because the first attempt was never persisted.
 */
export class ProjectStore {
  private readonly cache = new Map<string, ProjectRecord>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly storage?: ProjectStoragePort
  private readonly warn: (line: string) => void
  private readonly now: () => number

  constructor(storage?: ProjectStoragePort, options: ProjectStoreOptions = {}) {
    this.storage = storage
    this.warn = options.warn ?? (() => {})
    this.now = options.now ?? (() => Date.now())
  }

  /** Load a project record, or an empty one when the project has never been seen. */
  async load(project: ProjectKey, options: ProjectLoadOptions = {}): Promise<ProjectRecord> {
    const cached = this.cache.get(project.storageKey)
    if (cached !== undefined && (options.fresh !== true || this.storage === undefined)) {
      this.cache.delete(project.storageKey)
      this.cache.set(project.storageKey, cached)
      return cached
    }

    let stored: unknown
    if (this.storage !== undefined) {
      try {
        stored = await this.storage.get(project.storageKey)
      } catch (error) {
        this.warn("project storage read failed; keeping the project in memory: " + messageOf(error))
        if (cached !== undefined) return cached
      }
    }
    const record = normalizeProjectRecord(stored, project, this.now())
    this.cache.set(project.storageKey, record)
    return record
  }

  /**
   * Persist a record. Returns false when the stored copy is newer; that copy
   * wins and this instance's cache adopts it. The caller's record is not saved.
   */
  async save(project: ProjectKey, record: ProjectRecord): Promise<boolean> {
    const localAt = record.updatedAt
    if (this.storage !== undefined) {
      try {
        const stored = await this.storage.get(project.storageKey)
        const storedAt = storedUpdatedAt(stored)
        if (storedAt !== undefined && storedAt > localAt) {
          const fresh = normalizeProjectRecord(stored, project, this.now())
          this.cache.set(project.storageKey, fresh)
          this.warn(
            `project ${project.root} was written by another instance (${storedAt} > ${localAt}); the stored record wins`,
          )
          return false
        }
      } catch (error) {
        this.warn("project storage read failed before writing; keeping the local copy: " + messageOf(error))
      }
    }

    record.key = project.key
    record.root = project.root
    record.updatedAt = this.now()
    this.cache.delete(project.storageKey)
    this.cache.set(project.storageKey, record)
    if (this.storage !== undefined) {
      try {
        await this.storage.set(project.storageKey, record)
      } catch (error) {
        this.warn("project storage write failed; the in-memory copy remains: " + messageOf(error))
      }
    }
    return true
  }

  /** Load, change and save under a per-project lock, retrying once on a conflict. */
  async mutate<T>(project: ProjectKey, fn: (record: ProjectRecord) => T | Promise<T>): Promise<T> {
    const previous = this.locks.get(project.storageKey) ?? Promise.resolve()
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt += 1) {
        const record = await this.load(project, { fresh: true })
        const result = await fn(record)
        if (await this.save(project, record)) return result
        if (attempt >= 1) throw new ProjectStoreConflictError(project.key)
      }
    }
    const next = previous.then(run, run)
    this.locks.set(
      project.storageKey,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /** Drop one project from the cache and, when the port supports it, the store. */
  async remove(project: ProjectKey): Promise<void> {
    this.cache.delete(project.storageKey)
    if (this.storage?.remove === undefined) return
    try {
      await this.storage.remove(project.storageKey)
    } catch (error) {
      this.warn("project storage remove failed: " + messageOf(error))
    }
  }
}

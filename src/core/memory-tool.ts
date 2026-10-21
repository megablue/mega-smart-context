/**
 * `smart_context`: the model's only write path into its own context.
 *
 * Every decision — what a patch means, whether it fits the cap, whether a recall
 * is allowed, what an archive entry keeps — is here, host-free. The adapter only
 * supplies the session id and forwards the text.
 *
 * Three rules are enforced rather than described:
 *
 * 1. An over-cap patch is rejected with the current usage, never trimmed.
 * 2. `recall` refuses without `lost:true`; an archive searched out of habit is a
 *    second working set, which is exactly what this plugin exists to avoid.
 * 3. A write goes through `store.mutate`, so a tool call and a context pass
 *    cannot interleave a load-modify-save and lose one of the two.
 *
 * @module mega-smart-context/memory-tool
 */

import { archivePending, findArchived, purgeQuery, purgeTurn, recall } from "./archive.ts"
import type { ResolvedConfig } from "./config.ts"
import { estimateTokens, formatTokens, memoryChars } from "./measure.ts"
import { budgetOf, noticePreview, renderMemory, renderStats } from "./prompts.ts"
import { MEMORY_KEYS, applyPatch, parsePatch } from "./schema.ts"
import { retireNotice } from "./state.ts"
import type { SessionStore } from "./state.ts"
import type { FeatureMapPort, Memory, SessionRecord } from "./types.ts"
import { refVerdict } from "./refs.ts"
import { renderTurn } from "./view.ts"

export interface MemoryToolInput {
  action?: unknown
  patch?: unknown
  key?: unknown
  page?: unknown
  section?: unknown
  gist?: unknown
  turn?: unknown
  remove?: unknown
  query?: unknown
  lost?: unknown
  keepRaw?: unknown
  limit?: unknown
  from?: unknown
}

export interface MemoryToolRequest extends MemoryToolInput {
  readonly sessionID: string
}

export interface MemoryToolDeps {
  readonly store: SessionStore
  readonly config: ResolvedConfig
  readonly featureMap?: FeatureMapPort
  readonly root?: string
  /** The spawning session of the given session, when the host tracks one. */
  readonly parentOf?: (sessionID: string) => Promise<string | undefined>
  readonly now?: () => number
}

export interface MemoryToolOutcome {
  readonly text: string
  readonly ok: boolean
}

/** Actions that cannot take from: they write, and writes act on this session. */
const MUTATING_ACTIONS = new Set(["read", "patch", "stats", "ref", "archive", "purge", "notice"])

export const TOOL_HELP = `smart_context actions:
- read { key? }                           print one memory key, or the whole document
- patch { patch: { ... } }               merge a patch (maps merge, lists replace, null resets)
- stats                                 memory/working/archive usage
- ref { page, section, gist }            store a feature-map pointer and compare costs
- archive { turn, gist, keepRaw? }       move a pending turn to the archive
- purge { turn? | query? }               delete a pending/archived turn, or matching entries
- recall { query, lost:true, from? }     search the archive only when a fact is missing; from:"parent" searches the spawning session's archive
- expand { turn, from? }                 read an archived turn back
- notice { remove? }                     list the pinned host notices, or drop a superseded one`

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * The record recall and expand act on.
 *
 * `from: "parent"` points them at the session that spawned this one, so a
 * delegate can search its caller's archive without the raw turns landing in
 * the caller's window. Only these two actions take the field: every mutating
 * one (patch, ref, archive, purge, notice) keeps writing to the caller's own
 * record, so delegation reads a parent's past but can never rewrite it.
 *
 * The parent lookup is a host fact, so a host that cannot answer, a top-level
 * session and a disabled config each get their own refusal.
 */
async function targetRecord(
  deps: MemoryToolDeps,
  request: MemoryToolRequest,
  sessionID: string,
): Promise<SessionRecord | MemoryToolOutcome> {
  if (request.from === undefined || request.from === null) return deps.store.load(sessionID)
  if (request.from !== "parent") {
    return { text: `smart_context: from must be "parent", not ${JSON.stringify(request.from)}`, ok: false }
  }
  if (deps.config.parentArchive !== true) {
    return { text: "smart_context: cross-session archive reads are off (config parentArchive:false)", ok: false }
  }
  if (deps.parentOf === undefined) {
    return { text: "smart_context: this host cannot look up a session's parent", ok: false }
  }
  const parent = await deps.parentOf(sessionID)
  if (parent === undefined || parent === sessionID) {
    return { text: 'smart_context: this session has no parent, so from:"parent" has nothing to read', ok: false }
  }
  return deps.store.load(parent)
}

function isOutcome(value: SessionRecord | MemoryToolOutcome): value is MemoryToolOutcome {
  return "text" in value
}

/**
 * The line that follows an oversized expansion, in place of nothing.
 *
 * A raw turn can run to thousands of characters, and a reader quoting it
 * wholesale pays for every one of them twice — once in its own window and once
 * in whatever it replies to. Above `expandDigestChars` the result itself tells
 * the reader to digest instead, which is what makes the delegation contract
 * self-enforcing: the subagent that expands the parent's turn sees the
 * instruction exactly when it is about to reply.
 */
function digestHint(text: string, config: ResolvedConfig): string {
  if (text.length <= config.expandDigestChars) return ""
  return (
    `\n(the turn runs to ~${text.length} chars, over the ${config.expandDigestChars}-char digest limit: ` +
    "answer from it or summarize it rather than quoting it whole)"
  )
}

function usage(record: SessionRecord, config: ResolvedConfig): string {
  const report = budgetOf(record, config)
  return (
    `memory ${formatTokens(report.memoryTokens)}/${formatTokens(report.memoryCap)} est · ` +
    `working ${formatTokens(report.workingTokens)}/${formatTokens(report.workingCap)} est · ` +
    `refs ${report.refs} · pending ${report.pending} · archive ${report.archive}`
  )
}

function read(record: SessionRecord, request: MemoryToolRequest, config: ResolvedConfig): MemoryToolOutcome {
  const key = str(request.key)
  if (key === undefined) return { text: renderMemory(record), ok: true }
  if (!MEMORY_KEYS.has(key)) {
    return { text: `smart_context: unknown key ${JSON.stringify(key)}. Keys: ${[...MEMORY_KEYS].join(", ")}`, ok: false }
  }
  return { text: JSON.stringify(record.memory[key as keyof Memory], null, 2), ok: true }
}

function patch(record: SessionRecord, request: MemoryToolRequest, config: ResolvedConfig): MemoryToolOutcome {
  const parsed = parsePatch(request.patch)
  if (parsed.error !== undefined) return { text: `smart_context: ${parsed.error}`, ok: false }
  const result = applyPatch(record.memory, parsed.patch)
  if (result.changed.length === 0 && result.dropped.length === 0 && result.errors.length === 0) {
    return { text: "smart_context: nothing to change", ok: false }
  }

  const nextTokens = estimateTokens(memoryChars(result.memory), config.charsPerToken)
  if (nextTokens > config.memoryTokens) {
    return {
      text:
        `smart_context: memory write rejected — it would be ${formatTokens(nextTokens)}/${formatTokens(config.memoryTokens)} est. ` +
        `Nothing was written. Compact first: shorten notes, drop stale facts, or remove archived material from memory, then retry.`,
      ok: false,
    }
  }

  record.memory = result.memory
  const lines = [`smart_context: stored${result.changed.length > 0 ? " " + result.changed.join(", ") : ""}`]
  if (result.dropped.length > 0) lines.push(`dropped unknown key(s): ${result.dropped.join(", ")}`)
  if (result.errors.length > 0) lines.push(`errors: ${result.errors.join("; ")}`)
  lines.push(usage(record, config))
  return { text: lines.join("\n"), ok: true }
}

async function addRef(
  record: SessionRecord,
  request: MemoryToolRequest,
  deps: MemoryToolDeps,
): Promise<MemoryToolOutcome> {
  if (!deps.config.refs) return { text: "smart_context: refs are disabled in this install", ok: false }
  const page = str(request.page)
  const section = str(request.section)
  const gist = str(request.gist)
  if (page === undefined || section === undefined || gist === undefined) {
    return { text: "smart_context: ref needs page, section and gist", ok: false }
  }
  const sectionText = deps.featureMap === undefined ? undefined : await deps.featureMap.readSection(deps.root ?? "", page, section)
  const verdict = refVerdict(gist, sectionText, deps.config.charsPerToken)
  const entry = { page, section, gist, tokens: verdict.gistTokens }

  const before = record.memory.refs.map((ref) => ({ ...ref }))
  const index = record.memory.refs.findIndex((ref) => ref.page === page && ref.section === section)
  if (index >= 0) record.memory.refs[index] = entry
  else record.memory.refs.push(entry)

  const nextTokens = estimateTokens(memoryChars(record.memory), deps.config.charsPerToken)
  if (nextTokens > deps.config.memoryTokens) {
    record.memory.refs = before
    return {
      text: `smart_context: ref not stored — memory would be ${formatTokens(nextTokens)}/${formatTokens(deps.config.memoryTokens)} est. Nothing was written.`,
      ok: false,
    }
  }

  const lines: string[] = []
  if (verdict.found) {
    lines.push(
      `gist ${verdict.gistTokens} est · section ${verdict.sectionTokens} est · ` +
        (verdict.useRef
          ? `the reference is shorter (saves ~${verdict.saving})`
          : "the gist is longer than the section; inline the section instead"),
    )
  } else {
    lines.push("section not found in docs/features; the pointer was stored but cannot be expanded. Check the page name with feature_map.")
  }
  lines.push(`stored ref ${page}#${section}`)
  lines.push(usage(record, deps.config))
  return { text: lines.join("\n"), ok: true }
}

function archive(record: SessionRecord, request: MemoryToolRequest, deps: MemoryToolDeps): MemoryToolOutcome {
  const turn = str(request.turn)
  const gist = str(request.gist)
  if (turn === undefined || gist === undefined) {
    return { text: "smart_context: archive needs turn and gist", ok: false }
  }
  const entry = archivePending(record, turn, gist, request.keepRaw === true, {
    now: deps.now?.() ?? Date.now(),
    maxTurns: deps.config.archiveMaxTurns,
    maxChars: deps.config.archiveMaxChars,
  })
  if (entry === undefined) {
    const pending = record.pending.map((item) => item.id).join(", ") || "none"
    return { text: `smart_context: no pending turn ${JSON.stringify(turn)}. Pending: ${pending}`, ok: false }
  }
  return {
    text:
      `archived ${turn} (${entry.messages === undefined ? "gist only" : "gist + raw"})\n` +
      usage(record, deps.config),
    ok: true,
  }
}

function purge(record: SessionRecord, request: MemoryToolRequest, config: ResolvedConfig): MemoryToolOutcome {
  const turn = str(request.turn)
  const query = str(request.query)
  if (turn !== undefined) {
    const removed = purgeTurn(record, turn)
    return { text: removed ? `purged ${turn}` : `smart_context: no turn ${JSON.stringify(turn)}`, ok: removed }
  }
  if (query !== undefined) {
    const count = purgeQuery(record, query)
    return { text: `purged ${count} archived turn(s) matching ${JSON.stringify(query)}\n` + usage(record, config), ok: true }
  }
  return { text: "smart_context: purge needs turn or query", ok: false }
}

/**
 * List the pinned host notices, or retire a superseded one.
 *
 * The newest notice is the live instruction and is refused: a newer notice, not
 * the model, is what resolves a contradiction the host injected. "Newest" is the
 * last entry, which the pass keeps in recency order, so the refusal lands on the
 * text the host emitted most recently rather than on whichever text happened to
 * arrive first in the session.
 *
 * Removal is a retirement: the entry is recorded in `record.retired` so the next
 * pass skips that text while the host's window still holds a copy of it. A new
 * emission under a new id clears the retirement, because a re-emitted instruction
 * is live again.
 */
function notice(record: SessionRecord, request: MemoryToolRequest, config: ResolvedConfig): MemoryToolOutcome {
  const notices = record.notices ?? []
  const remove = str(request.remove)
  if (remove === undefined) {
    if (notices.length === 0) return { text: "smart_context: no pinned host notices", ok: true }
    const newest = notices[notices.length - 1].id
    const lines = ["pinned host notices (newest first):"]
    for (const entry of [...notices].reverse()) {
      lines.push(`- ${entry.id}${entry.id === newest ? " (live, cannot be removed)" : ""} · ${noticePreview(entry.text)}`)
    }
    lines.push("", 'Retire a superseded notice with action:"notice" remove:"<id>".')
    return { text: lines.join("\n"), ok: true }
  }
  if (remove === notices[notices.length - 1]?.id) {
    return {
      text:
        `smart_context: ${remove} is the newest notice, the live instruction, and cannot be removed. ` +
        "A newer notice retires it; until then it stays pinned.",
      ok: false,
    }
  }
  const entry = notices.find((notice) => notice.id === remove)
  if (entry === undefined) {
    const ids = notices.map((notice) => notice.id).join(", ") || "none"
    return { text: `smart_context: no pinned notice ${JSON.stringify(remove)}. Pinned: ${ids}`, ok: false }
  }
  record.notices = notices.filter((notice) => notice.id !== remove)
  record.retired = retireNotice(record.retired ?? [], entry)
  return {
    text:
      `removed pinned notice ${remove}\n` +
      "It stays retired while its text is still in the window; the host emitting it again under a new id returns it.\n" +
      usage(record, config),
    ok: true,
  }
}

export async function runMemoryTool(
  request: MemoryToolRequest,
  deps: MemoryToolDeps,
): Promise<MemoryToolOutcome> {
  const sessionID = request.sessionID
  if (sessionID.length === 0) return { text: "smart_context: no session id", ok: false }
  const action = typeof request.action === "string" ? request.action : ""
  if (MUTATING_ACTIONS.has(action) && request.from !== undefined) {
    return {
      text: 'smart_context: from is read-only and only recall and expand take it; writes act on this session',
      ok: false,
    }
  }

  switch (action) {
    case "read": {
      const record = await deps.store.load(sessionID)
      return read(record, request, deps.config)
    }
    case "stats": {
      const record = await deps.store.load(sessionID)
      return { text: renderStats(record, deps.config) + "\n" + usage(record, deps.config), ok: true }
    }
    case "patch":
      return deps.store.mutate(sessionID, (record) => patch(record, request, deps.config))
    case "ref":
      return deps.store.mutate(sessionID, (record) => addRef(record, request, deps))
    case "archive":
      return deps.store.mutate(sessionID, (record) => archive(record, request, deps))
    case "purge":
      return deps.store.mutate(sessionID, (record) => purge(record, request, deps.config))
    case "notice":
      return deps.store.mutate(sessionID, (record) => notice(record, request, deps.config))
    case "recall": {
      if (request.lost !== true) {
        return {
          text:
            "smart_context: recall is for a fact you are missing. Set lost:true only when the answer is not in memory or the working window. " +
            "If you are exploring, use feature_map or read the file instead.",
          ok: false,
        }
      }
      const query = str(request.query)
      if (query === undefined) return { text: "smart_context: recall needs a query", ok: false }
      const target = await targetRecord(deps, request, sessionID)
      if (isOutcome(target)) return target
      const fromParent = request.from === "parent"
      const limit = typeof request.limit === "number" && Number.isFinite(request.limit) ? request.limit : 5
      const found = recall(target, query, limit)
      if (found.length === 0) {
        return { text: `no archived turn matches ${JSON.stringify(query)}${fromParent ? " in the spawning session's archive" : ""}`, ok: true }
      }
      const hint = fromParent ? ' from:"parent"' : ""
      return {
        text:
          `archive matches${fromParent ? " in the spawning session's archive" : ""}:\n` +
          found
            .map(
              (entry) =>
                `- ${entry.id} · ${entry.gist}` +
                (entry.messages === undefined ? " (gist only)" : ` (expand: action:"expand" turn:"${entry.id}"${hint})`),
            )
            .join("\n") +
          (fromParent ? "\n(delegating: report the substance of what you found, not the raw turns)" : ""),
        ok: true,
      }
    }
    case "expand": {
      const turn = str(request.turn)
      if (turn === undefined) return { text: "smart_context: expand needs turn", ok: false }
      const target = await targetRecord(deps, request, sessionID)
      if (isOutcome(target)) return target
      const entry = findArchived(target, turn)
      if (entry === undefined) return { text: `smart_context: no archived turn ${JSON.stringify(turn)}`, ok: false }
      if (entry.messages === undefined) {
        return { text: `${entry.gist}\n(gist only; no raw messages were kept)`, ok: true }
      }
      const text = renderTurn(entry.messages, 20_000)
      return { text: text + digestHint(text, deps.config), ok: true }
    }
    default:
      return { text: TOOL_HELP, ok: false }
  }
}

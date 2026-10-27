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

import { archivePending, findArchived, findPending, purgeQuery, recall } from "./archive.ts"
import type { ResolvedConfig } from "./config.ts"
import { estimateTokens, formatTokens, memoryChars } from "./measure.ts"
import { retirePinned } from "./notices.ts"
import { budgetOf, noticePreview, renderMemory, renderStats } from "./prompts.ts"
import { configForRecord } from "./profiles.ts"
import { MEMORY_KEYS, applyPatch, parsePatch } from "./schema.ts"
import { captureMemory, capturePurge, purgeWithUndo } from "./undo.ts"
import type { SessionStore } from "./state.ts"
import { StoreConflictError } from "./state.ts"
import type { FeatureMapPort, Memory, SessionRecord } from "./types.ts"
import { refVerdict } from "./refs.ts"
import { turnOutline, turnPage } from "./view.ts"

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
  offset?: unknown
  mode?: unknown
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
- read { key? } - print one memory key, or the whole document
- patch { patch } - merge a patch (maps merge, lists replace, null resets)
- stats - memory/working/archive usage
- ref { page, section, gist } - store a feature-map pointer and compare costs
- archive { turn, gist, keepRaw? } - move a pending turn to the archive; without keepRaw the raw is discarded
- purge { turn? | query? } - delete a pending/archived turn, or matching entries
- recall { query, lost:true, limit?, from? } - search the archive only when a fact is missing; from:"parent" searches the spawning session's archive
- expand { turn, mode?, offset?, limit?, from? } - read an archived or pending turn: one honest page, or mode:"outline" for its map
- notice { remove? } - list the pinned host notices, or drop a superseded one`

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function nowOf(deps: MemoryToolDeps): number {
  return deps.now?.() ?? Date.now()
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
  config: ResolvedConfig,
): Promise<SessionRecord | MemoryToolOutcome> {
  if (request.from === undefined || request.from === null) return deps.store.load(sessionID)
  if (request.from !== "parent") {
    return { text: `smart_context: from must be "parent", not ${JSON.stringify(request.from)}`, ok: false }
  }
  if (config.parentArchive !== true) {
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
 * The note a delegated read ends with: what the caller can actually keep.
 *
 * A result over `maxResultChars` is re-eroded on the caller's next pass - 60%
 * head and 40% tail - so a child that writes a 19,000-character report has
 * roughly 4,000 delivered. Saying so up front is the only way the delegation
 * contract can hold: the child is the party that must digest, and it has to
 * know the budget before it writes.
 */
function delegatingNote(config: ResolvedConfig): string {
  return (
    `\n(delegating: your caller keeps at most ${config.maxResultChars} chars of your reply; ` +
    "return a digest under that, or write the long version to a file and cite the path)"
  )
}

/**
 * What one `expand` result may spend, including its own footer and that note.
 *
 * `expandDigestChars` is the page size and `maxResultChars` is the hard ceiling:
 * a page over the ceiling would be cut again, in the middle, by the pass that
 * carries it. `turnPage` reserves room for the footer inside this budget.
 */
function expandBudget(config: ResolvedConfig, fromParent: boolean): { budget: number; hint: string } {
  const hint = fromParent ? delegatingNote(config) : ""
  const ceiling = Math.min(config.expandDigestChars, config.maxResultChars) - hint.length
  return { budget: Math.max(400, ceiling), hint }
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

function patch(
  record: SessionRecord,
  request: MemoryToolRequest,
  config: ResolvedConfig,
  now: number,
): MemoryToolOutcome {
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

  // Capture before the assignment: an undo restores the turn's starting document.
  captureMemory(record, record.memory, result.changed, now)
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
  config: ResolvedConfig,
): Promise<MemoryToolOutcome> {
  if (!config.refs) return { text: "smart_context: refs are disabled in this install", ok: false }
  const page = str(request.page)
  const section = str(request.section)
  const gist = str(request.gist)
  if (page === undefined || section === undefined || gist === undefined) {
    return { text: "smart_context: ref needs page, section and gist", ok: false }
  }
  const sectionText = deps.featureMap === undefined ? undefined : await deps.featureMap.readSection(deps.root ?? "", page, section)
  const verdict = refVerdict(gist, sectionText, config.charsPerToken)
  const entry = { page, section, gist, tokens: verdict.gistTokens }

  const before = record.memory.refs.map((ref) => ({ ...ref }))
  const index = record.memory.refs.findIndex((ref) => ref.page === page && ref.section === section)
  if (index >= 0) record.memory.refs[index] = entry
  else record.memory.refs.push(entry)

  const nextTokens = estimateTokens(memoryChars(record.memory), config.charsPerToken)
  if (nextTokens > config.memoryTokens) {
    record.memory.refs = before
    return {
      text: `smart_context: ref not stored — memory would be ${formatTokens(nextTokens)}/${formatTokens(config.memoryTokens)} est. Nothing was written.`,
      ok: false,
    }
  }
  // Capture only an accepted write: the over-cap refusal above left no trace.
  captureMemory(record, { ...record.memory, refs: before }, ["refs"], nowOf(deps))

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
  lines.push(usage(record, config))
  return { text: lines.join("\n"), ok: true }
}

function archive(
  record: SessionRecord,
  request: MemoryToolRequest,
  deps: MemoryToolDeps,
  config: ResolvedConfig,
): MemoryToolOutcome {
  const turn = str(request.turn)
  const gist = str(request.gist)
  if (turn === undefined || gist === undefined) {
    return { text: "smart_context: archive needs turn and gist", ok: false }
  }
  const entry = archivePending(record, turn, gist, request.keepRaw === true, {
    now: deps.now?.() ?? Date.now(),
    maxTurns: config.archiveMaxTurns,
    maxChars: config.archiveMaxChars,
  })
  if (entry === undefined) {
    const pending = record.pending.map((item) => item.id).join(", ") || "none"
    return { text: `smart_context: no pending turn ${JSON.stringify(turn)}. Pending: ${pending}`, ok: false }
  }
  return {
    text:
      entry.messages === undefined
        ? `archived ${turn} (gist only; the raw was discarded, so expand will show only this gist)\n` +
          usage(record, config)
        : `archived ${turn} (gist + raw)\n` + usage(record, config),
    ok: true,
  }
}

function purge(
  record: SessionRecord,
  request: MemoryToolRequest,
  config: ResolvedConfig,
  now: number,
): MemoryToolOutcome {
  const turn = str(request.turn)
  const query = str(request.query)
  if (turn !== undefined) {
    const removed = purgeWithUndo(record, turn, now)
    return { text: removed ? `purged ${turn}` : `smart_context: no turn ${JSON.stringify(turn)}`, ok: removed }
  }
  if (query !== undefined) {
    const before = record.archive.map((entry, index) => ({ entry, index }))
    const count = purgeQuery(record, query)
    if (count > 0) {
      const kept = new Set(record.archive.map((entry) => entry.id))
      for (const item of before) {
        if (!kept.has(item.entry.id)) capturePurge(record, "archive", item.entry, item.index, now)
      }
    }
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
 *
 * The plan/build pair never reaches this rail with both sides listed: those two
 * texts contradict each other and `state.ts` retires the older one as it folds
 * them, so the model is never asked to arbitrate a mode switch it cannot see.
 */
function notice(
  record: SessionRecord,
  request: MemoryToolRequest,
  config: ResolvedConfig,
  now: number,
): MemoryToolOutcome {
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
  const outcome = retirePinned(record, remove, now)
  if (!outcome.ok) return { text: `smart_context: ${outcome.text}`, ok: false }
  return { text: outcome.text + "\n" + usage(record, config), ok: true }
}
/**
 * Run one mutating action under the store's lock.
 *
 * `mutate` already retries once when another instance wrote in between; a second
 * loss is a real conflict, and the model hears it as a normal failed call instead
 * of a tool crash. Nothing was written in that case.
 */
async function mutateOutcome(
  deps: MemoryToolDeps,
  sessionID: string,
  fn: (record: SessionRecord) => MemoryToolOutcome | Promise<MemoryToolOutcome>,
): Promise<MemoryToolOutcome> {
  try {
    return await deps.store.mutate(sessionID, fn)
  } catch (error) {
    if (error instanceof StoreConflictError) return { text: `smart_context: ${error.message}`, ok: false }
    throw error
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

  // One cached read: a profile can change the caps this call enforces, and the
  // tool has no request event to read a model from. `mutate` still loads fresh
  // for the write itself - a pin set between this read and that write is a user
  // action, not a lost update, and the tool actions never change the pin.
  const caller = await deps.store.load(sessionID)
  const config = configForRecord(deps.config, caller)

  switch (action) {
    case "read":
      return read(caller, request, config)
    case "stats":
      return { text: renderStats(caller, config) + "\n" + usage(caller, config), ok: true }
    case "patch":
      return mutateOutcome(deps, sessionID, (record) =>
        patch(record, request, configForRecord(deps.config, record), nowOf(deps)),
      )
    case "ref":
      return mutateOutcome(deps, sessionID, (record) =>
        addRef(record, request, deps, configForRecord(deps.config, record)),
      )
    case "archive":
      return mutateOutcome(deps, sessionID, (record) =>
        archive(record, request, deps, configForRecord(deps.config, record)),
      )
    case "purge":
      return mutateOutcome(deps, sessionID, (record) =>
        purge(record, request, configForRecord(deps.config, record), nowOf(deps)),
      )
    case "notice":
      return mutateOutcome(deps, sessionID, (record) =>
        notice(record, request, configForRecord(deps.config, record), nowOf(deps)),
      )
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
      const target = await targetRecord(deps, request, sessionID, config)
      if (isOutcome(target)) return target
      const fromParent = request.from === "parent"
      const limit = typeof request.limit === "number" && Number.isFinite(request.limit) ? request.limit : 5
      const found = recall(target, query, limit)
      if (found.length === 0) {
        return { text: `no archived turn matches ${JSON.stringify(query)}${fromParent ? " in the spawning session's archive" : ""}`, ok: true }
      }
      const hint = fromParent ? delegatingNote(config) : ""
      const budget = Math.max(200, config.maxResultChars - hint.length)
      const lines: string[] = [`archive matches${fromParent ? " in the spawning session's archive" : ""}:`]
      let used = lines[0].length
      outer: for (const hit of found) {
        const entry = hit.entry
        const expandHint = entry.messages === undefined ? " (gist only)" : ` (expand: action:"expand" turn:"${entry.id}"${fromParent ? ' from:"parent"' : ""})`
        const head = `- ${entry.id} · ${entry.gist}${expandHint}`
        if (used + head.length + 1 > budget) {
          lines.push("[… more matches; narrow the query or raise limit only if you must]")
          break
        }
        lines.push(head)
        used += head.length + 1
        for (const snippet of hit.snippets) {
          const line = `    ${snippet.offset === undefined ? "" : `@${snippet.offset} `}${snippet.text}`
          if (used + line.length + 1 > budget) {
            lines.push("    [… snippets elided]")
            break outer
          }
          lines.push(line)
          used += line.length + 1
        }
      }
      return { text: lines.join("\n") + hint, ok: true }
    }
    case "expand": {
      const turn = str(request.turn)
      if (turn === undefined) return { text: "smart_context: expand needs turn", ok: false }
      const target = await targetRecord(deps, request, sessionID, config)
      if (isOutcome(target)) return target
      const entry = findArchived(target, turn)
      const waiting = entry === undefined ? findPending(target, turn) : undefined
      if (entry === undefined && waiting === undefined) {
        const pending = target.pending.map((item) => item.id).join(", ") || "none"
        return {
          text:
            `smart_context: no turn ${JSON.stringify(turn)} in the archive or the pending eviction queue. ` +
            `Pending: ${pending}`,
          ok: false,
        }
      }
      const gist = entry?.gist ?? waiting?.gist ?? ""
      const messages = entry !== undefined ? entry.messages : waiting?.messages
      if (messages === undefined || messages.length === 0) {
        return { text: `${gist}\n(gist only; no raw messages were kept)`, ok: true }
      }
      const mode = str(request.mode) ?? "page"
      if (mode !== "page" && mode !== "outline") {
        return {
          text: `smart_context: expand mode must be "page" or "outline", not ${JSON.stringify(mode)}`,
          ok: false,
        }
      }
      const { budget, hint } = expandBudget(config, request.from === "parent")
      // A pending read is not durable: the queue entry can be purged, and the
      // point of reading it is to decide whether to archive it with the raw.
      const note =
        waiting === undefined
          ? ""
          : `\n(pending turn: read from the eviction queue, which is not durable. Archive it with keepRaw:true to keep this raw.)`
      const room = Math.max(200, budget - note.length)
      const offset = typeof request.offset === "number" && Number.isFinite(request.offset) ? request.offset : undefined
      const limit = typeof request.limit === "number" && Number.isFinite(request.limit) ? request.limit : undefined
      const text =
        mode === "outline"
          ? turnOutline(messages, { budget: room })
          : turnPage(messages, { offset, limit, budget: room }).text
      return { text: text + note + hint, ok: true }
    }
    default:
      return { text: TOOL_HELP, ok: false }
  }
}

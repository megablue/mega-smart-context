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
}

export interface MemoryToolRequest extends MemoryToolInput {
  readonly sessionID: string
}

export interface MemoryToolDeps {
  readonly store: SessionStore
  readonly config: ResolvedConfig
  readonly featureMap?: FeatureMapPort
  readonly root?: string
  readonly now?: () => number
}

export interface MemoryToolOutcome {
  readonly text: string
  readonly ok: boolean
}

export const TOOL_HELP = `smart_context actions:
- read { key? }                          print one memory key, or the whole document
- patch { patch: { ... } }               merge a patch (maps merge, lists replace, null resets)
- stats                                 memory/working/archive usage
- ref { page, section, gist }            store a feature-map pointer and compare costs
- archive { turn, gist, keepRaw? }       move a pending turn to the archive
- purge { turn? | query? }               delete a pending/archived turn, or matching entries
- recall { query, lost:true }            search the archive only when a fact is missing
- expand { turn }                        read an archived turn back
- notice { remove? }                     list the pinned host notices, or drop a superseded one`

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
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
  if (key === undefined) return { text: renderMemory(record, config), ok: true }
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
 * the model, is what resolves a contradiction the host injected. This is the only
 * path that removes a notice; the context pass only ever adds the distinct texts
 * the host sent.
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
  const kept = notices.filter((entry) => entry.id !== remove)
  if (kept.length === notices.length) {
    const ids = notices.map((entry) => entry.id).join(", ") || "none"
    return { text: `smart_context: no pinned notice ${JSON.stringify(remove)}. Pinned: ${ids}`, ok: false }
  }
  record.notices = kept
  return { text: `removed pinned notice ${remove}\n` + usage(record, config), ok: true }
}

export async function runMemoryTool(
  request: MemoryToolRequest,
  deps: MemoryToolDeps,
): Promise<MemoryToolOutcome> {
  const sessionID = request.sessionID
  if (sessionID.length === 0) return { text: "smart_context: no session id", ok: false }
  const action = typeof request.action === "string" ? request.action : ""

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
      const record = await deps.store.load(sessionID)
      const limit = typeof request.limit === "number" && Number.isFinite(request.limit) ? request.limit : 5
      const found = recall(record, query, limit)
      if (found.length === 0) return { text: `no archived turn matches ${JSON.stringify(query)}`, ok: true }
      return {
        text:
          "archive matches:\n" +
          found
            .map(
              (entry) =>
                `- ${entry.id} · ${entry.gist}` +
                (entry.messages === undefined ? " (gist only)" : ` (expand: action:"expand" turn:"${entry.id}")`),
            )
            .join("\n"),
        ok: true,
      }
    }
    case "expand": {
      const turn = str(request.turn)
      if (turn === undefined) return { text: "smart_context: expand needs turn", ok: false }
      const record = await deps.store.load(sessionID)
      const entry = findArchived(record, turn)
      if (entry === undefined) return { text: `smart_context: no archived turn ${JSON.stringify(turn)}`, ok: false }
      if (entry.messages === undefined) {
        return { text: `${entry.gist}\n(gist only; no raw messages were kept)`, ok: true }
      }
      return { text: renderTurn(entry.messages, 20_000), ok: true }
    }
    default:
      return { text: TOOL_HELP, ok: false }
  }
}

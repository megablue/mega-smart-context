/**
 * Read a recorded session's context passes and compare them with what the same
 * session would have cost with the plugin disabled.
 *
 * Read-only, offline. It opens OpenCode's own SQLite database read-only and
 * never touches the host, the plugin, or the session. The plugin records one
 * `PassSample` per pass (the enabled payload beside the disabled baseline, both
 * exact at that moment); this tool reads those samples back and prints the
 * curve. A record written before `history` existed still reports its
 * `lastReport` and an approximate disabled baseline, clearly labelled as such.
 *
 * The record lives under a key the host builds from the plugin id: the id,
 * UTF-16BE encoded as hex, between `plugin:` and `:session/<id>`. Every plugin
 * id that owns a record for the session is listed, so a stale duplicate install
 * is visible rather than silently one of two.
 *
 * Usage:
 *
 *   node scripts/analyze.mjs                      # newest session in the cwd
 *   node scripts/analyze.mjs --session ses_...    # one session by id
 *   node scripts/analyze.mjs --dir <path>         # newest session in a directory
 *   node scripts/analyze.mjs --db <path> --json    # another database, machine output
 *
 * @module mega-smart-context/analyze.mjs
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"

import {
  DEFAULT_KEEP,
  DEFAULT_SUMMARY,
  UNKNOWN_WINDOW,
  simulateNative,
} from "./native-compaction.mjs"

const DEFAULT_DB = join(homedir(), ".local", "share", "opencode", "opencode.db")

/** The plugin's default `charsPerToken`; the record does not carry the resolved value. */
const CHARS_PER_TOKEN = 4

/** How many archive gists the text report prints before it stops. */
const ARCHIVE_GISTS_SHOWN = 20

function usage() {
  return [
    "Usage: node scripts/analyze.mjs [options]",
    "",
    "  --session <id>   analyze this session id (default: the newest in --dir)",
    "  --dir <path>     the directory whose newest session to analyze (default: cwd)",
    "  --db <path>      the OpenCode database (default: ~/.local/share/opencode/opencode.db)",
    "  --context <n>    model context window for the native baseline (default: 200000)",
    "  --keep <n>       tokens native compaction keeps verbatim (default: 15000)",
    "  --summary <n>    tokens a native summary is assumed to occupy (default: 2000)",
    "  --buffer <n>     reserve below the window instead of the default ~10%",
    "  --no-native      do not simulate native compaction",
    "  --json           emit the data as an object instead of a report",
    "  --help           this text",
  ].join("\n")
}

function positive(raw, flag) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} needs a positive number, got ${raw === undefined ? "nothing" : raw}`)
  }
  return value
}

function parseArgs(argv) {
  const args = {
    session: undefined,
    dir: resolve(process.cwd()),
    db: DEFAULT_DB,
    context: UNKNOWN_WINDOW,
    keep: DEFAULT_KEEP,
    summary: DEFAULT_SUMMARY,
    buffer: undefined,
    native: true,
    json: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--session") args.session = argv[index + 1]
    else if (flag === "--dir") args.dir = resolve(argv[index + 1])
    else if (flag === "--db") args.db = resolve(argv[index + 1])
    else if (flag === "--context") args.context = positive(argv[index + 1], flag)
    else if (flag === "--keep") args.keep = positive(argv[index + 1], flag)
    else if (flag === "--summary") args.summary = positive(argv[index + 1], flag)
    else if (flag === "--buffer") args.buffer = positive(argv[index + 1], flag)
    else if (flag === "--no-native") args.native = false
    else if (flag === "--json") args.json = true
    else if (flag === "--help" || flag === "-h") args.help = true
    else throw new Error(`unknown argument: ${flag}`)
    if (flag !== "--json" && flag !== "--no-native" && flag !== "--help" && flag !== "-h") index += 1
  }
  return args
}

/** The plugin id behind a host key: its UTF-16BE bytes, hex-encoded. */
function decodePluginId(hex) {
  if (hex.length === 0 || hex.length % 4 !== 0) return undefined
  const bytes = Buffer.from(hex, "hex")
  if (bytes.length === 0 || bytes.length % 2 !== 0) return undefined
  bytes.swap16()
  return bytes.toString("utf16le")
}

/** The stored record, whether the host handed a string, a blob, or an object. */
function parseRecord(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === "object" && !(value instanceof Uint8Array)) return value
  let text
  if (typeof value === "string") text = value
  else if (value instanceof Uint8Array) text = Buffer.from(value).toString("utf8")
  else return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function byteLengthOf(value) {
  if (typeof value === "string") return Buffer.byteLength(value)
  if (value instanceof Uint8Array) return value.length
  if (value !== null && typeof value === "object") return Buffer.byteLength(JSON.stringify(value))
  return 0
}

function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 100_000) return (tokens / 1000).toFixed(1).replace(/\.0$/, "") + "k"
  return Math.round(tokens / 1000) + "k"
}

/** `MM-DD HH:MM` — enough to tell passes apart without a 20-column timestamp. */
function formatClock(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "?"
  return new Date(ms).toISOString().slice(5, 16).replace("T", " ")
}

/** A token delta: negative keeps its sign, positive is plain. */
function formatDelta(value) {
  const tokens = Number(value)
  if (!Number.isFinite(tokens)) return "?"
  return tokens < 0 ? `-${formatTokens(-tokens)}` : formatTokens(tokens)
}

function formatShare(value, base) {
  if (!Number.isFinite(base) || base <= 0) return "n/a"
  return `${Math.round((Number(value) / base) * 100)}%`
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  if (bytes < 1000) return `${Math.round(bytes)} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1).replace(/\.0$/, "")}k B`
  return `${(bytes / 1_000_000).toFixed(2).replace(/\.00$/, "")}M B`
}

function oneLine(text, max = 64) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

function newestSession(db, directory) {
  // The host writes directories with forward slashes; a caller's cwd on Windows
  // does not. Compare with both separators folded, case-insensitively.
  return db
    .prepare(
      "SELECT id, directory, parent_id AS parentID, time_updated AS timeUpdated " +
        "FROM session_v2 WHERE replace(directory, '\\', '/') = replace(?, '\\', '/') COLLATE NOCASE " +
        "ORDER BY time_updated DESC LIMIT 1",
    )
    .get(directory)
}

function sessionByID(db, id) {
  return db
    .prepare(
      "SELECT id, directory, parent_id AS parentID, time_updated AS timeUpdated FROM session_v2 WHERE id = ?",
    )
    .get(id)
}

/** Every `plugin:<id>:session/<sid>` record, so a duplicate install cannot hide. */
function pluginRecords(db, sessionID) {
  const suffix = `:session/${sessionID}`
  const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'plugin:%'").all()
  const records = []
  for (const row of rows) {
    const key = String(row.key)
    if (!key.endsWith(suffix)) continue
    const hex = key.slice("plugin:".length, key.length - suffix.length)
    records.push({
      key,
      pluginID: decodePluginId(hex) ?? hex,
      bytes: byteLengthOf(row.value),
      record: parseRecord(row.value),
    })
  }
  return records
}

/** The durable transcript's size, in characters — the approximate disabled side. */
function transcriptEstimate(db, sessionID) {
  const row = db
    .prepare("SELECT COUNT(*) AS rows, SUM(LENGTH(data)) AS chars FROM session_message WHERE session_id = ?")
    .get(sessionID)
  const rows = Number(row?.rows ?? 0)
  const chars = Number(row?.chars ?? 0)
  return { rows, chars }
}

function summarizeHistory(history) {
  const totals = history.map((sample) => Number(sample.totalTokens) || 0)
  const peak = Math.max(...totals)
  const min = Math.min(...totals)
  const mean = Math.round(totals.reduce((sum, value) => sum + value, 0) / totals.length)
  const crossedAt = history.findIndex((sample) => sample.overBudget === true)
  return { count: history.length, peak, min, mean, crossedAt }
}

/** Join the native simulation to the measured totals: peaks and both savings. */
function baselineOf(history, options) {
  const series = history.map((sample) => (Number(sample.transcriptTokens) || 0) / CHARS_PER_TOKEN)
  const simulation = simulateNative(series, options)
  const peak = (values) => (values.length === 0 ? 0 : Math.max(...values))
  const oursPeak = peak(history.map((sample) => Number(sample.totalTokens) || 0))
  const rawPeak = peak(simulation.passes.map((pass) => pass.raw))
  const nativePeak = peak(simulation.passes.map((pass) => pass.native))
  return {
    ...simulation,
    rawPeak,
    nativePeak,
    oursPeak,
    savings: { vsRaw: rawPeak - oursPeak, vsNative: nativePeak - oursPeak },
  }
}

/** Read the database and return plain data — the text report is a view of it. */
export function analyze({ session, dir, db, context = UNKNOWN_WINDOW, keep = DEFAULT_KEEP, summary = DEFAULT_SUMMARY, buffer, native = true }) {
  if (!existsSync(db)) throw new Error(`no database at ${db}`)
  const sqlite = new DatabaseSync(db, { readOnly: true })
  try {
    const located = session === undefined ? newestSession(sqlite, dir) : (sessionByID(sqlite, session) ?? { id: session, directory: dir })
    if (located === undefined) throw new Error(`no session recorded for ${dir}`)

    const found = pluginRecords(sqlite, located.id)
    const primary = found.find((entry) => entry.record !== undefined) ?? found[0]
    if (primary === undefined || primary.record === undefined) {
      throw new Error(`no plugin record for ${located.id}; is the session new, or the plugin never installed?`)
    }

    const record = primary.record
    const memory = record.memory ?? {}
    const pending = Array.isArray(record.pending) ? record.pending : []
    const archive = Array.isArray(record.archive) ? record.archive : []
    const history = Array.isArray(record.history) ? record.history : undefined
    const baseline =
      history !== undefined && native
        ? baselineOf(history, { window: context, keep, summary, buffer })
        : null

    return {
      db,
      session: located.id,
      directory: located.directory ?? dir,
      parentID: located.parentID ?? null,
      plugins: found.map((entry) => ({
        id: entry.pluginID,
        key: entry.key,
        schema: entry.record?.version ?? null,
        bytes: entry.bytes,
      })),
      recordBytes: primary.bytes,
      version: record.version ?? null,
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null,
      seenTurns: Array.isArray(record.seenTurns) ? record.seenTurns.length : 0,
      goal: typeof memory.goal === "string" ? memory.goal : "",
      memoryChars: Buffer.byteLength(JSON.stringify(memory)),
      pending: pending.map((entry) => ({ id: entry.id, gist: entry.gist, chars: entry.chars, age: entry.age })),
      archive: archive.map((entry) => ({
        id: entry.id,
        gist: entry.gist,
        chars: entry.chars,
        hasRaw: Array.isArray(entry.messages),
      })),
      lastReport: record.lastReport ?? null,
      history: history ?? null,
      summary: history === undefined ? null : summarizeHistory(history),
      baseline,
      transcript: transcriptEstimate(sqlite, located.id),
    }
  } finally {
    sqlite.close()
  }
}

function renderPlugins(data) {
  const lines = ["plugins"]
  for (const plugin of data.plugins) {
    lines.push(`  ${plugin.id ?? plugin.key}  schema ${plugin.schema ?? "?"}  record ${formatBytes(plugin.bytes)}`)
  }
  if (data.plugins.length > 1) {
    lines.push(`  ! ${data.plugins.length} plugin ids own a record for this session — a stale install may be loading too`)
  }
  return lines.join("\n")
}

function renderHistory(history, summary, baseline) {
  const simulated =
    baseline !== null && baseline !== undefined && Array.isArray(baseline.passes) && baseline.passes.length === history.length
  const header = [
    "  #".padEnd(5),
    "when".padEnd(12),
    "turn".padEnd(11),
    "memory".padStart(8),
    "working".padStart(9),
    "policy".padStart(7),
    "total".padStart(8),
    "transcript".padStart(11),
    ...(simulated ? ["native".padStart(8), "saved".padStart(8)] : []),
    "over".padStart(5),
  ].join("")
  const rows = history.map((sample, index) => {
    const label = index === 0 && history.length > 1 ? `0*` : String(index)
    const transcript = formatTokens((Number(sample.transcriptTokens) || 0) / CHARS_PER_TOKEN)
    const pass = simulated ? baseline.passes[index] : undefined
    return [
      `  ${label}`.padEnd(5),
      formatClock(sample.at).padEnd(12),
      oneLine(sample.turn ?? "-", 10).padEnd(11),
      formatTokens(sample.memoryTokens).padStart(8),
      formatTokens(sample.workingTokens).padStart(9),
      formatTokens(sample.policyTokens).padStart(7),
      formatTokens(sample.totalTokens).padStart(8),
      transcript.padStart(11),
      ...(simulated
        ? [
            (pass.compacted ? `${formatTokens(pass.native)}↓` : formatTokens(pass.native)).padStart(8),
            formatDelta(pass.raw - (Number(sample.totalTokens) || 0)).padStart(8),
          ]
        : []),
      (sample.overBudget === true ? "yes" : "").padStart(5),
    ].join("")
  })
  const peak = `  peak ${formatTokens(summary.peak)} · min ${formatTokens(summary.min)} · mean ${formatTokens(summary.mean)}`
  const crossed =
    summary.crossedAt >= 0
      ? `  OVER CAP first at pass ${summary.crossedAt}${history[summary.crossedAt].turn ? ` (${history[summary.crossedAt].turn})` : ""}`
      : "  never over cap"
  const lines = [`passes ${summary.count} (history)`, header, ...rows, peak, crossed]
  if (simulated) {
    const ceilingShare = Number.isFinite(baseline.ceiling)
      ? `${Math.round((baseline.ceiling / baseline.window) * 100)}% of ${formatTokens(baseline.window)}`
      : "unbounded"
    const floorParts =
      baseline.buffer !== null
        ? `buffer ${formatTokens(baseline.buffer)}`
        : `${formatTokens(baseline.keep)} keep + ${formatTokens(baseline.summary)} summary`
    const count = `${baseline.compactions} compaction${baseline.compactions === 1 ? "" : "s"}`
    lines.push(
      `  baselines  raw ${formatTokens(baseline.rawPeak)} append-only · native (simulated) ${formatTokens(baseline.nativePeak)} · ` +
        `ours ${formatTokens(baseline.oursPeak)} (peaks)`,
      `  savings    vs raw ${formatDelta(baseline.savings.vsRaw)} (${formatShare(baseline.savings.vsRaw, baseline.rawPeak)}) · ` +
        `vs native ${formatDelta(baseline.savings.vsNative)} (${formatShare(baseline.savings.vsNative, baseline.nativePeak)})`,
      `  native     ${formatTokens(baseline.ceiling)} ceiling = ${ceilingShare} · floor ${formatTokens(baseline.floor)} = ` +
        `${floorParts} · ${count}`,
      "  transcript/raw are the disabled side in tokens (recorded chars ÷ 4) · native is simulated, ↓ marks a pass it",
      "  compacted · * is the kept first sample · the shared system prompt and tool schemas are excluded from both",
    )
  } else {
    lines.push("  transcript is the disabled side, in estimated tokens (recorded characters ÷ 4); * is the kept first sample")
  }
  return lines.join("\n")
}

function renderFallback(data) {
  const report = data.lastReport
  const lines = ["passes none (this record predates `history`)"]
  if (report !== null) {
    lines.push(
      `  lastReport  memory ${formatTokens(report.memoryTokens)} · working ${formatTokens(report.workingTokens)} · ` +
        `total ${formatTokens(report.totalTokens)} · ${report.workingTurns} kept · ${report.droppedTurns} dropped` +
        `${report.overBudget === true ? " · OVER CAP" : ""}`,
    )
  }
  lines.push(
    `  disabled baseline (approximate, from session_message): ${data.transcript.rows} rows, ` +
      `${formatTokens(data.transcript.chars)} chars ≈ ${formatTokens(data.transcript.chars / CHARS_PER_TOKEN)} tok`,
  )
  return lines.join("\n")
}

/** The text report. */
export function render(data) {
  const lines = [
    `session ${data.session}`,
    `directory ${data.directory}${data.parentID ? `  (child of ${data.parentID})` : ""}`,
    renderPlugins(data),
    data.history !== null ? renderHistory(data.history, data.summary, data.baseline) : renderFallback(data),
    `memory ${formatTokens(data.memoryChars)} chars · seenTurns ${data.seenTurns} · pending ${data.pending.length} · ` +
      `archive ${data.archive.length} · record ${formatBytes(data.recordBytes)}`,
    `goal: ${oneLine(data.goal, 100) || "(empty)"}`,
  ]
  if (data.pending.length > 0) {
    lines.push("pending")
    for (const entry of data.pending) {
      lines.push(`  - ${entry.id}  ${oneLine(entry.gist)}  (${formatTokens(entry.chars)} chars${entry.age ? `, age ${entry.age}` : ""})`)
    }
  }
  if (data.archive.length > 0) {
    lines.push("archive")
    for (const entry of data.archive.slice(0, ARCHIVE_GISTS_SHOWN)) {
      lines.push(`  - ${entry.id}  ${oneLine(entry.gist)}  (${formatTokens(entry.chars)} chars${entry.hasRaw ? ", raw" : ""})`)
    }
    if (data.archive.length > ARCHIVE_GISTS_SHOWN) {
      lines.push(`  … +${data.archive.length - ARCHIVE_GISTS_SHOWN} more (use --json for all)`)
    }
  }
  return lines.join("\n")
}

export function run(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n${usage()}\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  let data
  try {
    data = analyze(args)
  } catch (error) {
    process.stderr.write(`analyze: ${String(error?.message ?? error)}\n`)
    return 1
  }
  process.stdout.write((args.json ? JSON.stringify(data, null, 2) : render(data)) + "\n")
  return 0
}

const main = process.argv[1]
if (main !== undefined && pathToFileURL(resolve(main)).href === import.meta.url) {
  process.exitCode = run(process.argv.slice(2))
}

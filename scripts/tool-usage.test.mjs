/**
 * Track D tests: the completed-call pairing and the read-only tool usage report.
 *
 * Pure and local: a fake project store, no host, no model, no network. The
 * payload seam is not touched here.
 *
 * Run from the repo root: node scripts/tool-usage.test.mjs
 */

import test from "node:test"
import assert from "node:assert/strict"

import { isFailedToolResult, pairToolCalls } from "../src/core/tool-calls.ts"
import {
  TOOL_SESSIONS_MAX,
  TOOL_USAGE_MAX,
  ProjectStore,
  emptyProjectRecord,
  normalizeProjectRecord,
  projectKeyFor,
} from "../src/core/project.ts"
import {
  TOOL_USAGE_BACKFILL,
  TOOL_USAGE_UNUSED_PROMPTS,
  applyToolUsage,
  foldToolUsage,
  noteOfferedTools,
  sessionMark,
  toolAgeLabel,
  toolSummaryOf,
  toolUsageReport,
  toolUsageTurns,
} from "../src/core/tool-usage.ts"

const PROJECT = projectKeyFor("C:/repo")
const NOW = 1_800_000_000_000

function user(id, text = "SECRET_USER") {
  return { id, role: "user", content: [{ type: "text", text }] }
}

function call(id, callId, name, input = { command: "SECRET_COMMAND" }) {
  return { id, role: "assistant", content: [{ type: "tool-call", id: callId, name, input }] }
}

function result(id, callId, name, value = "SECRET_OUTPUT", extra = {}) {
  return {
    id,
    role: "tool",
    content: [{ type: "tool-result", id: callId, name, result: { type: "text", value }, ...extra }],
  }
}

let turnCounter = 0
function turn(id, calls = []) {
  turnCounter += 1
  const messages = [user(id)]
  calls.forEach((entry, index) => {
    const [callId, name, options = {}] = entry
    const suffix = id + "-" + index + "-" + turnCounter
    messages.push(call(suffix + "c", callId, name, options.input ?? { command: "SECRET_COMMAND" }))
    const reply = result(suffix + "r", callId, name, options.value ?? "SECRET_OUTPUT")
    Object.assign(reply.content[0], options.part ?? {})
    messages.push(reply)
  })
  return messages
}

function fold(record, session, messages, sessionID = "session-1", now = NOW) {
  const store = { mutate: async (key, fn) => fn(record) }
  return foldToolUsage(session, messages, { store, key: PROJECT, sessionID, now })
}

function row(name, overrides = {}) {
  return {
    calls: 1,
    ok: 1,
    failed: 0,
    prompts: 1,
    unusedPrompts: 0,
    lastAt: NOW,
    sessions: 1,
    sessionMarks: ["mark"],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

test("a completed call is paired with its result in result order", () => {
  const messages = [
    user("u"),
    call("c1", "a", "read"),
    call("c2", "b", "write"),
    result("r2", "b", "write"),
    result("r1", "a", "read"),
  ]
  assert.deepEqual(
    pairToolCalls(messages).map((pair) => [pair.id, pair.name, pair.ok, pair.order]),
    [
      ["b", "write", true, 0],
      ["a", "read", true, 1],
    ],
  )
})

test("a call without a result is ignored, and a duplicate result is ignored", () => {
  const messages = [
    user("u"),
    call("c1", "a", "read"),
    result("r1", "a", "read"),
    result("r1b", "a", "read"), // the call is already consumed
    call("c2", "b", "write"), // no result
    result("r2", "orphan", "bash"), // no matching call
  ]
  assert.deepEqual(
    pairToolCalls(messages).map((pair) => pair.id),
    ["a"],
  )
})

test("failure detection reads explicit errors, result type, success and exit fields", () => {
  const cases = [
    [{ isError: true }, true],
    [{ error: "boom" }, true],
    [{ result: { type: "text", value: "x", success: false } }, true],
    [{ result: { type: "error", value: "x" } }, true],
    [{ result: { type: "text", value: { exitCode: 1 } } }, true],
    [{ result: { type: "text", value: { code: 2 } } }, true],
    [{ result: { type: "text", value: { code: "ENOENT" } } }, true],
    [{ result: { type: "text", value: { code: "0" } } }, false],
    [{ result: { type: "text", value: { status: "failed" } } }, true],
    [{ result: { type: "text", value: { status: "failure" } } }, true],
    [{ result: { type: "text", value: { exitCode: 0 } } }, false],
    [{ result: { type: "text", value: { success: true } } }, false],
    [{ result: { type: "text", value: "plain output" } }, false],
  ]
  for (const [extra, failed] of cases) {
    const part = result("r", "c", "bash", "x", extra).content[0]
    assert.equal(isFailedToolResult(part), failed, JSON.stringify(extra))
  }
})

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

test("the newest user turn is current and never folded", async () => {
  const messages = [
    ...turn("t1", [["a", "read"]]),
    ...turn("t2", [["b", "write"]]),
  ]
  const record = emptyProjectRecord(PROJECT, NOW)
  const session = {}
  assert.equal(await fold(record, session, messages), true)
  assert.equal(record.toolUsage.read.calls, 1)
  assert.equal(record.toolUsage.write, undefined)
  assert.equal(record.envelope.promptTurns, 1)
  assert.deepEqual(session.toolsFolded, { turn: "t1", at: NOW })
})

test("one user turn means no completed turn and folds nothing", async () => {
  const record = emptyProjectRecord(PROJECT, NOW)
  const session = {}
  assert.equal(await fold(record, session, turn("t1", [["a", "read"]])), false)
  assert.equal(record.envelope.promptTurns, 0)
  assert.equal(session.toolsFolded, undefined)
})

test("a second fold is a no-op and a lost session cursor re-anchors without replay", async () => {
  const messages = [
    ...turn("t1", [["a", "read"]]),
    ...turn("t2", [["b", "write"]]),
    ...turn("t3", [["c", "bash"]]),
  ]
  const record = emptyProjectRecord(PROJECT, NOW)
  const session = {}
  assert.equal(await fold(record, session, messages), true)
  assert.equal(record.envelope.promptTurns, 2)
  assert.equal(record.toolUsage.read.calls, 1)
  assert.equal(record.toolUsage.write.calls, 1)

  assert.equal(await fold(record, session, messages), false)
  assert.equal(record.envelope.promptTurns, 2)
  assert.equal(record.toolUsage.read.calls, 1)

  // The transcript no longer contains the cursor turn: re-anchor on the newest
  // completed turn and fold nothing, even though a fresh project would backfill.
  const fresh = emptyProjectRecord(PROJECT, NOW)
  const lost = { toolsFolded: { turn: "gone", at: NOW - 1 } }
  assert.equal(await fold(fresh, lost, messages), false)
  assert.equal(fresh.envelope.promptTurns, 0)
  assert.equal(fresh.toolUsage.read, undefined)
  assert.deepEqual(lost.toolsFolded, { turn: "t2", at: NOW })
})

test("usageSeen makes replayed turns a no-op even when the cursor is behind", () => {
  const record = emptyProjectRecord(PROJECT, NOW)
  const turns = [{ id: "t1", tools: [{ name: "read", calls: 1, ok: 1, failed: 0 }] }]
  assert.equal(applyToolUsage(record, turns, { sessionID: "s1", now: NOW }), 1)
  assert.equal(applyToolUsage(record, turns, { sessionID: "s1", now: NOW + 1 }), 0)
  assert.equal(record.toolUsage.read.calls, 1)
  assert.equal(record.envelope.promptTurns, 1)
})

test("the first fold backfills only the newest 20 completed turns", async () => {
  const messages = []
  for (let index = 1; index <= 26; index += 1) {
    messages.push(...turn("t" + index, [["c" + index, "read"]]))
  }
  const record = emptyProjectRecord(PROJECT, NOW)
  const session = {}
  assert.equal(await fold(record, session, messages), true)
  assert.equal(record.envelope.promptTurns, TOOL_USAGE_BACKFILL)
  assert.equal(record.toolUsage.read.calls, TOOL_USAGE_BACKFILL)
  assert.deepEqual(session.toolsFolded, { turn: "t25", at: NOW })
})

test("ok and failed counts are per completed pair", async () => {
  const messages = [
    ...turn("t1", [
      ["a", "read"],
      ["b", "read", { part: { result: { type: "text", value: { exitCode: 1 } } } }],
      ["c", "bash", { part: { isError: true } }],
    ]),
    ...turn("t2", [["d", "read"]]),
  ]
  const record = emptyProjectRecord(PROJECT, NOW)
  await fold(record, {}, messages)
  assert.deepEqual(
    { calls: record.toolUsage.read.calls, ok: record.toolUsage.read.ok, failed: record.toolUsage.read.failed },
    { calls: 2, ok: 1, failed: 1 },
  )
  assert.deepEqual(
    { calls: record.toolUsage.bash.calls, ok: record.toolUsage.bash.ok, failed: record.toolUsage.bash.failed },
    { calls: 1, ok: 0, failed: 1 },
  )
})

test("prompts count once per tool per turn, however many calls it made", async () => {
  const messages = [
    ...turn("t1", [
      ["a", "read"],
      ["b", "read"],
      ["c", "read"],
    ]),
    ...turn("t2", [["d", "read"]]),
  ]
  const record = emptyProjectRecord(PROJECT, NOW)
  await fold(record, {}, messages)
  assert.equal(record.toolUsage.read.calls, 3)
  assert.equal(record.toolUsage.read.prompts, 1)
})

test("unusedPrompts increments for an existing tool that was not called and resets when called", async () => {
  const messages = [
    ...turn("t1", [["a", "read"]]),
    ...turn("t2", []), // completed turn with no tool call
    ...turn("t3", [["b", "read"]]),
    ...turn("t4", [["c", "write"]]), // current
  ]
  const record = emptyProjectRecord(PROJECT, NOW)
  const session = {}
  await fold(record, session, messages)
  // t1, t2 and t3 were complete; t4 is current. t3 called read, so the
  // unused marker from t2 reset before the fold ended.
  assert.equal(record.toolUsage.read.prompts, 2)
  assert.equal(record.toolUsage.read.unusedPrompts, 0)

  const next = [
    ...turn("t1", [["a", "read"]]),
    ...turn("t2", []),
    ...turn("t3", [["b", "read"]]),
    ...turn("t4", [["c", "write"]]),
    ...turn("t5", [["d", "bash"]]), // new current; t4 becomes complete
  ]
  await fold(record, session, next)
  // t3 called read, so the unused marker reset; t4 then did not call it.
  assert.equal(record.toolUsage.read.prompts, 2)
  assert.equal(record.toolUsage.read.unusedPrompts, 1)
})

test("sessions and sessionMarks saturate at TOOL_SESSIONS_MAX", async () => {
  const record = emptyProjectRecord(PROJECT, NOW)
  for (let index = 0; index < TOOL_SESSIONS_MAX + 1; index += 1) {
    const messages = [
      ...turn("t1", [["a", "read"]]),
      ...turn("t2", [["b", "write"]]), // current
    ]
    await fold(record, {}, messages, "session-" + index)
  }
  assert.equal(record.toolUsage.read.sessionMarks.length, TOOL_SESSIONS_MAX)
  assert.equal(record.toolUsage.read.sessions, TOOL_SESSIONS_MAX)
  assert.equal(record.envelope.sessionsSeen.length, TOOL_SESSIONS_MAX + 1)
  assert.equal(new Set(record.toolUsage.read.sessionMarks).size, TOOL_SESSIONS_MAX)
})

test("a real ProjectStore accepts the fold and normalizes it on load", async () => {
  const memory = new Map()
  const store = new ProjectStore(
    {
      get: async (key) => memory.get(key),
      set: async (key, value) => {
        memory.set(key, value)
      },
      remove: async (key) => {
        memory.delete(key)
      },
    },
    { now: () => NOW },
  )
  const messages = [...turn("t1", [["a", "read"]]), ...turn("t2", [["b", "write"]])]
  const session = {}
  assert.equal(await foldToolUsage(session, messages, { store, key: PROJECT, sessionID: "s1", now: NOW }), true)
  const loaded = await store.load(PROJECT, { fresh: true })
  assert.equal(loaded.toolUsage.read.calls, 1)
  assert.equal(loaded.envelope.promptTurns, 1)
  assert.equal(loaded.envelope.usageSeen.length, 1)
})

test("a project conflict leaves the session cursor unchanged", async () => {
  const messages = [...turn("t1", [["a", "read"]]), ...turn("t2", [["b", "write"]])]
  const session = {}
  const warnings = []
  const store = {
    mutate: async () => {
      throw new Error("another instance wrote first")
    },
  }
  const folded = await foldToolUsage(session, messages, {
    store,
    key: PROJECT,
    sessionID: "s1",
    now: NOW,
    warn: (line) => warnings.push(line),
  })
  assert.equal(folded, false)
  assert.equal(session.toolsFolded, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /session cursor is unchanged/u)
})

test("the project write runs before the session cursor is set", async () => {
  const messages = [...turn("t1", [["a", "read"]]), ...turn("t2", [["b", "write"]])]
  const record = emptyProjectRecord(PROJECT, NOW)
  const session = {}
  let cursorDuringProjectWrite
  const store = {
    mutate: async (key, fn) => {
      cursorDuringProjectWrite = session.toolsFolded
      return fn(record)
    },
  }
  await foldToolUsage(session, messages, { store, key: PROJECT, sessionID: "s1", now: NOW })
  assert.equal(cursorDuringProjectWrite, undefined)
  assert.deepEqual(session.toolsFolded, { turn: "t1", at: NOW })
})

test("the fold writes through the project key it was given", async () => {
  const record = emptyProjectRecord(PROJECT, NOW)
  const seen = []
  const store = {
    mutate: async (key, fn) => {
      seen.push(key.storageKey)
      return fn(record)
    },
  }
  const messages = [...turn("t1", [["a", "read"]]), ...turn("t2", [["b", "write"]])]
  await foldToolUsage({}, messages, { store, key: PROJECT, sessionID: "s1", now: NOW })
  assert.deepEqual(seen, [PROJECT.storageKey])
  assert.equal(record.toolUsage.read.calls, 1)
})

// ---------------------------------------------------------------------------
// Bounds and privacy
// ---------------------------------------------------------------------------

test("the normalizer folds the overflow into (other)", () => {
  const record = emptyProjectRecord(PROJECT, NOW)
  for (let index = 0; index < TOOL_USAGE_MAX + 1; index += 1) {
    record.toolUsage["tool-" + index] = row("read", { lastAt: NOW + index })
  }
  const normalized = normalizeProjectRecord(record, PROJECT, NOW)
  assert.equal(Object.keys(normalized.toolUsage).length, TOOL_USAGE_MAX)
  assert.notEqual(normalized.toolUsage["(other)"], undefined)
})

test("nothing but a tool name and its counters reaches the project or session record", async () => {
  const messages = [
    ...turn("t1", [["a", "read", { input: { command: "SECRET_COMMAND" }, value: "SECRET_OUTPUT" }]]),
    ...turn("t2", [["b", "write"]]),
  ]
  const record = emptyProjectRecord(PROJECT, NOW)
  const session = {}
  await fold(record, session, messages)
  const serialized = JSON.stringify({ record, session })
  for (const secret of ["SECRET_COMMAND", "SECRET_OUTPUT", "SECRET_USER"]) {
    assert.equal(serialized.includes(secret), false, secret + " leaked")
  }
  assert.deepEqual(Object.keys(record.toolUsage.read).sort(), [
    "calls",
    "failed",
    "lastAt",
    "ok",
    "prompts",
    "sessionMarks",
    "sessions",
    "unusedPrompts",
  ])
})

// ---------------------------------------------------------------------------
// Report and summary
// ---------------------------------------------------------------------------

test("the report shows the header, ten used rows, and the all footer", () => {
  const record = emptyProjectRecord(PROJECT, NOW - 5 * 86_400_000)
  for (let index = 0; index < 12; index += 1) {
    record.toolUsage["tool-" + index] = row("read", { lastAt: NOW - index * 60_000 })
  }
  const report = toolUsageReport(record, [], NOW)
  const lines = report.split("\n")
  assert.equal(lines[0], "tool usage · " + PROJECT.root + " · 0 prompts · 0 sessions · measured 5d")
  assert.equal(lines.filter((line) => line.includes(" calls (")).length, 10)
  assert.match(report, /2 more used tool\(s\) · \/context tools all/u)
  assert.equal(toolUsageReport(record, [], NOW, true).split("\n").filter((line) => line.includes(" calls (")).length, 12)
})

test("an empty record says so, and an offered-but-never-called tool is named", () => {
  const record = emptyProjectRecord(PROJECT, NOW)
  record.updatedAt = NOW - 120_000
  const empty = toolUsageReport(record, [], NOW)
  assert.match(empty, /no tool calls recorded yet/u)
  assert.match(empty, /0 prompts · 0 sessions · measured 2m/u)

  const used = emptyProjectRecord(PROJECT, NOW)
  used.toolUsage.read = row("read")
  const withOffer = toolUsageReport(used, ["read", "webfetch"], NOW)
  assert.match(withOffer, /never used \(offered, no completed call\)\n  webfetch$/u)
})

test("the report marks stale rows and counts a used offered tool as used", () => {
  const record = emptyProjectRecord(PROJECT, NOW)
  record.toolUsage.read = row("read", { lastAt: NOW - 9 * 86_400_000 })
  const report = toolUsageReport(record, ["read", "webfetch"], NOW)
  assert.match(report, /last 9d/u)
  assert.match(report, /never used \(offered, no completed call\)\n  webfetch/u)
  assert.match(toolUsageReport(record, ["read"], NOW), /every offered tool has been used/u)
})

test("unused tools need ten prompts, and a high-risk tool needs twenty", () => {
  const record = emptyProjectRecord(PROJECT, NOW)
  record.toolUsage.read = row("read", { unusedPrompts: 9 })
  record.toolUsage.bash = row("bash", { unusedPrompts: TOOL_USAGE_UNUSED_PROMPTS })
  const low = toolUsageReport(record, [], NOW)
  assert.doesNotMatch(low, /unused \(10\+ prompts/u)
  assert.doesNotMatch(low, /10 unused/u)

  record.toolUsage.read.unusedPrompts = TOOL_USAGE_UNUSED_PROMPTS
  const high = toolUsageReport(record, [], NOW)
  assert.match(high, /unused \(10\+ prompts or 5 sessions; high-risk thresholds doubled\)/u)
  assert.match(high, /read .*10 unused/u)
  assert.doesNotMatch(high, /bash .*10 unused/u)

  record.toolUsage.bash.unusedPrompts = TOOL_USAGE_UNUSED_PROMPTS * 2
  assert.match(toolUsageReport(record, [], NOW), /bash .*20 unused/u)
})

test("no unused tools is its own line once something has been called", () => {
  const record = emptyProjectRecord(PROJECT, NOW)
  record.toolUsage.read = row("read")
  assert.match(toolUsageReport(record, [], NOW), /no unused tools/u)
})

test("toolSummaryOf counts used, offered and never-used", () => {
  const record = emptyProjectRecord(PROJECT, NOW)
  record.toolUsage.read = row("read")
  record.envelope.promptTurns = 4
  record.envelope.sessionsSeen = ["a", "b"]
  assert.deepEqual(toolSummaryOf(record, ["read", "webfetch"], NOW), {
    used: 1,
    offered: 2,
    unused: 1,
    prompts: 4,
    sessions: 2,
  })
  const withoutOffer = toolSummaryOf(record, [], NOW)
  assert.equal("unused" in withoutOffer, false)
  assert.equal(withoutOffer.offered, 0)
})

test("toolAgeLabel is compact and deterministic", () => {
  assert.equal(toolAgeLabel(0, NOW), "never")
  assert.equal(toolAgeLabel(NOW - 1_000, NOW), "just now")
  assert.equal(toolAgeLabel(NOW - 3 * 60_000, NOW), "3m")
  assert.equal(toolAgeLabel(NOW - 2 * 3_600_000, NOW), "2h")
  assert.equal(toolAgeLabel(NOW - 5 * 86_400_000, NOW), "5d")
  assert.equal(toolAgeLabel(NOW - 70 * 86_400_000, NOW), "2mo")
})

test("toolUsageTurns groups each turn without raw content", () => {
  const messages = [
    ...turn("t1", [["a", "read"], ["b", "read"]]),
    ...turn("t2", [["c", "write"]]),
  ]
  const turns = toolUsageTurns(messages)
  assert.deepEqual(turns, [
    { id: "t1", tools: [{ name: "read", calls: 2, ok: 2, failed: 0 }] },
    { id: "t2", tools: [{ name: "write", calls: 1, ok: 1, failed: 0 }] },
  ])
  assert.equal(JSON.stringify(turns).includes("SECRET"), false)
})

test("offered tool names are normalized, deduped and bounded", () => {
  const session = {}
  noteOfferedTools(session, ["  read ", "read", "webfetch", ""])
  assert.deepEqual(session.offeredTools, ["read", "webfetch"])
  assert.equal(JSON.stringify(session).includes("command"), false)
})

test("sessionMark is short, stable and never the session id", () => {
  const mark = sessionMark("session-1")
  assert.equal(mark.length, 16)
  assert.equal(mark, sessionMark("session-1"))
  assert.notEqual(mark, sessionMark("session-2"))
  assert.notEqual(mark, "session-1")
})

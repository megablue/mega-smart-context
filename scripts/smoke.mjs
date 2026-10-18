/**
 * The pinning test.
 *
 * It asserts the behaviour the design cannot lose:
 *
 * - the durable transcript objects are not mutated;
 * - the payload is idempotent across two passes over the same conversation;
 * - a turn that leaves the window becomes pending, then auto-archives after the
 *   eviction lead;
 * - the tool's merge is schema-owned (null deletes, unknown drops) and an
 *   over-cap write is rejected rather than trimmed;
 * - `recall` refuses without `lost:true`;
 * - parent and child sessions have independent memory;
 * - compaction returns the memory document, not a second summary.
 *
 * Run from the repo root: `node scripts/smoke.mjs .`
 */

import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { parseLayer, resolveConfig } from "../src/core/config.ts"
import { buildPayload } from "../src/core/context.ts"
import { messagesChars } from "../src/core/measure.ts"
import { emptyMemory } from "../src/core/schema.ts"
import { MAX_HISTORY, SessionStore, trimHistory } from "../src/core/state.ts"
import { deriveVersion, readVersionBase } from "../src/core/version.ts"
import { balanceCuts, erodeToolResults, selectWorkingWindow, turnSpans } from "../src/core/view.ts"
import {
  DEFAULT_KEEP,
  DEFAULT_SUMMARY,
  calculateCeiling,
  simulateNative,
} from "./native-compaction.mjs"

const root = resolve(process.argv[2] ?? ".")
process.env.MEGA_SMART_CONTEXT_NO_USER_CONFIG = "1"

let passed = 0
function ok(value, label) {
  assert.ok(value, label)
  passed += 1
}

// ---------------------------------------------------------------------------
// Unit: config validation and the working-window arithmetic
// ---------------------------------------------------------------------------

assert.throws(() => parseLayer({ bogus: true }, "test"), /unknown key/, "unknown config keys are rejected")
passed += 1
assert.equal(parseLayer({ memoryTokens: 10 }, "test").memoryTokens, 1000, "memoryTokens has a floor")
passed += 1
assert.equal(parseLayer({ charsPerToken: 0 }, "test").charsPerToken, 2, "charsPerToken is clamped")
passed += 1

// ---------------------------------------------------------------------------
// Unit: the per-commit version arithmetic
// ---------------------------------------------------------------------------

const versionBase = readVersionBase({ version: "0.1.7", megaSmartContext: { countBase: 3 } })
assert.equal(versionBase.major, 0, "readVersionBase reads the major")
assert.equal(versionBase.minor, 1, "readVersionBase reads the minor")
assert.equal(versionBase.countBase, 3, "readVersionBase reads the count base")
passed += 1
assert.equal(deriveVersion(versionBase, 3), "0.1.0", "the patch counts from the base")
passed += 1
assert.equal(deriveVersion(versionBase, 11), "0.1.8", "the patch grows with the commit count")
passed += 1
assert.equal(deriveVersion(versionBase, 1), "0.1.0", "a count below the base clamps at zero")
passed += 1
assert.equal(deriveVersion({ major: 0, minor: 2, countBase: 0 }, 4), "0.2.4", "a zero base counts every commit")
passed += 1
assert.equal(readVersionBase({ version: "2.3.9", megaSmartContext: { countBase: 0 } }).major, 2, "a major other than zero reads")
passed += 1
assert.throws(() => readVersionBase({ version: "1.0.0" }), /countBase/, "a missing base is rejected")
passed += 1
assert.throws(() => readVersionBase({ version: "one.two.three", megaSmartContext: { countBase: 0 } }), /MAJOR/, "a non-numeric version is rejected")
passed += 1
assert.throws(() => readVersionBase({ version: "1.0.0", megaSmartContext: { countBase: -1 } }), /countBase/, "a negative base is rejected")
passed += 1

function user(id, text) {
  return { id, role: "user", content: [{ type: "text", text }] }
}
function assistant(id, text) {
  return { id, role: "assistant", content: [{ type: "text", text }] }
}
function call(id, callId, name, input) {
  return { id, role: "assistant", content: [{ type: "tool-call", id: callId, name, input }] }
}
function result(id, callId, name, value) {
  return { id, role: "tool", content: [{ type: "tool-result", id: callId, name, result: { type: "text", value } }] }
}

const transcript = [
  user("u1", "Build the context plugin. ".repeat(20)),
  call("a1", "c1", "read", { path: "src/core/context.ts" }),
  result("r1", "c1", "read", "x".repeat(5000)),
  assistant("a2", "Starting. ".repeat(20)),
  user("u2", "Now the working window. ".repeat(20)),
  assistant("a3", "Read. ".repeat(20)),
  user("u3", "Now the archive. ".repeat(20)),
  assistant("a4", "Archiving. ".repeat(20)),
]

assert.deepEqual(turnSpans(transcript).map((span) => span.id), ["u1", "u2", "u3"], "turns start at real user messages")
passed += 1
assert.doesNotThrow(() => balanceCuts(transcript), "the fixture pairs every tool call")
passed += 1
const win = selectWorkingWindow(transcript, { workingTokens: 300, charsPerToken: 4 })
ok(win.turns.length >= 1, "the window always keeps the current turn")
ok(win.chars <= 300 * 4 || win.overBudget, "the window stays within budget or reports the overrun")

// ---------------------------------------------------------------------------
// The host, in memory
// ---------------------------------------------------------------------------

function makeHost(options = {}) {
  const hooks = {}
  const tools = []
  const commands = []
  const replies = []
  const storage = new Map()
  const ctx = {
    location: { directory: root },
    options: {
      workingTokens: 300,
      memoryTokens: 3000,
      charsPerToken: 2,
      autoArchive: true,
      manualCommand: true,
      debug: false,
      ...options,
    },
    storage: {
      async get(key) {
        return storage.get(key)
      },
      async set(key, value) {
        storage.set(key, value)
      },
      async remove(key) {
        storage.delete(key)
      },
      async scan({ prefix, limit = 100 }) {
        const entries = [...storage.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .slice(0, limit)
          .map(([key, value]) => ({ key, value }))
        return { entries }
      },
    },
    session: {
      async hook(name, callback) {
        hooks[name] = callback
        return { dispose: async () => {} }
      },
      async get({ sessionID }) {
        return { parentID: sessionID.startsWith("child") ? "parent-1" : undefined, directory: root }
      },
      async context() {
        return []
      },
      async prompt({ sessionID, text }) {
        replies.push({ sessionID, text })
        return {}
      },
      async compact() {
        return {}
      },
    },
    tool: {
      async transform(callback) {
        callback({ add: (tool) => tools.push(tool) })
        return { dispose: async () => {} }
      },
      async list() {
        return tools.map((tool) => ({ name: tool.name }))
      },
    },
    command: {
      async transform(callback) {
        callback({ add: (command) => commands.push(command) })
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, hooks, tools, commands, replies }
}

const { default: plugin } = await import(pathToFileURL(resolve(root, "server.ts")).href)
ok(typeof plugin.setup === "function", "the server entry exports setup")

const host = makeHost()
const dispose = await plugin.setup(host.ctx)
ok(typeof host.hooks.context === "function", "the context hook is registered")
ok(typeof host.hooks.compaction === "function", "the compaction hook is registered")
ok(host.tools.length === 1 && host.tools[0].name === "smart_context", "smart_context is registered")
ok(host.commands.length === 1 && host.commands[0].name === "context", "/context is registered")

const tool = host.tools[0]
const callContext = { sessionID: "s1", agent: "build", messageID: "m", id: "t", signal: new AbortController().signal }

// ---------------------------------------------------------------------------
// First pass: payload shape, transcript safety, idempotence
// ---------------------------------------------------------------------------

const snapshot = transcript.map((message) => JSON.stringify(message))
const event = {
  sessionID: "s1",
  system: [{ type: "text", text: "base system" }],
  messages: [...transcript],
  tools: {},
  model: {},
}
const report = await host.hooks.context(event)

ok(event.messages[0].id === "megasc_memory", "the memory block is the first message")
ok(event.messages[0].content[0].text.includes("<smart-context>"), "the memory block has its delimiter")
ok(event.messages[0].content[0].text.includes("goal: (empty"), "an empty goal is visible to the model")
ok(event.system.some((part) => part.text.includes("You own this session's context")), "the policy is in system")
ok(event.tools.smart_context !== undefined, "smart_context is on the wire, not only in the registry")
ok(report.workingTurns >= 1 && report.workingTurns <= 3, "the working window is bounded")
assert.deepEqual(
  transcript.map((message) => JSON.stringify(message)),
  snapshot,
  "the durable transcript objects were not mutated",
)
passed += 1

const payload = event.messages.map((message) => JSON.stringify(message)).join("\n")
ok(!payload.includes("x".repeat(5000)), "an oversized tool result is eroded")
assert.doesNotThrow(() => balanceCuts(event.messages), "no call/result pair is split in the payload")
passed += 1

// A tool result can reach the host as a string (`text`), an array of parts
// (`content`), or a structured value (`json`). Erosion must keep the shape: the
// host maps over `content`, so turning it into a string aborts the session.
const multiPart = {
  id: "r2",
  role: "tool",
  content: [
    {
      type: "tool-result",
      id: "c2",
      name: "shell",
      result: {
        type: "content",
        value: [
          { type: "text", text: "y".repeat(3000) },
          { type: "text", text: "z".repeat(3000) },
        ],
      },
    },
  ],
}
const erodedMulti = erodeToolResults([multiPart], 4000)
const kept = erodedMulti.messages[0].content[0].result
ok(erodedMulti.eroded === 1, "a multi-part result is eroded")
ok(Array.isArray(kept.value), "a content result keeps its array shape")
ok(
  kept.value.every((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0),
  "the eroded content parts are still text parts",
)
ok(JSON.stringify(kept).length < 5200, "the multi-part result is actually shortened")
ok(multiPart.content[0].result.value[0].text.length === 3000, "the durable content result was not mutated")
assert.doesNotThrow(() => kept.value.map((part) => part.type), "the host can still map over the result")
passed += 1

const structured = {
  id: "r3",
  role: "tool",
  content: [
    { type: "tool-result", id: "c3", name: "shell", result: { type: "json", value: { body: "w".repeat(5000) } } },
  ],
}
const structuredOut = erodeToolResults([structured], 4000)
ok(structuredOut.eroded === 0, "a structured result is not eroded")
ok(
  structuredOut.messages[0].content[0].result === structured.content[0].result,
  "a structured result keeps its value rather than being retyped",
)
passed += 1

const eventAgain = {
  sessionID: "s1",
  system: [{ type: "text", text: "base system" }],
  messages: [...transcript],
  tools: {},
  model: {},
}
await host.hooks.context(eventAgain)
assert.deepEqual(eventAgain.messages, event.messages, "two passes over the same conversation produce the same payload")
passed += 1

// ---------------------------------------------------------------------------
// Pass history: one sample per pass, the transcript baseline, bounded
// ---------------------------------------------------------------------------

const histStore = new SessionStore()
const histConfig = resolveConfig({ options: { workingTokens: 500, memoryTokens: 3000, charsPerToken: 2 } })
const histDeps = { store: histStore, config: histConfig }
const passOf = (sessionID, messages) =>
  buildPayload({ sessionID, system: [{ type: "text", text: "base" }], messages, model: {} }, histDeps)

const firstPass = await passOf("hist", transcript)
const histRecord = await histStore.load("hist")
ok(Array.isArray(histRecord.history) && histRecord.history.length === 1, "a pass appends one history sample")
assert.equal(
  histRecord.history[0].transcriptTokens,
  messagesChars(transcript),
  "transcriptTokens is the raw input's character count",
)
passed += 1
const sampleZero = histRecord.history[0]
ok(
  sampleZero.totalTokens === sampleZero.memoryTokens + sampleZero.workingTokens + sampleZero.policyTokens,
  "totalTokens is memory + working + policy",
)

const firstBytes = firstPass.messages.map((message) => JSON.stringify(message)).join("\n")
const againPass = await passOf("hist", transcript)
ok(
  againPass.messages.map((message) => JSON.stringify(message)).join("\n") === firstBytes,
  "a repeat pass over the same transcript keeps the payload bytes",
)
ok((await histStore.load("hist")).history.length === 2, "every pass appends a sample")

const many = Array.from({ length: MAX_HISTORY + 50 }, (_, index) => ({ ...sampleZero, at: index }))
const trimmed = trimHistory(many)
ok(trimmed.length === MAX_HISTORY, "history trims to MAX_HISTORY")
ok(trimmed[0].at === 0, "the first sample is always kept")
ok(trimmed[trimmed.length - 1].at === many[many.length - 1].at, "the newest sample is kept")

// ---------------------------------------------------------------------------
// Native compaction: the second baseline in the report
// ---------------------------------------------------------------------------

ok(calculateCeiling(200_000) === 180_000, "the ceiling leaves 10% of a 200k window")
ok(calculateCeiling(20_000) === 18_000, "a window too small for 16k keeps 10% instead")
ok(calculateCeiling(200_000, 30_000) === 170_000, "an explicit buffer replaces the reserve")

const saw = simulateNative([50_000, 91_000], { window: 100_000 })
ok(saw.floor === DEFAULT_KEEP + DEFAULT_SUMMARY, "the native floor is keep + summary")
ok(saw.passes[0].native === 50_000 && saw.passes[0].compacted === false, "below the ceiling nothing compacts")
ok(
  saw.passes[1].native === saw.floor && saw.passes[1].compacted === true && saw.compactions === 1,
  "crossing the ceiling resets to the floor",
)

const anchor = simulateNative([50_000, 85_000, 40_000], { window: 100_000 })
ok(
  anchor.passes[2].native === 40_000 && anchor.passes[2].compacted === false,
  "an observed drop anchors native instead of resetting it",
)
ok(anchor.passes[2].raw === 85_000, "raw keeps the positive deltas and ignores the drop")

const grown = simulateNative([50_000, 85_000, 40_000, 60_000], { window: 100_000 })
ok(grown.passes[3].native === 60_000, "native grows again after an anchored reset")
ok(grown.passes[3].raw === 105_000, "raw is the sum of positive deltas")

const noSummary = simulateNative([10], { window: 10_000, summary: 0 })
ok(noSummary.floor === DEFAULT_KEEP && noSummary.compactions === 0, "a summary of zero does not crash the floor")

// ---------------------------------------------------------------------------
// The tool: schema-owned merge, cap rejection, refs
// ---------------------------------------------------------------------------

let outcome = await tool.execute(
  { action: "patch", patch: { goal: "ship v0.1", facts: { a: "b" }, mystery: 1 } },
  callContext,
)
ok(outcome.content[0].text.includes("dropped unknown key"), "unknown patch keys are dropped")
outcome = await tool.execute({ action: "read", key: "goal" }, callContext)
ok(outcome.content[0].text.includes("ship v0.1"), "goal is written")

outcome = await tool.execute({ action: "patch", patch: { facts: { a: null } } }, callContext)
outcome = await tool.execute({ action: "read", key: "facts" }, callContext)
ok(!outcome.content[0].text.includes('"a"'), "null deletes one map entry")

outcome = await tool.execute({ action: "patch", patch: { notes: "z".repeat(20_000) } }, callContext)
ok(outcome.content[0].text.includes("rejected"), "an over-cap memory write is rejected")
outcome = await tool.execute({ action: "read", key: "notes" }, callContext)
ok(!outcome.content[0].text.includes("zzzz"), "the rejected write did not land")

outcome = await tool.execute(
  { action: "ref", page: "context-handoff.md", section: "How & why", gist: "one line" },
  callContext,
)
ok(outcome.content[0].text.includes("stored ref"), "a feature-map ref is stored")

// ---------------------------------------------------------------------------
// Eviction: pending, then auto-archive after the lead
// ---------------------------------------------------------------------------

const transcript2 = [
  ...transcript,
  user("u4", "New turn. ".repeat(20)),
  assistant("a5", "Done. ".repeat(20)),
  user("u5", "One more. ".repeat(20)),
  assistant("a6", "More. ".repeat(20)),
]
const event3 = {
  sessionID: "s1",
  system: [{ type: "text", text: "base" }],
  messages: [...transcript2],
  tools: {},
  model: {},
}
await host.hooks.context(event3)
const pendingText = event3.messages[0].content[0].text
ok(pendingText.includes("Pending eviction"), "an evicted turn is shown as pending")

const transcript3 = [...transcript2, user("u6", "Another turn. ".repeat(20)), assistant("a7", "Ok. ".repeat(20))]
const event4 = {
  sessionID: "s1",
  system: [{ type: "text", text: "base" }],
  messages: [...transcript3],
  tools: {},
  model: {},
}
await host.hooks.context(event4)
const stats = await tool.execute({ action: "stats" }, callContext)
ok(/archive [1-9]/.test(stats.content[0].text), "the pending turn auto-archived after the lead")

outcome = await tool.execute({ action: "recall", query: "archive" }, callContext)
ok(outcome.content[0].text.includes("lost:true"), "recall refuses without lost:true")
outcome = await tool.execute({ action: "recall", query: "archive", lost: true }, callContext)
ok(outcome.content[0].text.includes("archive matches"), "recall returns matches when lost:true")

// ---------------------------------------------------------------------------
// Subagents: independent memory
// ---------------------------------------------------------------------------

const childEvent = {
  sessionID: "child-1",
  system: [{ type: "text", text: "base" }],
  messages: [user("cu1", "child task")],
  tools: {},
  model: {},
}
await host.hooks.context(childEvent)
ok(childEvent.messages[0].content[0].text.includes("goal: (empty"), "a child starts with its own empty memory")
const childContext = { ...callContext, sessionID: "child-1" }
await tool.execute({ action: "patch", patch: { goal: "child goal" } }, childContext)
const parentGoal = await tool.execute({ action: "read", key: "goal" }, callContext)
const childGoal = await tool.execute({ action: "read", key: "goal" }, childContext)
ok(parentGoal.content[0].text.includes("ship v0.1"), "the parent goal is unchanged by the child")
ok(childGoal.content[0].text.includes("child goal"), "the child has its own goal")

// ---------------------------------------------------------------------------
// Compaction and the command
// ---------------------------------------------------------------------------

const compaction = { sessionID: "s1", system: [], messages: [], tools: {} }
const compactionOutcome = await host.hooks.compaction(compaction)
ok(compactionOutcome?.owned === true, "compaction is owned when memory is non-empty")
ok(compaction.result.summary.includes("ship v0.1"), "compaction returns the memory document")

await host.commands[0].execute({ sessionID: "s1", prompt: { text: "/context" } })
ok(host.replies.at(-1).text.includes("smart-context"), "/context prints the status")
ok(
  /^smart-context v\d+\.\d+\.\d+ · /.test(host.replies.at(-1).text),
  "/context status shows the build's version",
)
await host.commands[0].execute({ sessionID: "s1", prompt: { text: "/context memory goal" } })
ok(host.replies.at(-1).text.includes("ship v0.1"), "/context memory reads one key")

// ---------------------------------------------------------------------------
// subagents:false passes a child through untouched
// ---------------------------------------------------------------------------

const host2 = makeHost({ subagents: false, manualCommand: false })
await plugin.setup(host2.ctx)
const childPassThrough = {
  sessionID: "child-2",
  system: [{ type: "text", text: "base" }],
  messages: [user("cu2", "child task")],
  tools: {},
  model: {},
}
const before = childPassThrough.messages.length
await host2.hooks.context(childPassThrough)
ok(childPassThrough.messages.length === before, "subagents:false leaves a child session alone")

await dispose()
console.log(`smoke: ${passed} assertions passed`)

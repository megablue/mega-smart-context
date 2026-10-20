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
import { runMemoryTool } from "../src/core/memory-tool.ts"
import { messageChars, messagesChars } from "../src/core/measure.ts"
import { NOTICE_HEADING, POLICY } from "../src/core/prompts.ts"
import { emptyMemory } from "../src/core/schema.ts"
import { MAX_HISTORY, MAX_NOTICES, MAX_NOTICE_CHARS, MAX_RETIRED, SessionStore, pruneOrphans, retireNotice, sameDirectory, trimHistory, upsertNotices } from "../src/core/state.ts"
import { extractHtmlSection, extractSection, htmlToText, pageCandidates } from "../src/core/refs.ts"
import { deriveVersion, readVersionBase } from "../src/core/version.ts"
import { balanceCuts, erodeToolResults, hostMessageOf, isHostCue, isHostJob, isHostMessage, isHostTail, isRealUser, noticeOf, selectWorkingWindow, splitNotices, turnSpans } from "../src/core/view.ts"
import { livenessFromError } from "../src/adapters/opencode/sessions.ts"
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
// Host notices: pinned into the system prompt, not replayed as turns
// ---------------------------------------------------------------------------

function noticeMsg(id, text, marker = "") {
  return { id, role: "user", content: [{ type: "text", text: text + marker }] }
}
const PLAN_NOTICE = "<system-reminder>\nYou are in Plan mode. Discuss the plan.\n</system-reminder>"
const BUILD_NOTICE = "<system-reminder>\nYou are NO LONGER in Plan mode.\n</system-reminder>"

ok(noticeOf(noticeMsg("n1", PLAN_NOTICE, "\n@1@"))?.text === PLAN_NOTICE, "a notice with a trailing @n@ marker is recognised")
ok(noticeOf(noticeMsg("n2", "You are in Plan mode.")) === undefined, "a plain user message is not a notice")
ok(
  noticeOf({ id: "n3", role: "user", content: [{ type: "text", text: PLAN_NOTICE }, { type: "text", text: "x" }] }) ===
    undefined,
  "a multi-part user message is not a notice",
)
ok(
  noticeOf({ id: "n4", role: "user", content: [{ type: "text", text: PLAN_NOTICE + "\nand also do X" }] }) === undefined,
  "a reminder with trailing prose is a real turn, not a notice",
)

const withNotices = [
  user("u1", "First request. ".repeat(10)),
  noticeMsg("n-plan", PLAN_NOTICE),
  assistant("a1", "Working. ".repeat(10)),
  noticeMsg("n-build", BUILD_NOTICE),
  user("u2", "Continue. ".repeat(10)),
  assistant("a2", "Done. ".repeat(10)),
]
ok(turnSpans(withNotices).length === 4, "left in place each notice would be a phantom turn")
const split = splitNotices(withNotices)
ok(split.rest.length === 4, "both notices are removed from the window")
ok(split.notices.length === 2 && split.notices[0].id === "n-plan", "notices come back in transcript order")
ok(turnSpans(split.rest).length === 2, "a mode switch is not a turn")

const noticeStore = new SessionStore()
const noticeConfig = resolveConfig({ options: { workingTokens: 500, memoryTokens: 3000, charsPerToken: 2 } })
const noticeDeps = { store: noticeStore, config: noticeConfig }
const noticePass = (sessionID, messages, system = [{ type: "text", text: "base" }]) =>
  buildPayload({ sessionID, system, messages, model: {} }, noticeDeps)

const p1 = await noticePass("n", withNotices)
ok(p1.messages.every((message) => !JSON.stringify(message).includes("system-reminder")), "the notice is not in the payload")
const pinned = p1.system.find((part) => part.text.startsWith(NOTICE_HEADING))
ok(pinned !== undefined, "the notices are pinned into a system part")
ok(pinned.text.includes("n-plan") && pinned.text.includes("n-build"), "both notices are listed")
ok(pinned.text.indexOf("n-build") < pinned.text.indexOf("n-plan"), "the newest notice is listed first")
ok(p1.system[p1.system.length - 1].text.startsWith(NOTICE_HEADING), "the pinned notices are the last system part")
ok(
  p1.system.findIndex((part) => part.text === POLICY) < p1.system.length - 1,
  "the policy sits before the pinned notices",
)
const p2 = await noticePass("n", withNotices, p1.system)
ok(
  p2.system.filter((part) => part.text.startsWith(NOTICE_HEADING)).length === 1,
  "a re-pass that carries the previous block adds no second copy",
)
ok(
  p2.system[p2.system.length - 1].text.startsWith(NOTICE_HEADING),
  "the notices stay last on a re-pass over the previous system parts",
)
const nrec = await noticeStore.load("n")
ok(nrec.notices.length === 2, "the record pins each distinct notice once")
const atBefore = JSON.stringify(nrec.notices)
await noticePass("n", withNotices)
const nrec2 = await noticeStore.load("n")
ok(JSON.stringify(nrec2.notices) === atBefore, "a re-run leaves the pinned notices byte-identical")

// A mode switch carries no user turn: it must not age a pending turn out.
const ageStore = new SessionStore()
const ageConfig = resolveConfig({
  options: { workingTokens: 500, memoryTokens: 3000, charsPerToken: 2, autoArchive: true, evictionLead: 1 },
})
const ageDeps = { store: ageStore, config: ageConfig }
const agePass = (messages) =>
  buildPayload({ sessionID: "age", system: [{ type: "text", text: "base" }], messages, model: {} }, ageDeps)
const firstTurn = [user("u1", "First. ".repeat(100)), assistant("a1", "Answer. ".repeat(100))]
const secondTurn = [user("u2", "Second. ".repeat(100)), assistant("a2", "Again. ".repeat(100))]
await agePass(firstTurn)
const bReport = await agePass([...firstTurn, ...secondTurn])
const afterB = await ageStore.load("age")
ok(afterB.pending.some((pending) => pending.id === "u1"), "a turn that leaves the window becomes pending")
const cReport = await agePass([...firstTurn, ...secondTurn, noticeMsg("n-mode", BUILD_NOTICE)])
const afterC = await ageStore.load("age")
ok(cReport.report.workingTurns === bReport.report.workingTurns, "a mode switch adds no working turn")
ok(afterC.pending.some((pending) => pending.id === "u1"), "a mode switch does not age a pending turn")
ok(afterC.archive.length === 0, "a mode switch does not archive a pending turn")

// action:notice — list, refuse the newest, retire an older one.
const toolDeps = { store: noticeStore, config: noticeConfig }
const toolWindow = [user("u1", "hi"), noticeMsg("n-old", PLAN_NOTICE), noticeMsg("n-new", BUILD_NOTICE)]
await noticePass("notice-tool", toolWindow)
const listOut = await runMemoryTool({ sessionID: "notice-tool", action: "notice" }, toolDeps)
ok(listOut.ok && listOut.text.includes("n-old") && listOut.text.includes("n-new"), "action:notice lists the pinned notices")
const refuseNewest = await runMemoryTool({ sessionID: "notice-tool", action: "notice", remove: "n-new" }, toolDeps)
ok(!refuseNewest.ok && /newest/.test(refuseNewest.text), "the newest notice refuses removal")
const removeOlder = await runMemoryTool({ sessionID: "notice-tool", action: "notice", remove: "n-old" }, toolDeps)
ok(removeOlder.ok, "an older notice can be removed")
const remaining = await noticeStore.load("notice-tool")
ok(remaining.notices.length === 1 && remaining.notices[0].id === "n-new", "only the retired notice is gone")

// Removal is sticky: the text is still in the window, so the pass must skip it.
await noticePass("notice-tool", toolWindow)
const afterReadd = await noticeStore.load("notice-tool")
ok(
  afterReadd.notices.length === 1 && afterReadd.notices[0].id === "n-new",
  "a retired notice is not re-added while its text is still in the window",
)
const reemitted = await noticePass("notice-tool", [...toolWindow, noticeMsg("n-old2", PLAN_NOTICE)])
ok(reemitted !== undefined, "a second emission of the retired text is still a notice")
const afterReemit = await noticeStore.load("notice-tool")
ok(afterReemit.notices.length === 2, "the same text emitted under a new id returns")
ok(afterReemit.notices[afterReemit.notices.length - 1].id === "n-old2", "the returning notice is the newest")
ok((afterReemit.retired ?? []).length === 0, "the retirement clears once the text is re-emitted")

// Recency: re-seeing a text moves it to the end, so the rail protects the live one.
const recWindow = [user("u1", "hi"), noticeMsg("r-plan", PLAN_NOTICE)]
await noticePass("recency", recWindow)
const recWindow2 = [...recWindow, noticeMsg("r-build", BUILD_NOTICE)]
await noticePass("recency", recWindow2)
const recWindow3 = [...recWindow2, noticeMsg("r-plan2", PLAN_NOTICE)]
await noticePass("recency", recWindow3)
const recRec = await noticeStore.load("recency")
ok(recRec.notices[recRec.notices.length - 1].id === "r-plan2", "a re-seen notice moves to the end")
ok(recRec.notices[0].id === "r-build", "the text seen least recently is first")
const recRefuse = await runMemoryTool({ sessionID: "recency", action: "notice", remove: "r-plan2" }, toolDeps)
ok(!recRefuse.ok && /newest/.test(recRefuse.text), "the rail refuses the text the host emitted most recently")
const recAllow = await runMemoryTool({ sessionID: "recency", action: "notice", remove: "r-build" }, toolDeps)
ok(recAllow.ok, "the stale text is removable")

// The fold rules, directly: skip a retired generation, return on a new one.
const skipped = upsertNotices([], [{ id: "s1", text: PLAN_NOTICE }], 1, [{ id: "s1", text: PLAN_NOTICE }])
ok(skipped.notices.length === 0 && skipped.retired.length === 1, "a found text whose newest occurrence is retired is skipped")
const returns = upsertNotices([], [{ id: "s2", text: PLAN_NOTICE }], 1, [{ id: "s1", text: PLAN_NOTICE }])
ok(returns.notices.length === 1 && returns.retired.length === 0, "a new id clears the retirement and returns the text")
let retirements = []
for (let index = 0; index < MAX_RETIRED + 5; index += 1) {
  retirements = retireNotice(retirements, { id: `rt${index}`, text: `note ${index}`, at: 0 })
}
ok(retirements.length === MAX_RETIRED, "the retirement list is bounded")
ok(retirements[0].id === "rt5", "the oldest retirement is dropped first")

const manyNotices = []
for (let index = 1; index <= 10; index += 1) {
  manyNotices.push(noticeMsg(`nx${index}`, `<system-reminder>\nNotice ${index}\n</system-reminder>`))
}
await noticePass("many", [user("u1", "hi"), ...manyNotices])
const manyRec = await noticeStore.load("many")
ok(manyRec.notices.length === MAX_NOTICES, "the notice list is capped at MAX_NOTICES")
ok(manyRec.notices[0].id === "nx3", "the oldest notices are dropped first")
ok(manyRec.notices[manyRec.notices.length - 1].id === "nx10", "the newest notice always survives")

const long = "<system-reminder>\n" + "z".repeat(6000) + "\n</system-reminder>"
const headKept = upsertNotices([], [{ id: "big", text: long }], 1)
ok(headKept.notices[0].text.length <= MAX_NOTICE_CHARS + 40, "an over-long notice is head-kept")
ok(headKept.notices[0].text.startsWith("<system-reminder>"), "the head of an over-long notice is kept")
ok(headKept.notices[0].text.includes("truncated"), "an over-long notice gets a truncation marker")

const plain = await noticePass("plain", [user("u1", "hello")])
ok(plain.system.every((part) => !part.text.startsWith(NOTICE_HEADING)), "an empty notice list adds no system part")
const noneOut = await runMemoryTool({ sessionID: "plain", action: "notice" }, noticeDeps)
ok(noneOut.ok && /no pinned/.test(noneOut.text), "listing with no notices is a clean empty answer")

// ---------------------------------------------------------------------------
// Prefix caching: no live numbers in the block, and a window message's bytes
// never change once it has been sent
// ---------------------------------------------------------------------------

ok(!event.messages[0].content[0].text.includes("budget:"), "the memory block carries no budget line")
ok(
  !/^(memory|working|refs|pending|archive) /.test(event.messages[0].content[0].text.split("\n")[1] ?? ""),
  "the memory block's second line is not a counter",
)

function withReasoning(id, reasoning, text) {
  return {
    id,
    role: "assistant",
    content: [
      { type: "reasoning", text: reasoning },
      { type: "text", text },
    ],
  }
}

const cacheStore = new SessionStore()
const cacheDeps = {
  store: cacheStore,
  config: resolveConfig({ options: { workingTokens: 20_000, memoryTokens: 3000, charsPerToken: 2 } }),
}
const cachePass = (messages) =>
  buildPayload({ sessionID: "cache", system: [{ type: "text", text: "base" }], messages, model: {} }, cacheDeps)

const cacheTurn1 = [
  user("u1", "First. ".repeat(40)),
  withReasoning("a1", "private step. ".repeat(40), "Answer. ".repeat(20)),
]
const cached1 = await cachePass(cacheTurn1)
const sentA1 = cached1.messages.find((message) => message.id === "a1")
ok((sentA1.content ?? []).some((part) => part.type === "reasoning"), "reasoning is kept in the payload")
const cached2 = await cachePass([
  ...cacheTurn1,
  user("u2", "Second. ".repeat(40)),
  assistant("a2", "Again. ".repeat(20)),
])
ok(
  JSON.stringify(cached2.messages.find((message) => message.id === "a1")) === JSON.stringify(sentA1),
  "a completed turn's bytes do not change when the next turn arrives",
)
ok(
  cached1.messages[0].content[0].text === cached2.messages[0].content[0].text,
  "the memory block is byte-identical when only the window grew",
)

// ---------------------------------------------------------------------------
// Host messages that are not user turns: job completions and the output nudge
// ---------------------------------------------------------------------------

const OUTPUT_NUDGE =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces."
const SHELL_JOB = '<shell id="sh_1" state="completed" command="npm test">\nall good\n</shell>'
const SUBAGENT_JOB = '<subagent sessionID="ses_1" state="completed" description="research">\nfindings\n</subagent>'

ok(hostMessageOf(noticeMsg("o1", OUTPUT_NUDGE))?.kind === "notice", "the output-limit nudge is a notice")
ok(noticeOf(noticeMsg("o1", OUTPUT_NUDGE, "\n@3@"))?.text === OUTPUT_NUDGE, "the nudge is recognised with a trailing @n@ marker")
ok(
  noticeOf(noticeMsg("o2", "The output token limit stopped your reply short.")) === undefined,
  "a message merely about the limit is not the nudge",
)
ok(hostMessageOf(noticeMsg("j1", SHELL_JOB))?.kind === "job", "a shell completion is a job")
ok(noticeOf(noticeMsg("j1", SHELL_JOB)) === undefined, "a job is not a notice, so it is never pinned")
ok(hostMessageOf(noticeMsg("j2", SUBAGENT_JOB))?.kind === "job", "a subagent completion is a job")
ok(isHostMessage(noticeMsg("j2", SUBAGENT_JOB)) && isHostJob(noticeMsg("j2", SUBAGENT_JOB)), "a job is a host message")
ok(isRealUser(noticeMsg("j1", SHELL_JOB)) === false, "a job does not start a turn")
ok(isRealUser(user("ur", "a real request")) === true, "a plain user message still starts a turn")
ok(hostMessageOf(user("ur", "a real request")) === undefined, "a real message is not a host message")

// The host's "previous response was interrupted" sentence is a cue: a tail of the
// running turn, never pinned.
const INTERRUPTED =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."
ok(hostMessageOf(noticeMsg("c1", INTERRUPTED))?.kind === "cue", "the interrupted-response continuation is a cue")
ok(noticeOf(noticeMsg("c1", INTERRUPTED)) === undefined, "a cue is never pinned on the notice rail")
ok(
  isHostMessage(noticeMsg("c1", INTERRUPTED)) && isHostCue(noticeMsg("c1", INTERRUPTED)),
  "a cue is a host message",
)
ok(isHostTail(noticeMsg("c1", INTERRUPTED)) && !isHostTail(noticeMsg("o1", OUTPUT_NUDGE)), "a cue is a turn tail, a notice is not")
ok(isRealUser(noticeMsg("c1", INTERRUPTED)) === false, "a cue does not start a turn")
ok(hostMessageOf(noticeMsg("c2", INTERRUPTED, "\n@4@"))?.kind === "cue", "the cue is recognised with a trailing @n@ marker")
ok(
  hostMessageOf(noticeMsg("c3", "The previous response was interrupted.")) === undefined,
  "a shortened interruption is not the cue, so it stays a real turn",
)

const withJob = [
  user("u1", "Run it. ".repeat(20)),
  assistant("a1", "Calling. ".repeat(10)),
  noticeMsg("j-shell", SHELL_JOB),
  assistant("a2", "Done. ".repeat(20)),
]
ok(turnSpans(withJob).length === 1, "a job completion annexes to the turn that started it")
ok(
  turnSpans(withJob)[0].chars === withJob.reduce((sum, message) => sum + messageChars(message), 0),
  "the job's bytes stay in the turn that owns it",
)

// The nudge rides the notice rail: stripped from the window, pinned.
const nudgeStore = new SessionStore()
const nudgeDeps = { store: nudgeStore, config: noticeConfig }
const nudgePass = (messages) =>
  buildPayload({ sessionID: "nudge", system: [{ type: "text", text: "base" }], messages, model: {} }, nudgeDeps)
const nudgePlan = await nudgePass([user("u1", "hi"), noticeMsg("o-nudge", OUTPUT_NUDGE)])
ok(
  nudgePlan.messages.every((message) => !JSON.stringify(message).includes("output token limit")),
  "the nudge is not replayed as a turn",
)
ok(
  nudgePlan.system.some((part) => part.text.startsWith(NOTICE_HEADING) && part.text.includes("output token limit")),
  "the nudge is pinned on the notice rail",
)
const nudgeRecord = await nudgeStore.load("nudge")
ok(nudgeRecord.notices.length === 1 && nudgeRecord.notices[0].id === "o-nudge", "the nudge is stored as a notice")

// A job completion must not age a pending turn, exactly like a mode switch.
const jobStore = new SessionStore()
const jobDeps = {
  store: jobStore,
  config: resolveConfig({
    options: { workingTokens: 500, memoryTokens: 3000, charsPerToken: 2, autoArchive: true, evictionLead: 1 },
  }),
}
const jobPass = (messages) =>
  buildPayload({ sessionID: "job", system: [{ type: "text", text: "base" }], messages, model: {} }, jobDeps)
await jobPass(firstTurn)
const jobBefore = await jobPass([...firstTurn, ...secondTurn])
ok((await jobStore.load("job")).pending.some((pending) => pending.id === "u1"), "the job baseline has a pending turn")
const jobAfter = await jobPass([...firstTurn, ...secondTurn, noticeMsg("j-late", SHELL_JOB)])
const jobRecord = await jobStore.load("job")
ok(jobAfter.report.workingTurns === jobBefore.report.workingTurns, "a job completion adds no working turn")
ok(
  jobAfter.report.workingTokens > jobBefore.report.workingTokens,
  "the job's bytes are still counted in the working window",
)
ok(jobRecord.pending.some((pending) => pending.id === "u1"), "a job completion does not age a pending turn")
ok(jobRecord.archive.length === 0, "a job completion does not archive a pending turn")

const withCue = [
  user("u1", "Run it. ".repeat(20)),
  assistant("a1", "Partial. ".repeat(10)),
  noticeMsg("c-resume", INTERRUPTED),
  assistant("a2", "Done. ".repeat(20)),
]
ok(turnSpans(withCue).length === 1, "a resume cue annexes to the turn it continues")
ok(
  turnSpans(withCue)[0].chars === withCue.reduce((sum, message) => sum + messageChars(message), 0),
  "the cue's bytes stay in the turn that owns it",
)

// A cue is a tail, not a notice: in the window, out of the turn count, never pinned.
const cueStore = new SessionStore()
const cueDeps = {
  store: cueStore,
  config: resolveConfig({
    options: { workingTokens: 500, memoryTokens: 3000, charsPerToken: 2, autoArchive: true, evictionLead: 1 },
  }),
}
const cuePass = (messages) =>
  buildPayload({ sessionID: "cue", system: [{ type: "text", text: "base" }], messages, model: {} }, cueDeps)
await cuePass(firstTurn)
const cueBefore = await cuePass([...firstTurn, ...secondTurn])
const cueAfter = await cuePass([...firstTurn, ...secondTurn, noticeMsg("c-late", INTERRUPTED)])
const cueRecord = await cueStore.load("cue")
ok(cueAfter.report.workingTurns === cueBefore.report.workingTurns, "a resume cue adds no working turn")
ok(
  cueAfter.report.workingTokens > cueBefore.report.workingTokens,
  "the cue's bytes are still counted in the working window",
)
ok(cueRecord.pending.some((pending) => pending.id === "u1"), "a resume cue does not age a pending turn")
ok(cueRecord.archive.length === 0, "a resume cue does not archive a pending turn")
ok(
  cueAfter.system.every((part) => !part.text.includes("previous response was interrupted")),
  "a resume cue never reaches the notice rail",
)
ok(
  cueAfter.messages.some((message) => message.id === "c-late"),
  "the cue itself is still in the payload",
)

// The host's own system parts are measured for display, never for a budget.
const sysStore = new SessionStore()
const sysPass = (system) =>
  buildPayload({ sessionID: "sys", system, messages: [user("u1", "hi")], model: {} }, { store: sysStore, config: noticeConfig })
const sysPlan = await sysPass([{ type: "text", text: "core instructions here. ".repeat(50) }])
ok(sysPlan.report.hostSystemTokens > 0 && sysPlan.report.hostSystemParts === 1, "the host's own system part is measured")
ok(
  sysPlan.report.totalTokens === sysPlan.report.memoryTokens + sysPlan.report.workingTokens,
  "the host system size is not added to the budget",
)
const sysToolDeps = { store: sysStore, config: noticeConfig }
ok(
  /host system ~/.test((await runMemoryTool({ sessionID: "sys", action: "stats" }, sysToolDeps)).text),
  "/context shows the host system size when the host supplies one",
)
await sysPass([])
ok(
  !/host system ~/.test((await runMemoryTool({ sessionID: "sys", action: "stats" }, sysToolDeps)).text),
  "no host system part, no line",
)

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
// Startup sweep: only a session the host says is gone loses its record
// ---------------------------------------------------------------------------

ok(sameDirectory("C:\\Users\\me\\project\\", "C:/Users/me/project"), "directories compare across slash styles")
ok(!sameDirectory("C:/a/b", "C:/a/bc"), "a sibling directory is not the same directory")
ok(
  livenessFromError({ _tag: "SessionNotFoundError", message: "Session not found" }) === "gone",
  "the host's not-found tag means gone",
)
ok(livenessFromError(new Error("session not found")) === "gone", "a not-found message means gone")
ok(livenessFromError(new Error("network down")) === "unknown", "any other error is not proof")

const sweepStorage = new Map([
  ["session/alive", { directory: root }],
  ["session/dead", { directory: root }],
  ["session/unknown", { directory: root }],
  ["session/other-project", { directory: "C:/somewhere/else" }],
  ["session/legacy", { updatedAt: 1 }],
])
const sweepStore = {
  async scan({ prefix, after, limit = 100 }) {
    const keys = [...sweepStorage.keys()].filter((key) => key.startsWith(prefix)).sort()
    const start = after === undefined ? 0 : keys.indexOf(after) + 1
    const page = keys.slice(start, start + limit)
    return {
      entries: page.map((key) => ({ key, value: sweepStorage.get(key) })),
      next: start + limit < keys.length ? page.at(-1) : undefined,
    }
  },
  async remove(key) {
    sweepStorage.delete(key)
  },
}
const liveness = {
  alive: "alive",
  dead: "gone",
  unknown: "unknown",
  "other-project": "gone",
  legacy: "gone",
}
const sweepReport = await pruneOrphans({
  storage: sweepStore,
  directory: root,
  isAlive: async (sessionID) => liveness[sessionID] ?? "unknown",
})
ok(
  sweepReport.removed === 2 && !sweepStorage.has("session/dead") && !sweepStorage.has("session/legacy"),
  "the sweep removes gone sessions, including unstamped legacy records",
)
ok(sweepStorage.has("session/alive"), "an alive session keeps its record")
ok(sweepStorage.has("session/unknown"), "an unclassifiable lookup keeps the record")
ok(sweepStorage.has("session/other-project"), "a record stamped for another project is left for that instance")

const paged = new Map([
  ["session/dead-1", { directory: root }],
  ["session/dead-2", { directory: root }],
])
let scanCalls = 0
const pagedStore = {
  async scan({ after }) {
    scanCalls += 1
    if (after === undefined) {
      return { entries: [{ key: "session/dead-1", value: paged.get("session/dead-1") }], next: "session/dead-1" }
    }
    return { entries: [{ key: "session/dead-2", value: paged.get("session/dead-2") }] }
  },
  async remove(key) {
    paged.delete(key)
  },
}
const pagedReport = await pruneOrphans({ storage: pagedStore, directory: root, isAlive: async () => "gone" })
ok(pagedReport.removed === 2 && paged.size === 0 && scanCalls === 2, "the sweep follows the scan cursor")

const brokenReport = await pruneOrphans({
  storage: {
    async scan() {
      throw new Error("no database")
    },
  },
  directory: root,
  isAlive: async () => "gone",
})
ok(brokenReport.removed === 0, "a scan failure removes nothing")

const stamped = new Map()
const stampStore = new SessionStore(
  {
    async get(key) {
      return stamped.get(key)
    },
    async set(key, value) {
      stamped.set(key, value)
    },
    async remove(key) {
      stamped.delete(key)
    },
    async scan() {
      return { entries: [] }
    },
  },
  { directory: root },
)
await stampStore.save("stamped", await stampStore.load("stamped"))
ok(stamped.get("session/stamped").directory === root, "a saved record is stamped with its directory")

// ---------------------------------------------------------------------------
// Unit: the feature-map readers (Markdown and the generated HTML)
// ---------------------------------------------------------------------------

assert.deepEqual(
  pageCandidates("context-handoff"),
  ["context-handoff.html", "context-handoff.md"],
  "a bare page name prefers the HTML page",
)
passed += 1
assert.deepEqual(
  pageCandidates("docs/features\\context-handoff.md"),
  ["context-handoff.md", "context-handoff.html"],
  "an explicit extension keeps the named file first",
)
passed += 1
assert.deepEqual(pageCandidates("../secret"), [], "a page path cannot escape docs/features")
passed += 1
assert.deepEqual(pageCandidates("   "), [], "an empty page has no candidates")
passed += 1
assert.deepEqual(pageCandidates("notes.txt"), ["notes.txt"], "an unknown extension is left alone")
passed += 1

const htmlFixture = `<h1>Title</h1>
<section id="a"><h2>A &amp; B</h2>
<p>line one</p><ul><li>first</li><li>second</li></ul>
<h3>Nested</h3><p>deep</p>
</section>
<section id="b"><h2>B</h2><p>other</p></section>`

ok(htmlToText(htmlFixture).includes("# A & B"), "an HTML entity decodes inside a heading")
ok(htmlToText(htmlFixture).includes("\n- first"), "an HTML list item becomes a Markdown bullet")
const htmlSection = extractHtmlSection(htmlFixture, "A & B")
ok(htmlSection.includes("deep"), "an HTML section keeps its ### subsections")
ok(!htmlSection.includes("other"), "an HTML section stops at the next same-level heading")
ok(extractHtmlSection(htmlFixture, "missing") === undefined, "a missing HTML section is undefined")
ok(extractSection("# A\nx\n# B\ny", "A") === "# A\nx", "Markdown section extraction is unchanged")

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
ok(!outcome.content[0].text.includes("section not found"), "a ref to a real page resolves against the map")

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
ok(!compaction.result.summary.includes("budget:"), "the compaction summary carries no live numbers either")

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

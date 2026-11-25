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
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { TextAttributes } from "@opentui/core"

import { mechanicalGist } from "../src/core/archive.ts"
import { SESSION_KEYS, parseLayer, resolveConfig } from "../src/core/config.ts"
import { effectiveTokens, parseWeights, rawTokens, usageFromHostTokens, weightsFor } from "../src/core/pricing.ts"
import {
  MAX_LOOP_GUARD_REDIRECT,
  MAX_LOOP_GUARD_SAMPLES,
  MAX_LOOP_GUARD_SIGNATURES,
  loopGuardGreen,
} from "../src/core/loopguard.ts"
import { classify } from "../src/core/run/classify.ts"
import { npmScriptCommand, resolveNpmScript } from "../src/core/run/npm.ts"
import { TimingStore } from "../src/core/run/timings.ts"
import { hideConsoleWindow } from "../src/core/run/windows.ts"
import { buildPayload } from "../src/core/context.ts"
import { runCompaction } from "../src/core/compaction.ts"
import { applyEvidence, factId } from "../src/core/facts.ts"
import { ProjectStore, projectKeyFor } from "../src/core/project.ts"
import { runMemoryTool } from "../src/core/memory-tool.ts"
import { retirePinned } from "../src/core/notices.ts"
import {
  applyProfile,
  choiceLabel,
  chooseProfile,
  configForRecord,
  modelKeys,
  modelLabel,
  profileNames,
  profileSummary,
  stampModel,
} from "../src/core/profiles.ts"
import { runContextCommand } from "../src/core/command.ts"
import { messageChars, messagesChars } from "../src/core/measure.ts"
import { APPEND_NOTE, NOTICE_HEADING, POLICY, renderMemory, renderStats } from "../src/core/prompts.ts"
import { emptyMemory } from "../src/core/schema.ts"
import { RAW_TTL_MS, mergeRaw, rawId, rawPage } from "../src/core/raw.ts"
import {
  PANEL_ACTION,
  PANEL_MEASURED_STALE_MS,
  PANEL_NAME,
  PROFILE_ACTION,
  PRODUCT_NAME,
  PURGE_ACTION,
  RESUME_ACTION,
  SIDEBAR_STALE_MS,
  STATUS_BAR_WIDTH,
  STATUS_RPC,
  ageLabel,
  isNoticeRequest,
  isProfileRequest,
  isPurgeRequest,
  isStatsReply,
  isStatsRequest,
  noticeRequestSchema,
  panelSections,
  panelText,
  profileRequestSchema,
  sidebarLines,
  sidebarText,
  snapshotStale,
  sparkline,
  statsOf,
  statsReplySchema,
  statusBar,
  statusBarParts,
  statusRows,
  turnLabel,
} from "../src/core/status.ts"
import { MAX_SIDEBAR_SESSIONS, sessionsToDrop, sidebarRefreshOf } from "../src/tui/status-store.ts"
import { bindLocation } from "../src/tui/context.ts"
import { toneAttributes } from "../src/tui/theme.ts"
import {
  MAX_UNDO_CHARS,
  MAX_UNDO_TURNS,
  applyRevert,
  captureMemory,
  noteTurn,
  purgeWithUndo,
  queueRevert,
  revertTarget,
} from "../src/core/undo.ts"
import { MAX_HISTORY, MAX_NOTICES, MAX_NOTICE_CHARS, MAX_RETIRED, SessionStore, StoreConflictError, pruneOrphans, retireNotice, sameDirectory, trimHistory, upsertNotices } from "../src/core/state.ts"
import { extractHtmlSection, extractSection, htmlToText, pageCandidates } from "../src/core/refs.ts"
import { deriveVersion, readVersionBase } from "../src/core/version.ts"
import { balanceCuts, erodeToolResults, gistText, hostMessageOf, isHostCue, isHostJob, isHostMessage, isHostTail, isRealUser, modeReminderOf, noticeOf, rebuildTurn, RESUMED_TEXT, selectAppendWindow, selectWorkingWindow, splitNotices, supersededReads, turnSpans } from "../src/core/view.ts"
import { livenessFromError } from "../src/adapters/opencode/sessions.ts"
import { modelWindowOf } from "../src/adapters/opencode/context.ts"
import { TOOL_DESCRIPTION } from "../src/adapters/opencode/tool.ts"
import { readPluginVersion } from "../src/adapters/opencode/version.ts"
import {
  CHECK_INTERVAL_MS,
  announceVersion,
  compareVersions,
  dueForCheck,
  parseManifestVersion,
  updateAvailable,
  updateMessage,
} from "../src/core/update.ts"
import { setup as setupTui } from "../tui.ts"
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

const defaultBudgets = resolveConfig({})
ok(
  defaultBudgets.memoryTokens === 100_000 && defaultBudgets.workingTokens === 200_000,
  "the default budgets are 100k memory and 200k working",
)
ok(
  defaultBudgets.defaultProfile === "deep" &&
    defaultBudgets.profiles.deep?.memoryTokens === 100_000 &&
    defaultBudgets.profiles.deep?.workingTokens === 200_000,
  "the shipped deep profile is the default",
)
ok(defaultBudgets.rebuildOnCompaction === false, "the tail rebuild is off by default")

const pricingKnown = weightsFor("opencode/claude-sonnet-4-5")
ok(
  pricingKnown.source === "table" && pricingKnown.weights.cacheRead === 0.1,
  "a known model uses the published price table",
)
const pricingUnknown = weightsFor("opencode-go/deepseek-v4.1-flash")
ok(
  pricingUnknown.source === "generic" && pricingUnknown.key === "deepseek-v4.1-flash",
  "an unknown model is labelled generic",
)
const hostTokens = usageFromHostTokens({
  input: 100,
  output: 10,
  reasoning: 99,
  cache: { read: 1000, write: 200 },
})
ok(
  hostTokens.input === 100 &&
    hostTokens.cacheRead === 1000 &&
    hostTokens.cacheWrite === 200 &&
    hostTokens.output === 10,
  "host tokens map to the pricing usage",
)
ok(
  effectiveTokens(hostTokens, { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 }) === 500,
  "cache-aware effective tokens weight every bucket",
)
ok(
  effectiveTokens(
    { input: 0, cacheRead: 0, cacheWrite: 200, cacheWrite1h: 50, output: 0 },
    { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
  ) === 287.5,
  "the one-hour cache share gets its own price",
)
ok(parseWeights("1,0.1,1,4,2").cacheWrite1h === 2, "a weights spec parses")
ok(rawTokens(hostTokens) === 1310, "raw tokens sum the buckets")
assert.throws(() => parseWeights("1,2"), /weights need/, "a malformed weights spec is refused")
passed += 1
const packageOptions = JSON.parse(readFileSync(new URL("../options.json", import.meta.url), "utf8"))
const packageBudgets = resolveConfig({ package: packageOptions })
ok(
  packageBudgets.memoryTokens === defaultBudgets.memoryTokens &&
    packageBudgets.workingTokens === defaultBudgets.workingTokens &&
    packageBudgets.defaultProfile === "deep" &&
    packageBudgets.profiles.deep?.workingTokens === 200_000,
  "the package options layer carries the same default budgets and profile",
)

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
  const toolHooks = {}
  const tools = []
  tools.push({
    name: "shell",
    description: "host shell",
    input: { type: "object" },
    execute: async () => ({ content: [{ type: "text", text: "shell" }] }),
  })
  const commands = []
  const replies = []
  const synthetics = []
  const rpcs = []
  const storage = new Map()
  const ctx = {
    location: { directory: root },
    options: {
      workingTokens: 300,
      memoryTokens: 3000,
      charsPerToken: 2,
      manualCommand: true,
      debug: false,
      // The harness pins the base config: the shipped deep profile would
      // otherwise widen this deliberately tiny window.
      defaultProfile: "",
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
      async synthetic({ sessionID, text, resume }) {
        synthetics.push({ sessionID, text, resume })
        return {}
      },
      async compact() {
        return {}
      },
    },
    tool: {
      async transform(callback) {
        callback({
          add: (tool) => tools.push(tool),
          remove: (id) => {
            const index = tools.findIndex((tool) => tool.name === id)
            if (index >= 0) tools.splice(index, 1)
          },
        })
        return { dispose: async () => {} }
      },
      async hook(name, callback) {
        toolHooks[name] = callback
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
    rpc: {
      async register(definition, handlers) {
        rpcs.push({ definition, handlers })
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, hooks, toolHooks, tools, commands, replies, synthetics, rpcs, storage }
}

const { default: plugin } = await import(pathToFileURL(resolve(root, "server.ts")).href)
ok(typeof plugin.setup === "function", "the server entry exports setup")

const host = makeHost()
const dispose = await plugin.setup(host.ctx)
ok(typeof host.hooks.context === "function", "the context hook is registered")
ok(typeof host.hooks.compaction === "function", "the compaction hook is registered")
ok(host.tools.length === 2 && host.tools.some((entry) => entry.name === "smart_context") && host.tools.some((entry) => entry.name === "run"), "smart_context and run are registered")
ok(!host.tools.some((entry) => entry.name === "shell"), "the runtime shell tool is removed")
ok(typeof host.toolHooks["execute.before"] === "function", "the shell guard is registered")
let shellDenied = false
try {
  await host.toolHooks["execute.before"]({ tool: "shell" })
} catch {
  shellDenied = true
}
ok(shellDenied, "the shell tool call is denied")
ok(host.commands.length === 1 && host.commands[0].name === "context", "/context is registered")
ok(
  host.rpcs.length === 1 && host.rpcs[0].definition === STATUS_RPC,
  "the server registers the status RPC from the shared definition",
)

const tool = host.tools.find((entry) => entry.name === "smart_context")
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
// Project facts: the session seam (snapshot, fold, /context facts)
// ---------------------------------------------------------------------------

const pfKey = projectKeyFor({ directory: root })
const pfDraft = { family: "absent_tool", params: { tool: "seed-tool" }, high: true }
const pfFactId = factId("absent_tool", { tool: "seed-tool" })
const pfProject = new ProjectStore()
await pfProject.mutate(pfKey, (record) => {
  for (let index = 0; index < 4; index += 1) {
    applyEvidence(
      record,
      pfDraft,
      { kind: "confirm", session: "pf-seed-" + index, step: index + 1, exercised: true, fired: true, files: [] },
      { now: 1_000 + index },
    )
  }
})
const pfConfig = resolveConfig({ options: { projectFacts: true, defaultProfile: "" } })
const pfSession = new SessionStore()
const pfMessages = [user("pf-u1", "hello")]
const pfEvent = { sessionID: "pf-stable", system: [{ type: "text", text: "base" }], messages: pfMessages, model: {} }
const pfPlan = await buildPayload(pfEvent, {
  store: pfSession,
  config: pfConfig,
  project: { store: pfProject, key: pfKey },
})
const pfBlock = pfPlan.system.find((part) => part.text.includes("# Learned project facts"))
ok(pfBlock !== undefined && pfBlock.text.includes(pfFactId), "project facts inject one stable block")
const pfRecord = await pfSession.load("pf-stable", { fresh: true })
ok(pfRecord.projectFacts?.rendered === pfBlock.text, "the session snapshots the exact rendered block")
const pfAgain = await buildPayload(pfEvent, {
  store: pfSession,
  config: pfConfig,
  project: { store: pfProject, key: pfKey },
})
assert.deepEqual(pfAgain.system, pfPlan.system, "the project block is byte-identical on the second pass")
passed += 1

const pfNoDep = await buildPayload(
  { sessionID: "pf-no-dep", system: [{ type: "text", text: "base" }], messages: pfMessages, model: {} },
  { store: new SessionStore(), config: pfConfig },
)
ok(
  !pfNoDep.system.some((part) => part.text.includes("# Learned project facts")),
  "no project dependency adds no project block",
)
const pfOffProject = new ProjectStore()
const pfOff = await buildPayload(
  { sessionID: "pf-off", system: [{ type: "text", text: "base" }], messages: pfMessages, model: {} },
  {
    store: new SessionStore(),
    config: resolveConfig({ options: { projectFacts: false, defaultProfile: "" } }),
    project: { store: pfOffProject, key: pfKey },
  },
)
ok(
  !pfOff.system.some((part) => part.text.includes("# Learned project facts")) &&
    (await pfOffProject.load(pfKey, { fresh: true })).envelope.sessions === 0,
  "projectFacts:false adds no block and learns nothing",
)

const pfFoldProject = new ProjectStore()
const pfFoldSession = new SessionStore()
const pfFoldMessages = [
  user("pf-fold-1", "first"),
  call("pf-call-1", "pf-call-id", "bash", { command: "npm test" }),
  result("pf-res-1", "pf-call-id", "bash", "Error: expected 2, got 3"),
  user("pf-fold-2", "second"),
]
const pfFoldDeps = {
  store: pfFoldSession,
  config: pfConfig,
  project: { store: pfFoldProject, key: pfKey },
}
await buildPayload(
  { sessionID: "pf-fold", system: [{ type: "text", text: "base" }], messages: pfFoldMessages, model: {} },
  pfFoldDeps,
)
const pfFoldedRecord = await pfFoldSession.load("pf-fold", { fresh: true })
const pfFoldedProject = await pfFoldProject.load(pfKey, { fresh: true })
ok(pfFoldedRecord.factsFolded === "pf-fold-1", "a completed previous turn folds into the project")
ok(pfFoldedProject.envelope.sessions === 1, "the fold advances the project envelope once")
await buildPayload(
  { sessionID: "pf-fold", system: [{ type: "text", text: "base" }], messages: pfFoldMessages, model: {} },
  pfFoldDeps,
)
const pfRepeatProject = await pfFoldProject.load(pfKey, { fresh: true })
ok(pfRepeatProject.envelope.sessions === 1, "a repeat pass does not double-count the folded turn")

const pfReplies = []
const pfCommandDeps = {
  store: pfSession,
  config: pfConfig,
  reply: async (_sessionID, text) => {
    pfReplies.push(text)
  },
  projectFor: async () => ({ store: pfProject, key: pfKey }),
}
await runContextCommand("pf-stable", "facts", pfCommandDeps)
ok(pfReplies.at(-1).includes(pfFactId) && pfReplies.at(-1).includes("1 active"), "/context facts prints the fact")
await runContextCommand("pf-stable", "facts forget " + pfFactId, pfCommandDeps)
const pfForgotten = await pfProject.load(pfKey, { fresh: true })
const pfAfterForget = await pfSession.load("pf-stable", { fresh: true })
ok(pfForgotten.facts[pfFactId] === undefined, "/context facts forget removes the fact")
ok(pfAfterForget.projectFacts === undefined, "/context facts forget clears the session snapshot")

// The raw store: the second pass evicts the first turn, erodes its 5000-char
// result, and keeps the original behind a stable marker.
const rawOriginal = "q".repeat(5_000)
const rawMessage = {
  id: "rraw",
  role: "tool",
  content: [{ type: "tool-result", id: "craw", name: "shell", result: { type: "text", value: rawOriginal } }],
}
const newestMessage = {
  id: "rnew",
  role: "tool",
  content: [{ type: "tool-result", id: "cnew", name: "shell", result: { type: "text", value: "z".repeat(5_000) } }],
}
const rawDrafts = []
const protectedErode = erodeToolResults([rawMessage, newestMessage], 1_000, {
  protectNewest: true,
  sink: (draft) => rawDrafts.push(draft),
})
ok(protectedErode.eroded === 1, "only the older of two results erodes")
ok(
  protectedErode.messages[1].content[0].result.value === "z".repeat(5_000),
  "the newest result is never eroded",
)
ok(rawDrafts.length === 1 && rawDrafts[0].text === rawOriginal, "the sink gets the original bytes")
ok(
  JSON.stringify(protectedErode.messages).includes(`raw: ${rawDrafts[0].id}`),
  "the shortened result carries the raw marker",
)
const rawIdAgain = rawId("shell", rawOriginal)
ok(
  rawDrafts[0].id === rawIdAgain && /^r_[a-f0-9]{12}$/.test(rawIdAgain),
  "raw ids are stable and short",
)
const storedRaw = mergeRaw(undefined, rawDrafts, 1_000)
const rawEntry = storedRaw[rawDrafts[0].id]
const rawFirst = rawPage(rawEntry, { offset: 0, limit: 500 })
ok(rawFirst.text.length === 500 && rawFirst.next === 500, "a raw page is bounded and reports its next offset")
const rawSecond = rawPage(rawEntry, { offset: 500, limit: 500 })
ok(rawSecond.text.length === 500 && rawSecond.offset === 500, "the next raw page resumes at the offset")
ok(
  Object.keys(mergeRaw(storedRaw, [], 1_000 + RAW_TTL_MS + 1)).length === 0,
  "expired raw entries are dropped",
)

const rawSessionStore = new SessionStore()
const rawSessionConfig = resolveConfig({
  options: { memoryTokens: 10_000, workingTokens: 10_000, charsPerToken: 4, defaultProfile: "" },
})
const rawSessionID = "raw-session"
const rawTurn = [
  user("ru1", "read the data"),
  assistant("ra1", "reading"),
  call("ra1", "rc1", "read", { path: "big.txt" }),
  result("rr1", "rc1", "read", "x".repeat(5_000)),
  assistant("ra2", "done"),
  call("ra2", "rc2", "read", { path: "small.txt" }),
  result("rr2", "rc2", "read", "ok"),
]
const rawPlan = await buildPayload(
  { sessionID: rawSessionID, system: [], messages: rawTurn, model: {} },
  { store: rawSessionStore, config: rawSessionConfig },
)
const rawRecord = await rawSessionStore.load(rawSessionID, { fresh: true })
const storedEntries = Object.values(rawRecord.raw ?? {})
ok(
  storedEntries.length === 1 && storedEntries[0].text === "x".repeat(5_000),
  "the shortened result's original is stored in the session",
)
const storedId = storedEntries[0].id
ok(
  JSON.stringify(rawPlan.messages).includes(`raw: ${storedId}`),
  "the request carries the marker for the stored original",
)
const rawReply = await runMemoryTool(
  { sessionID: rawSessionID, action: "raw", id: storedId },
  { store: rawSessionStore, config: rawSessionConfig },
)
ok(rawReply.ok && rawReply.text.includes("xxxxx"), "the raw action returns the original text")
const missingRaw = await runMemoryTool(
  { sessionID: rawSessionID, action: "raw", id: "r_000000000000" },
  { store: rawSessionStore, config: rawSessionConfig },
)
ok(!missingRaw.ok && missingRaw.text.includes("no raw result"), "a missing raw id is a normal miss")

// Content-aware erosion: a JSON array keeps its shape and gets a sentinel row;
// a log keeps its fatal line. Both leave the original in the raw store.
const jsonRows = Array.from({ length: 20 }, (_, index) => ({
  id: index,
  name: "row " + index,
  payload: "x".repeat(120),
}))
const jsonText = JSON.stringify(jsonRows)
const jsonDrafts = []
const jsonMessage = {
  id: "rjson",
  role: "tool",
  content: [{ type: "tool-result", id: "cjson", name: "shell", result: { type: "text", value: jsonText } }],
}
const jsonOut = erodeToolResults([jsonMessage], 1_200, { sink: (draft) => jsonDrafts.push(draft) })
const jsonKept = jsonOut.messages[0].content[0].result.value
ok(jsonDrafts.length === 1 && jsonDrafts[0].text === jsonText, "the JSON original is stored")
ok(jsonKept.includes("_raw") && jsonKept.includes("_omitted"), "a JSON array keeps a sentinel row")
ok(JSON.parse(jsonKept).length <= 9, "the JSON array is sampled to a readable size")

const logText = [...Array.from({ length: 30 }, (_, index) => `INFO step ${index} ok`), "FATAL disk full"].join("\n")
const logDrafts = []
const logMessage = {
  id: "rlog",
  role: "tool",
  content: [{ type: "tool-result", id: "clog", name: "shell", result: { type: "text", value: logText } }],
}
const logOut = erodeToolResults([logMessage], 300, { sink: (draft) => logDrafts.push(draft) })
const logKept = logOut.messages[0].content[0].result.value
ok(logDrafts.length === 1 && logDrafts[0].text === logText, "the log original is stored")
ok(logKept.includes("FATAL disk full") && logKept.includes("raw: "), "the log keeps the fatal line and the marker")
ok(logKept.split("\n").length < 20, "the repeated log lines are shortened")

const errorDrafts = []
const errorMessage = {
  id: "rerror",
  role: "tool",
  content: [
    {
      type: "tool-result",
      id: "cerror",
      name: "shell",
      result: { type: "text", value: "Error: " + "e".repeat(5_000) },
    },
  ],
}
const errorOut = erodeToolResults([errorMessage], 1_000, { sink: (draft) => errorDrafts.push(draft) })
ok(
  errorOut.eroded === 0 && errorOut.messages[0].content[0].result.value.length === 5_007,
  "an error result is preserved whole",
)
ok(errorDrafts.length === 0, "an error result is not shortened into the raw store")

// ---------------------------------------------------------------------------
// Pass history: one sample per pass, the transcript baseline, bounded
// ---------------------------------------------------------------------------

const histStore = new SessionStore()
const histConfig = resolveConfig({ options: { workingTokens: 500, memoryTokens: 3000, charsPerToken: 2, defaultProfile: "" } })
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
const noticeConfig = resolveConfig({ options: { workingTokens: 500, memoryTokens: 3000, charsPerToken: 2, defaultProfile: "" } })
const noticeDeps = { store: noticeStore, config: noticeConfig }
const noticePass = (sessionID, messages, system = [{ type: "text", text: "base" }]) =>
  buildPayload({ sessionID, system, messages, model: {} }, noticeDeps)

const p1 = await noticePass("n", withNotices)
ok(p1.messages.every((message) => !JSON.stringify(message).includes("system-reminder")), "the notice is not in the payload")
const p1Tail = p1.messages[p1.messages.length - 1]
const p1TailText = p1Tail.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
ok(p1TailText.startsWith("<smart-context-state>"), "the state note is the last message")
ok(p1TailText.includes("mode: build"), "the live mode is in the tail state note")
ok(!p1TailText.includes("mode: plan"), "the superseded mode is not repeated")
ok(
  p1.system.every((part) => !part.text.startsWith(NOTICE_HEADING)),
  "mode notices are not pinned into a system part",
)
ok(p1.system.some((part) => part.text === POLICY), "the policy is still in the system")
ok(
  POLICY.includes("`smart_context` is a direct tool") &&
    POLICY.includes("tools.smart_context") &&
    POLICY.includes("inside `execute`"),
  "the policy says smart_context is a direct tool, not a Code Mode one",
)
const p2 = await noticePass("n", withNotices, p1.system)
ok(
  p2.system.filter((part) => part.text.startsWith(NOTICE_HEADING)).length === 0,
  "a re-pass adds no pinned mode notice",
)
ok(
  p2.system.filter((part) => part.text === POLICY).length === 1,
  "a re-pass keeps one policy part",
)
const nrec = await noticeStore.load("n")
ok(
  nrec.notices.length === 1 && nrec.notices[0].id === "n-build",
  "the record pins only the live mode reminder",
)
ok(
  (nrec.retired ?? []).some((entry) => entry.id === "n-plan" && entry.text === PLAN_NOTICE),
  "the superseded reminder is retired, so the window cannot re-add it",
)
const atBefore = JSON.stringify(nrec.notices)
await noticePass("n", withNotices)
const nrec2 = await noticeStore.load("n")
ok(JSON.stringify(nrec2.notices) === atBefore, "a re-run leaves the pinned notices byte-identical")

// The host re-emits a mode instead of withdrawing one: the other side returns.
await noticePass("n", [...withNotices, noticeMsg("n-plan2", PLAN_NOTICE)])
const backRec = await noticeStore.load("n")
ok(
  backRec.notices.length === 1 && backRec.notices[0].id === "n-plan2",
  "re-emitting the superseded mode brings it back and retires the other",
)
ok(
  (backRec.retired ?? []).some((entry) => entry.id === "n-build" && entry.text === BUILD_NOTICE),
  "the mode it replaced is retired in turn",
)

// A mode switch carries no user turn: it must not age a pending turn out.
const ageStore = new SessionStore()
const ageConfig = resolveConfig({
  options: { workingTokens: 500, memoryTokens: 3000, charsPerToken: 2, defaultProfile: "" },
})
const ageDeps = { store: ageStore, config: ageConfig }
const agePass = (messages) =>
  buildPayload({ sessionID: "age", system: [{ type: "text", text: "base" }], messages, model: {} }, ageDeps)
const firstTurn = [user("u1", "First. ".repeat(100)), assistant("a1", "Answer. ".repeat(100))]
const secondTurn = [user("u2", "Second. ".repeat(100)), assistant("a2", "Again. ".repeat(100))]
await agePass(firstTurn)
const bReport = await agePass([...firstTurn, ...secondTurn])
const afterB = await ageStore.load("age")
ok(afterB.pending.length === 0, "append keeps turns until a fold instead of evicting on the working budget")
const cReport = await agePass([...firstTurn, ...secondTurn, noticeMsg("n-mode", BUILD_NOTICE)])
const afterC = await ageStore.load("age")
ok(cReport.report.workingTurns === bReport.report.workingTurns, "a mode switch adds no working turn")
ok(afterC.pending.length === 0, "a mode switch creates no pending turn")
ok(afterC.archive.length === 0, "a mode switch does not archive a pending turn")

// action:notice — list, refuse the newest, retire an older one.
const toolDeps = { store: noticeStore, config: noticeConfig }
const NUDGE_NOTICE = "Your last response hit the output token limit. Break the remaining work into smaller pieces."
const toolWindow = [
  user("u1", "hi"),
  noticeMsg("n-nudge", NUDGE_NOTICE),
  noticeMsg("n-old", PLAN_NOTICE),
  noticeMsg("n-new", BUILD_NOTICE),
]
await noticePass("notice-tool", toolWindow)
const listOut = await runMemoryTool({ sessionID: "notice-tool", action: "notice" }, toolDeps)
ok(
  listOut.ok && listOut.text.includes("n-nudge") && listOut.text.includes("n-new"),
  "action:notice lists the pinned notices",
)
ok(!listOut.text.includes("n-old"), "the superseded mode reminder is not listed")
const refuseNewest = await runMemoryTool({ sessionID: "notice-tool", action: "notice", remove: "n-new" }, toolDeps)
ok(!refuseNewest.ok && /newest/.test(refuseNewest.text), "the newest notice refuses removal")
const removeOlder = await runMemoryTool({ sessionID: "notice-tool", action: "notice", remove: "n-nudge" }, toolDeps)
ok(removeOlder.ok, "an older notice can be removed")
const remaining = await noticeStore.load("notice-tool")
ok(remaining.notices.length === 1 && remaining.notices[0].id === "n-new", "only the retired notice is gone")

// The same rule is reachable over the RPC, so it lives in one function.
const railRecord = blankRecord()
railRecord.notices = [
  { id: "rail-old", text: "older text", at: 1 },
  { id: "rail-live", text: "live text", at: 2 },
]
const railRefuse = retirePinned(railRecord, "rail-live", 10)
ok(
  !railRefuse.ok && railRecord.notices.length === 2 && (railRecord.undo ?? []).length === 0,
  "the shared retire rule refuses the newest notice and writes nothing",
)
const railTake = retirePinned(railRecord, "rail-old", 11)
ok(
  railTake.ok &&
    railRecord.notices.length === 1 &&
    railRecord.retired[0].id === "rail-old" &&
    (railRecord.undo ?? []).length === 1,
  "retiring an older notice records the retirement and journals it",
)
const railMissing = retirePinned(railRecord, "rail-none", 12)
ok(
  !railMissing.ok && /no pinned notice/.test(railMissing.text) && (railRecord.undo ?? []).length === 1,
  "a retirement for an unknown id changes nothing",
)

// Removal is sticky: the text is still in the window, so the pass must skip it.
await noticePass("notice-tool", toolWindow)
const afterReadd = await noticeStore.load("notice-tool")
ok(
  afterReadd.notices.length === 1 && afterReadd.notices[0].id === "n-new",
  "a retired notice is not re-added while its text is still in the window",
)
const reemitted = await noticePass("notice-tool", [...toolWindow, noticeMsg("n-nudge2", NUDGE_NOTICE)])
ok(reemitted !== undefined, "a second emission of the retired text is still a notice")
const afterReemit = await noticeStore.load("notice-tool")
ok(afterReemit.notices.length === 2, "the same text emitted under a new id returns")
ok(afterReemit.notices[afterReemit.notices.length - 1].id === "n-nudge2", "the returning notice is the newest")
ok(
  !(afterReemit.retired ?? []).some((entry) => entry.text === NUDGE_NOTICE),
  "the retirement clears once the text is re-emitted",
)
ok(afterReemit.notices[0].id === "n-new", "the live mode reminder survives every nudge")

// Recency: re-seeing a text moves it to the end, so the rail protects the live one.
const NOTICE_A = "<system-reminder>\nNote A\n</system-reminder>"
const NOTICE_B = "<system-reminder>\nNote B\n</system-reminder>"
const recWindow = [user("u1", "hi"), noticeMsg("r-a", NOTICE_A)]
await noticePass("recency", recWindow)
const recWindow2 = [...recWindow, noticeMsg("r-b", NOTICE_B)]
await noticePass("recency", recWindow2)
const recWindow3 = [...recWindow2, noticeMsg("r-a2", NOTICE_A)]
await noticePass("recency", recWindow3)
const recRec = await noticeStore.load("recency")
ok(recRec.notices[recRec.notices.length - 1].id === "r-a2", "a re-seen notice moves to the end")
ok(recRec.notices[0].id === "r-b", "the text seen least recently is first")
const recRefuse = await runMemoryTool({ sessionID: "recency", action: "notice", remove: "r-a2" }, toolDeps)
ok(!recRefuse.ok && /newest/.test(recRefuse.text), "the rail refuses the text the host emitted most recently")
const recAllow = await runMemoryTool({ sessionID: "recency", action: "notice", remove: "r-b" }, toolDeps)
ok(recAllow.ok, "the stale text is removable")

// The fold rules, directly: skip a retired generation, return on a new one.
const skipped = upsertNotices([], [{ id: "s1", text: PLAN_NOTICE }], 1, [{ id: "s1", text: PLAN_NOTICE }])
ok(skipped.notices.length === 0 && skipped.retired.length === 1, "a found text whose newest occurrence is retired is skipped")
const returns = upsertNotices([], [{ id: "s2", text: PLAN_NOTICE }], 1, [{ id: "s1", text: PLAN_NOTICE }])
ok(returns.notices.length === 1 && returns.retired.length === 0, "a new id clears the retirement and returns the text")

// The heading dates the live emission, not the first sight.
const firstSight = upsertNotices([], [{ id: "d1", text: NOTICE_A }], 100)
ok(firstSight.notices[0].at === 100, "a notice is dated when it is first seen")
const reSeen = upsertNotices(firstSight.notices, [{ id: "d2", text: NOTICE_A }], 500)
ok(reSeen.notices[0].at === 500 && reSeen.notices[0].id === "d2", "a re-emission moves the date with the id")
const sameGeneration = upsertNotices(reSeen.notices, [{ id: "d2", text: NOTICE_A }], 900)
ok(sameGeneration.notices[0].at === 500, "a re-run over the same generation keeps the date")
const legacy = upsertNotices([{ id: "d3", text: NOTICE_A, at: 0 }], [{ id: "d3", text: NOTICE_A }], 700)
ok(legacy.notices[0].at === 700, "a record written before the date existed heals on the next pass")

// Mode classification is gated on the reminder shape.
ok(modeReminderOf(PLAN_NOTICE) === "plan", "the plan reminder classifies as plan")
ok(modeReminderOf(BUILD_NOTICE) === "build", "the build reminder classifies as build")
ok(modeReminderOf(NOTICE_A) === undefined, "an ordinary reminder is not a mode")
ok(modeReminderOf("You are in Plan mode.") === undefined, "prose about plan mode is not a mode reminder")

// One fold decides the pair, whichever side came last.
const buildFirst = upsertNotices([], [{ id: "m1", text: BUILD_NOTICE }, { id: "m2", text: PLAN_NOTICE }], 1)
ok(buildFirst.notices.length === 1 && buildFirst.notices[0].id === "m2", "the later mode wins whatever the order")
ok(buildFirst.retired[0].id === "m1", "the earlier mode is retired")
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
  config: resolveConfig({ options: { workingTokens: 20_000, memoryTokens: 3000, charsPerToken: 2, defaultProfile: "" } }),
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
// Append-only layout: the checkpoint stays put, a patch lands after its turn
// ---------------------------------------------------------------------------

ok(parseLayer({ contextLayout: "append" }, "test").contextLayout === undefined, "contextLayout is accepted as a legacy append value")
assert.throws(() => parseLayer({ contextLayout: "snapshot" }, "test"), /no longer supported/, "snapshot is rejected")
passed += 1
ok(
  parseLayer({ compactKeepTokens: 100 }, "test").compactKeepTokens === 500,
  "compactKeepTokens clamps at a 500-token floor",
)
ok(
  Object.keys(parseLayer({ evictionLead: 2, autoArchive: false }, "test")).length === 0,
  "the retired eviction keys are accepted as no-ops",
)
const legacyProfileConfig = resolveConfig({
  user: { profiles: { old: { evictionLead: 3, autoArchive: false, memoryTokens: 5_000 } } },
})
ok(
  legacyProfileConfig.profiles.old.memoryTokens === 5_000 &&
    !("evictionLead" in legacyProfileConfig.profiles.old) &&
    !("autoArchive" in legacyProfileConfig.profiles.old),
  "a profile's retired eviction keys are dropped, not rejected",
)

const appendConfig = resolveConfig({
  options: { contextLayout: "append", workingTokens: 20_000, memoryTokens: 3000, charsPerToken: 2, defaultProfile: "" },
})
// Append folds archive immediately, so the pending queue only holds legacy or
// undo-restored turns. One new user turn is the fixed grace; then it archives.
const legacyPendingStore = new SessionStore()
const legacyPendingDeps = {
  store: legacyPendingStore,
  config: resolveConfig({ options: { workingTokens: 20_000, memoryTokens: 3000, charsPerToken: 2, defaultProfile: "" } }),
  now: () => 5,
}
const legacyTurn1 = [user("lp1", "one"), assistant("lpa1", "ok")]
await buildPayload({ sessionID: "legacy-pending", system: [], messages: legacyTurn1, model: {} }, legacyPendingDeps)
await legacyPendingStore.mutate("legacy-pending", (record) => {
  record.pending.push({
    id: "old",
    gist: "legacy pending",
    chars: 100,
    createdAt: 0,
    age: 0,
    messages: [user("old", "legacy"), assistant("old-a", "ok")],
  })
})
const legacyTurn2 = [...legacyTurn1, user("lp2", "two"), assistant("lpa2", "ok")]
await buildPayload({ sessionID: "legacy-pending", system: [], messages: legacyTurn2, model: {} }, legacyPendingDeps)
const afterGrace = await legacyPendingStore.load("legacy-pending")
ok(
  afterGrace.pending.length === 1 && afterGrace.pending[0].age === 1,
  "a legacy pending turn gets one user-turn grace",
)
const legacyTurn3 = [...legacyTurn2, user("lp3", "three"), assistant("lpa3", "ok")]
await buildPayload({ sessionID: "legacy-pending", system: [], messages: legacyTurn3, model: {} }, legacyPendingDeps)
const afterGraceEnd = await legacyPendingStore.load("legacy-pending")
ok(
  afterGraceEnd.pending.length === 0 && afterGraceEnd.archive.some((entry) => entry.id === "old"),
  "an unhandled legacy pending turn is archived, never dropped",
)

const appendStore = new SessionStore()
const appendDeps = { store: appendStore, config: appendConfig }
const appendPass = (messages, model) =>
  buildPayload({ sessionID: "append", system: [{ type: "text", text: "base" }], messages, model: model ?? {} }, appendDeps)

const appendTurn1 = [user("au1", "First append turn. ".repeat(20)), assistant("aa1", "Done.")]
const appendFirst = await appendPass(appendTurn1)
const checkpointBefore = appendFirst.messages[0].content[0].text
ok(checkpointBefore.includes("goal: (empty"), "the append checkpoint starts empty")
ok(appendFirst.messages.some((message) => message.id === "megasc_state"), "the append tail carries the state note")
ok(appendFirst.system.some((part) => part.text === APPEND_NOTE), "the append note is a static system part")
ok(!checkpointBefore.includes("pool:"), "the checkpoint carries no live budget")

const firstPatch = await runMemoryTool(
  { sessionID: "append", action: "patch", patch: { goal: "ship the append layout" } },
  appendDeps,
)
const secondPatch = await runMemoryTool(
  { sessionID: "append", action: "patch", patch: { facts: { cache: "prefix stays warm" } } },
  appendDeps,
)
ok(firstPatch.ok && secondPatch.ok, "two append patches are accepted")
let appendRecord = await appendStore.load("append")
ok(appendRecord.base?.goal === "", "a patch does not move the checkpoint")
ok(appendRecord.memory.goal === "ship the append layout", "the merged memory has the patch")
ok((appendRecord.updates ?? []).length === 1, "two patches in one turn coalesce into one update")
ok(
  appendRecord.updates[0].turn === "au1" &&
    appendRecord.updates[0].patch.goal === "ship the append layout" &&
    appendRecord.updates[0].patch.facts?.cache === "prefix stays warm",
  "the update carries both accepted keys",
)

const appendTurn2 = [...appendTurn1, user("au2", "Second append turn."), assistant("aa2", "Again.")]
const appendSecond = await appendPass(appendTurn2)
ok(
  appendSecond.messages[0].content[0].text === checkpointBefore,
  "the checkpoint is byte-identical after a later patch",
)
const firstUpdate = appendSecond.messages.find((message) => message.id === "megasc_update_au1")
ok(firstUpdate !== undefined, "the update block appears after its turn")
ok(firstUpdate.content[0].text.includes("ship the append layout"), "the update block carries the accepted goal")
ok(
  appendSecond.messages.findIndex((message) => message.id === "megasc_update_au1") >
    appendSecond.messages.findIndex((message) => message.id === "aa1"),
  "the update block follows the turn's last message",
)
const stateIndex = appendSecond.messages.findIndex((message) => message.id === "megasc_state")
ok(stateIndex === appendSecond.messages.length - 1, "the tail state note is the last message")
ok(
  stateIndex > appendSecond.messages.findIndex((message) => message.id === "aa2"),
  "the tail state note trails the current turn",
)

const currentPatch = await runMemoryTool(
  { sessionID: "append", action: "patch", patch: { open: ["finish the append test"] } },
  appendDeps,
)
ok(currentPatch.ok, "a patch in the current turn is accepted")
const appendSecondAgain = await appendPass(appendTurn2)
ok(
  !appendSecondAgain.messages.some((message) => message.id === "megasc_update_au2"),
  "the current turn's update is deferred",
)
const loopPass = await appendPass([
  ...appendTurn2,
  call("aa2b", "c2", "read", { path: "docs/SPEC.html" }),
  result("rr2", "c2", "read", "line. ".repeat(50)),
])
ok(
  JSON.stringify(loopPass.messages.slice(0, appendSecondAgain.messages.length - 1)) ===
    JSON.stringify(appendSecondAgain.messages.slice(0, -1)),
  "a second pass in the same turn leaves the earlier bytes alone",
)
ok(
  loopPass.messages[loopPass.messages.length - 1].id === "megasc_state",
  "the trailing note is the only block that moves inside a turn",
)
ok(
  loopPass.messages[loopPass.messages.length - 1].content[0].text !==
    appendSecondAgain.messages[appendSecondAgain.messages.length - 1].content[0].text,
  "the trailing note carries the grown pool",
)
const appendThird = await appendPass([
  ...appendTurn2,
  user("au3", "Third append turn."),
  assistant("aa3", "Done."),
])
ok(
  appendThird.messages.some((message) => message.id === "megasc_update_au2"),
  "the deferred update appears on the next turn",
)

const compacted = await runMemoryTool({ sessionID: "append", action: "compact" }, appendDeps)
ok(compacted.ok, "compact is accepted in the append layout")
appendRecord = await appendStore.load("append")
ok((appendRecord.updates ?? []).length === 0, "compact clears the update log")
ok(appendRecord.base?.goal === "ship the append layout", "compact moves the merged memory into the checkpoint")
ok(appendRecord.compact?.mode === "requested", "the pass is asked to reset the window")
const afterCompact = await appendPass([
  ...appendTurn2,
  user("au4", "Fourth."),
  assistant("aa4", "Done."),
])
appendRecord = await appendStore.load("append")
ok(appendRecord.compact === undefined, "the pass consumes the compact request")
ok(afterCompact.messages[0].content[0].text !== checkpointBefore, "compaction replaces the checkpoint")
ok(
  afterCompact.messages[0].content[0].text.includes("ship the append layout"),
  "the new checkpoint carries the folded goal",
)
ok(
  !afterCompact.messages.some((message) => message.id?.startsWith("megasc_update_")),
  "the compacted request has no update blocks",
)

// A narrow working share keeps only the newest turn as the retained tail.
const narrowConfig = resolveConfig({
  options: {
    contextLayout: "append",
    workingTokens: 500,
    memoryTokens: 1000,
    charsPerToken: 2,
    compactKeepTokens: 500,
    defaultProfile: "",
  },
})
const narrowStore = new SessionStore()
const narrowDeps = { store: narrowStore, config: narrowConfig }
const narrowPass = (messages) =>
  buildPayload({ sessionID: "append-narrow", system: [], messages, model: {} }, narrowDeps)

const narrowTurn1 = [user("nu1", "A".repeat(600)), assistant("na1", "ok")]
await narrowPass(narrowTurn1)
await runMemoryTool(
  { sessionID: "append-narrow", action: "patch", patch: { goal: "narrow compaction" } },
  narrowDeps,
)
await runMemoryTool(
  { sessionID: "append-narrow", action: "patch", patch: { notes: "N".repeat(1800) } },
  narrowDeps,
)
const narrowTurn2 = [...narrowTurn1, user("nu2", "B".repeat(2000)), assistant("na2", "ok")]
await narrowPass(narrowTurn2)
await runMemoryTool({ sessionID: "append-narrow", action: "compact" }, narrowDeps)
const narrowTurn3 = [...narrowTurn2, user("nu3", "C".repeat(100)), assistant("na3", "ok")]
const narrowPlan = await narrowPass(narrowTurn3)
const narrowRecord = await narrowStore.load("append-narrow")
ok(
  narrowRecord.base?.goal === "narrow compaction" && (narrowRecord.updates ?? []).length === 0,
  "the narrow compaction folds the log",
)
ok(narrowRecord.windowStart === "nu3", "the retained tail is the newest turn that fits")
ok(
  narrowRecord.archive.some((entry) => entry.id === "nu1") &&
    narrowRecord.archive.some((entry) => entry.id === "nu2"),
  "the dropped turns are archived at the fold",
)
ok(narrowPlan.report.workingTurns === 1, "the request keeps only the tail turn")

// A full pool opens a commit window: due records the current turn, the note
// lists what leaves, and the fold waits for the next prompt.
const dueConfig = resolveConfig({
  options: {
    contextLayout: "append",
    workingTokens: 3000,
    memoryTokens: 2000,
    charsPerToken: 1,
    compactKeepTokens: 500,
    defaultProfile: "",
  },
})
const dueStore = new SessionStore()
const dueDeps = { store: dueStore, config: dueConfig }
const duePass = (messages) =>
  buildPayload({ sessionID: "append-due", system: [], messages, model: {} }, dueDeps)

const dueTurn1 = [user("du1", "D".repeat(3400)), assistant("da1", "ok")]
const dueTurn2 = [...dueTurn1, user("du2", "E".repeat(3400)), assistant("da2", "ok")]
await duePass(dueTurn1)
await duePass(dueTurn2)
const dueTurn3 = [...dueTurn2, user("du3", "F".repeat(3400)), assistant("da3", "ok")]
const dueMarked = await duePass(dueTurn3)
let dueRecord = await dueStore.load("append-due")
ok(dueRecord.compact?.mode === "due", "a full pool marks compaction due")
ok(dueRecord.compact?.turn === "du3", "the due mark records the current turn")
ok(
  dueMarked.messages.some(
    (message) => message.id === "megasc_state" && message.content[0].text.includes("compaction due"),
  ),
  "the tail says compaction is due",
)
ok(
  dueMarked.messages.some(
    (message) =>
      message.id === "megasc_state" &&
      message.content[0].text.includes("du1") &&
      message.content[0].text.includes("du2"),
  ),
  "the due note lists the turns that will leave",
)
const dueStayed = await duePass([
  ...dueTurn3,
  call("da3b", "c9", "read", { path: "src" }),
  result("rr9", "c9", "read", "y".repeat(40)),
])
dueRecord = await dueStore.load("append-due")
ok(dueRecord.compact?.mode === "due", "the commit window stays open inside the turn")
ok(dueRecord.windowStart === "du1", "the window is not re-cut while the commit window is open")
ok(
  dueStayed.messages[0].content[0].text.includes("goal: (empty"),
  "the checkpoint has not folded mid-window",
)
const committed = await runMemoryTool(
  { sessionID: "append-due", action: "patch", patch: { goal: "committed during the window" } },
  dueDeps,
)
ok(committed.ok, "a commit-window patch is accepted")
const dueFolded = await duePass([
  ...dueTurn3,
  call("da3b", "c9", "read", { path: "src" }),
  result("rr9", "c9", "read", "y".repeat(40)),
  user("du4", "Next prompt."),
  assistant("da4", "ok"),
])
dueRecord = await dueStore.load("append-due")
ok(dueRecord.compact === undefined, "the next prompt performs the compaction")
ok(
  dueRecord.base?.goal === "committed during the window",
  "the committed memory is folded into the checkpoint",
)
ok(
  dueFolded.messages[0].content[0].text.includes("committed during the window"),
  "the folded request carries the committed checkpoint",
)
ok((dueRecord.updates ?? []).length === 0, "the due fold clears the update log")
ok(dueRecord.windowStart === "du4", "the folded tail keeps only the newest turn")
ok(
  dueRecord.archive.some((entry) => entry.id === "du1") &&
    dueRecord.archive.some((entry) => entry.id === "du2") &&
    dueRecord.archive.some((entry) => entry.id === "du3"),
  "the dropped turns are archived at the fold",
)
ok(dueRecord.pending.length === 0, "nothing waits in pending after the fold")
ok(
  !dueFolded.messages.some(
    (message) => message.id === "megasc_state" && message.content[0].text.includes("compaction due"),
  ),
  "the folded request drops the due note",
)

// ---------------------------------------------------------------------------
// A near-cap pool offers one extension; the grant clears the due mark
// ---------------------------------------------------------------------------
const extendConfig = resolveConfig({
  options: {
    contextLayout: "append",
    memoryTokens: 1000,
    workingTokens: 3000,
    charsPerToken: 4,
    windowExtend: true,
    windowExtendFactor: 2,
    windowWarnPercent: 80,
    defaultProfile: "",
  },
})
const extendStore = new SessionStore()
const extendDeps = { store: extendStore, config: extendConfig }
const extendModel = { limit: { context: 1_000_000 } }
const extendPass = (messages) =>
  buildPayload(
    { sessionID: "append-extend", system: [{ type: "text", text: "base" }], messages, model: extendModel },
    extendDeps,
  )
const extTurn0 = [user("xu0", "start"), assistant("xa0", "ok")]
await extendPass(extTurn0)
const extTurn1 = [...extTurn0, user("xu1", "x".repeat(6500)), assistant("xa1", "ok")]
const extTurn2 = [...extTurn1, user("xu2", "y".repeat(6500)), assistant("xa2", "ok")]
const extNear = await extendPass(extTurn2)
ok(
  extNear.messages.some(
    (message) =>
      message.id === "megasc_state" &&
      message.content[0].text.includes("window:") &&
      message.content[0].text.includes('action:"extend"'),
  ),
  "the near-cap note offers the extension",
)
const extGranted = await runMemoryTool(
  { sessionID: "append-extend", action: "extend", reason: "finish the current edit" },
  extendDeps,
)
let extendRecord = await extendStore.load("append-extend")
ok(extGranted.ok && extendRecord.ext?.toCap === 8000 && extendRecord.ext?.factor === 2, "extend doubles the pool")
ok(extendRecord.compact === undefined, "an extension clears a due mark")
const extAfter = await extendPass(extTurn2)
ok(
  extAfter.messages.some(
    (message) =>
      message.id === "megasc_state" &&
      message.content[0].text.includes("extension: +100%") &&
      message.content[0].text.includes("/8k"),
  ),
  "the note shows the extended cap and the grant",
)
const extAgain = await runMemoryTool(
  { sessionID: "append-extend", action: "extend", reason: "one more" },
  extendDeps,
)
ok(!extAgain.ok && extAgain.text.includes("already has an extension"), "a second extension is refused")
const extCompact = await runMemoryTool({ sessionID: "append-extend", action: "compact" }, extendDeps)
ok(extCompact.ok, "compact is accepted after an extension")
await extendPass([...extTurn2, user("xu3", "next"), assistant("xa3", "ok")])
extendRecord = await extendStore.load("append-extend")
ok(extendRecord.ext === undefined, "the fold clears the extension for the next era")

const unknownWindowStore = new SessionStore()
const unknownWindowDeps = {
  store: unknownWindowStore,
  config: resolveConfig({
    options: { contextLayout: "append", memoryTokens: 1000, workingTokens: 3000, defaultProfile: "" },
  }),
}
await buildPayload(
  {
    sessionID: "append-extend-unknown",
    system: [],
    messages: [user("yu1", "hi"), assistant("ya1", "ok")],
    model: {},
  },
  unknownWindowDeps,
)
const noWindow = await runMemoryTool(
  { sessionID: "append-extend-unknown", action: "extend", reason: "room" },
  unknownWindowDeps,
)
ok(!noWindow.ok && noWindow.text.includes("model window is unknown"), "an unknown window cannot extend")

const modelWindowCache = new Map()
const modelWindowHost = {
  model: {
    list: async () => ({
      data: [
        {
          providerID: "opencode-go",
          id: "deepseek-v4.1-flash",
          modelID: "deepseek-v4.1-flash",
          limit: { context: 1_000_000 },
        },
      ],
    }),
  },
}
const resolvedWindow = await modelWindowOf(
  modelWindowHost,
  { id: "deepseek-v4.1-flash", providerID: "opencode-go" },
  modelWindowCache,
)
ok(resolvedWindow === 1_000_000, "the model window resolves from the host model list")
ok(
  modelWindowCache.get("opencode-go/deepseek-v4.1-flash") === 1_000_000,
  "the resolved model window is cached",
)

// The note prints the pool cap on every window: the extension decision needs a
// denominator, and the real window is only the clamp the grant enforces.
const limitNote = async (model) =>
  (await appendPass([user("lg1", "Hello."), assistant("la1", "Hi.")], model)).messages.find(
    (message) => message.id === "megasc_state",
  )
const smallCapNote = await limitNote({ limit: { context: 280_000 } })
ok(
  smallCapNote !== undefined && smallCapNote.content[0].text.includes("/23k"),
  "the note prints the cap when the model window is small",
)
ok(
  smallCapNote !== undefined && /\/23k · \d+%/.test(smallCapNote.content[0].text),
  "the note prints the percent next to the cap",
)
const bigWindowNote = await limitNote({ limit: { context: 1_000_000 } })
ok(
  bigWindowNote !== undefined && bigWindowNote.content[0].text.includes("/23k"),
  "the note prints the cap when the model window is large",
)
const boundaryWindowNote = await limitNote({ limit: { context: 300_000 } })
ok(
  boundaryWindowNote !== undefined && boundaryWindowNote.content[0].text.includes("/23k"),
  "the note prints the cap at the old small-window boundary",
)
const unknownWindowNote = await limitNote({})
ok(
  unknownWindowNote !== undefined && unknownWindowNote.content[0].text.includes("/23k"),
  "the note prints the cap when the model window is unknown",
)

// A fold can rebuild the retained tail's bytes when the flag is on.
const rebuiltUnit = rebuildTurn([
  withReasoning("ub1", "scratch work ".repeat(20), "Answer."),
  call("ub2", "uc1", "edit", { path: "src/a.ts" }),
  result("ub3", "uc1", "edit", "Applied 1 edit to src/a.ts"),
  result("ub4", "uc2", "edit", "Error: no such file"),
  result("ub5", "uc3", "bash", "line\n".repeat(40)),
  result("ub6", "uc4", "custom", "keep me"),
])
ok(
  !(rebuiltUnit.messages.find((m) => m.id === "ub1").content ?? []).some((p) => p.type === "reasoning"),
  "the rebuild drops completed-turn reasoning",
)
ok(
  rebuiltUnit.messages.find((m) => m.id === "ub1").content[0].text === "Answer.",
  "the rebuild keeps the assistant text",
)
ok(
  rebuiltUnit.messages.find((m) => m.id === "ub3").content[0].result.value === "src/a.ts ok" &&
    rebuiltUnit.messages.find((m) => m.id === "ub3").content[0].result.type === "text",
  "a successful edit result becomes the path and ok, with its shape kept",
)
ok(
  rebuiltUnit.messages.find((m) => m.id === "ub4").content[0].result.value === "Error: no such file",
  "an error result is kept verbatim",
)
ok(
  rebuiltUnit.messages.find((m) => m.id === "ub5").content[0].result.value.includes("lines dropped"),
  "a long successful shell result keeps its tail",
)
ok(
  rebuiltUnit.messages.find((m) => m.id === "ub6").content[0].result.value === "keep me",
  "an unknown tool result is left alone",
)
const contentShape = {
  id: "ub7",
  role: "tool",
  content: [
    { type: "tool-result", id: "uc5", name: "edit", result: { type: "content", value: [{ type: "text", text: "done" }] } },
  ],
}
ok(rebuildTurn([contentShape]).messages[0] === contentShape, "a content result keeps its shape untouched")
ok(rebuiltUnit.charsSaved > 0, "the rebuild reports the characters it saved")

// A successful write/edit call keeps only its path: the body is on disk and the
// result already confirmed it.
const trimmedCalls = rebuildTurn([
  call("wc1", "w1", "write", { path: "src/a.ts", content: "body ".repeat(100) }),
  result("wr1", "w1", "write", "Wrote 500 bytes to src/a.ts"),
  call("ec1", "e1", "edit", { path: "src/b.ts", oldString: "old ".repeat(100), newString: "new ".repeat(100) }),
  result("er1", "e1", "edit", "Applied 1 edit to src/b.ts"),
])
ok(
  JSON.stringify(trimmedCalls.messages.find((m) => m.id === "wc1").content[0].input) === JSON.stringify({ path: "src/a.ts" }),
  "a successful write call keeps only its path",
)
ok(
  JSON.stringify(trimmedCalls.messages.find((m) => m.id === "ec1").content[0].input) === JSON.stringify({ path: "src/b.ts" }),
  "a successful edit call keeps only its path",
)
const failedBody = rebuildTurn([
  call("fc1", "f1", "write", { path: "src/c.ts", content: "body ".repeat(100) }),
  result("fr1", "f1", "write", "Error: no such file"),
])
ok(
  String(failedBody.messages[0].content[0].input.content).startsWith("body"),
  "a failed write keeps its input body",
)
const orphanCall = rebuildTurn([call("oc1", "o1", "write", { path: "src/d.ts", content: "z".repeat(100) })])
ok(
  String(orphanCall.messages[0].content[0].input.content).startsWith("z"),
  "a call with no result keeps its input",
)
const pairCalls = trimmedCalls.messages.flatMap((m) => (m.content ?? []).filter((p) => p.type === "tool-call").map((p) => p.id))
const pairResults = trimmedCalls.messages.flatMap((m) => (m.content ?? []).filter((p) => p.type === "tool-result").map((p) => p.id))
ok(
  pairCalls.length === pairResults.length && pairCalls.every((id) => pairResults.includes(id)),
  "trimming a call input leaves every call/result pair whole",
)

// A read a later read of the same path repeats becomes a marker; the newest
// copy, a different range, and a read before a write all stay.
const readOne = [call("rd1", "r1", "read", { path: "src/a.ts" }), result("rr1", "r1", "read", "x".repeat(500))]
const readTwo = [call("rd2", "r2", "read", { path: "src/a.ts" }), result("rr2", "r2", "read", "x".repeat(500))]
const replaced = supersededReads([readOne, readTwo])
ok(replaced.get("r1") === "src/a.ts" && !replaced.has("r2"), "a later full read replaces the earlier copy and not itself")
const readPass = rebuildTurn([...readOne, ...readTwo], { supersededReads: replaced })
ok(
  readPass.messages.find((m) => m.id === "rr1").content[0].result.value.startsWith("[superseded by a later read of src/a.ts]"),
  "a replaced read becomes a one-line marker",
)
ok(
  readPass.messages.find((m) => m.id === "rr2").content[0].result.value === "x".repeat(500),
  "the newest read keeps its bytes",
)
const partialOne = [call("pd1", "p1", "read", { path: "src/a.ts", offset: 1, limit: 40 }), result("pr1", "p1", "read", "y".repeat(300))]
const partialTwo = [call("pd2", "p2", "read", { path: "src/a.ts", offset: 41, limit: 40 }), result("pr2", "p2", "read", "y".repeat(300))]
ok(supersededReads([partialOne, partialTwo]).size === 0, "reads of different ranges are all kept")
const editedBetween = [
  readOne,
  [call("wd1", "w9", "write", { path: "src/a.ts", content: "z" }), result("wdr1", "w9", "write", "ok")],
  readTwo,
]
ok(supersededReads(editedBetween).size === 0, "a read before a write is history, not a duplicate")

// A grep result keeps the files and line numbers and drops the quoted lines.
const grepTurn = rebuildTurn([
  result("gr1", "g1", "grep", "Found 2 matches\nsrc/a.ts:\n  Line 1: const a = 1\n  Line 2: export {}\n"),
])
ok(
  grepTurn.messages[0].content[0].result.value.trimEnd() === "Found 2 matches\nsrc/a.ts: 1, 2",
  "a grep result keeps the file and line numbers and drops the quoted lines",
)
const grepFailure = rebuildTurn([result("ge1", "g2", "grep", "Error: cannot search\nsrc/a.ts:\n  Line 1: x")])
ok(
  grepFailure.messages[0].content[0].result.value.startsWith("Error: cannot search"),
  "an error grep result is kept verbatim",
)

// The fold applies the rebuild to the retained tail, and only there.
const rebuildConfig = resolveConfig({
  options: {
    contextLayout: "append",
    workingTokens: 20_000,
    memoryTokens: 3000,
    charsPerToken: 2,
    rebuildOnCompaction: true,
    compactKeepTokens: 5000,
    defaultProfile: "",
  },
})
const rebuildStore = new SessionStore()
const rebuildDeps = { store: rebuildStore, config: rebuildConfig }
const rebuildPass = (messages) =>
  buildPayload({ sessionID: "append-rebuild", system: [], messages, model: {} }, rebuildDeps)

const rebuildTurn1 = [
  user("ru1", "Edit the file."),
  call("ra1", "rc1", "edit", { path: "src/x.ts", oldString: "a", newString: "b" }),
  result("rr1", "rc1", "edit", "Applied 1 edit to src/x.ts"),
  call("ra5", "rc5", "read", { path: "src/y.ts" }),
  result("rr5", "rc5", "read", "read body ".repeat(30)),
  withReasoning("ra2", "private step ".repeat(30), "Done."),
]
const rebuildTurn2 = [
  ...rebuildTurn1,
  user("ru2", "Next."),
  call("ra6", "rc6", "read", { path: "src/y.ts" }),
  result("rr6", "rc6", "read", "read body ".repeat(30)),
  withReasoning("ra3", "more private ".repeat(30), "Alright."),
]
await rebuildPass(rebuildTurn1)
await rebuildPass(rebuildTurn2)
await runMemoryTool({ sessionID: "append-rebuild", action: "compact" }, rebuildDeps)
const rebuiltPass = await rebuildPass([...rebuildTurn2, user("ru3", "Third."), assistant("ra4", "Ok.")])
const rebuildRecord = await rebuildStore.load("append-rebuild")
ok(
  (rebuildRecord.rebuilt ?? []).includes("ru1") && !(rebuildRecord.rebuilt ?? []).includes("ru3"),
  "the fold marks the completed tail turns for rebuild",
)
ok(
  !(rebuiltPass.messages.find((m) => m.id === "ra2").content ?? []).some((p) => p.type === "reasoning"),
  "the folded request drops completed-turn reasoning",
)
const sentEdit = rebuiltPass.messages.find((m) => m.id === "rr1")
ok(
  sentEdit !== undefined && sentEdit.content[0].result.value === "src/x.ts ok",
  "the folded request replaces the successful edit result",
)
ok(
  rebuiltPass.messages.find((m) => m.id === "ru1").content[0].text === "Edit the file.",
  "the rebuild keeps user text verbatim",
)
const rebuiltAgain = await rebuildPass([...rebuildTurn2, user("ru3", "Third."), assistant("ra4", "Ok.")])
ok(
  JSON.stringify(rebuiltAgain.messages.find((m) => m.id === "rr1")) === JSON.stringify(sentEdit),
  "a later pass reproduces the rebuilt bytes",
)
ok((rebuildRecord.rebuildSaved ?? 0) > 0, "the fold records the characters the rebuild saved")
const sentRead = rebuiltPass.messages.find((m) => m.id === "rr5")
ok(
  sentRead !== undefined && sentRead.content[0].result.value === "[superseded by a later read of src/y.ts]",
  "the folded request replaces a read a later turn repeated",
)
ok(
  rebuiltPass.messages.find((m) => m.id === "rr6").content[0].result.value.startsWith("read body"),
  "the fold keeps the newest read of the path",
)
ok(
  JSON.stringify(rebuiltPass.messages.find((m) => m.id === "ra1").content[0].input) === JSON.stringify({ path: "src/x.ts" }),
  "the folded request trims the completed edit call to its path",
)
ok(
  JSON.stringify(rebuiltAgain.messages.find((m) => m.id === "rr5")) === JSON.stringify(sentRead),
  "a later pass reproduces the superseded marker",
)

// An old record's memory becomes the first checkpoint without replaying a log.
const oldStorage = new Map()
oldStorage.set("session/append-old", {
  version: 1,
  memory: { ...emptyMemory(), goal: "old record" },
  seenTurns: [],
  pending: [],
  archive: [],
  createdAt: 1,
  updatedAt: 1,
})
const oldStore = new SessionStore({
  async get(key) {
    return oldStorage.get(key)
  },
  async set(key, value) {
    oldStorage.set(key, value)
  },
  async remove(key) {
    oldStorage.delete(key)
  },
  async scan() {
    return { entries: [] }
  },
})
await buildPayload(
  { sessionID: "append-old", system: [], messages: [user("ou1", "old")], model: {} },
  { store: oldStore, config: appendConfig },
)
const oldRecord = await oldStore.load("append-old", { fresh: true })
ok(
  oldRecord.base?.goal === "old record" && (oldRecord.updates ?? []).length === 0,
  "an old record migrates its memory to the checkpoint",
)

// The append window starts at the marker and asks for a fallback when it is gone.
const appendWindow = selectAppendWindow(appendTurn2, "au2")
ok(appendWindow?.turns.map((span) => span.id).join(",") === "au2", "the append window keeps from the marker")
ok(selectAppendWindow(appendTurn2, "missing") === undefined, "a missing marker asks for a fallback")

ok(
  TOOL_DESCRIPTION.includes("Only when the state note says compaction is due") &&
    TOOL_DESCRIPTION.includes("does not shrink memory"),
  "the tool description reserves compact for a due pool",
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

// `/context resume` sends the plugin's own sentence through the synthetic
// channel. It must land on the same tail path as the host's cue.
ok(hostMessageOf(noticeMsg("r1", RESUMED_TEXT))?.kind === "cue", "the /context resume sentence is a cue")
ok(noticeOf(noticeMsg("r1", RESUMED_TEXT)) === undefined, "the resume sentence is never pinned on the notice rail")
ok(isRealUser(noticeMsg("r1", RESUMED_TEXT)) === false, "the resume sentence does not start a turn")
ok(isHostTail(noticeMsg("r1", RESUMED_TEXT)), "the resume sentence is a turn tail")
ok(
  hostMessageOf(noticeMsg("r2", RESUMED_TEXT, "\n@7@"))?.kind === "cue",
  "the resume sentence is recognised with a trailing @n@ marker",
)
ok(
  hostMessageOf(noticeMsg("r3", "Continue from where you left off without repeating completed content.")) === undefined,
  "the resume sentence without its marker stays a real turn",
)
ok(
  turnSpans([user("u1", "Run it. ".repeat(20)), assistant("a1", "Partial. "), noticeMsg("r-late", RESUMED_TEXT)]).length === 1,
  "the resume sentence annexes to the turn it continues",
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
    options: { workingTokens: 500, memoryTokens: 3000, charsPerToken: 2, defaultProfile: "" },
  }),
}
const jobPass = (messages) =>
  buildPayload({ sessionID: "job", system: [{ type: "text", text: "base" }], messages, model: {} }, jobDeps)
await jobPass(firstTurn)
const jobBefore = await jobPass([...firstTurn, ...secondTurn])
ok((await jobStore.load("job")).pending.length === 0, "append has no pending baseline")
const jobAfter = await jobPass([...firstTurn, ...secondTurn, noticeMsg("j-late", SHELL_JOB)])
const jobRecord = await jobStore.load("job")
ok(jobAfter.report.workingTurns === jobBefore.report.workingTurns, "a job completion adds no working turn")
ok(
  jobAfter.report.workingTokens > jobBefore.report.workingTokens,
  "the job's bytes are still counted in the working window",
)
ok(jobRecord.pending.length === 0, "a job completion creates no pending turn")
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
    options: { workingTokens: 500, memoryTokens: 3000, charsPerToken: 2, defaultProfile: "" },
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
ok(cueRecord.pending.length === 0, "a resume cue creates no pending turn")
ok(cueRecord.archive.length === 0, "a resume cue does not archive a pending turn")
ok(
  cueAfter.system.every((part) => !part.text.includes("previous response was interrupted")),
  "a resume cue never reaches the notice rail",
)
ok(
  cueAfter.messages.some((message) => message.id === "c-late"),
  "the cue itself is still in the payload",
)

// The same guarantees hold for the sentence `/context resume` sends: a new cue
// id must not read as a new turn, so the pending eviction cannot age.
const cueAfterResume = await cuePass([...firstTurn, ...secondTurn, noticeMsg("r-late", RESUMED_TEXT)])
const cueResumeRecord = await cueStore.load("cue")
ok(cueAfterResume.report.workingTurns === cueBefore.report.workingTurns, "the resume sentence adds no working turn")
ok(cueResumeRecord.pending.length === 0, "the resume sentence creates no pending turn")
ok(cueResumeRecord.archive.length === 0, "the resume sentence does not archive a pending turn")
ok(
  cueAfterResume.messages.some((message) => message.id === "r-late"),
  "the resume sentence is still in the payload",
)
ok(
  cueAfterResume.system.every((part) => !part.text.includes("Continue from where you left off")),
  "the resume sentence never reaches the notice rail",
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
// Store: a fresh read, and a write that refuses to overwrite a newer copy
//
// The host can load the server half more than once per run, and each instance
// has its own cache. The ODT block painted a number that had stopped being true
// because the answering instance never re-read storage.
// ---------------------------------------------------------------------------

function memoryStorage(map) {
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async scan() {
      return { entries: [] }
    },
  }
}

const sharedMap = new Map()
const sharedWarn = []
let sharedClock = 1_000
const sharedOptions = { now: () => sharedClock, warn: (line) => sharedWarn.push(line) }
const storeA = new SessionStore(memoryStorage(sharedMap), sharedOptions)
const storeB = new SessionStore(memoryStorage(sharedMap), sharedOptions)

const a1 = await storeA.load("pair")
a1.memory.goal = "A1"
await storeA.save("pair", a1)
const b1 = await storeB.load("pair")
ok(b1.memory.goal === "A1", "a first read in another instance sees the stored record")

sharedClock = 2_000
const a2 = await storeA.load("pair", { fresh: true })
a2.memory.goal = "A2"
await storeA.save("pair", a2)
ok((await storeB.load("pair")).memory.goal === "A1", "a cached read does not see another instance's later write")
ok(
  (await storeB.load("pair", { fresh: true })).memory.goal === "A2",
  "a fresh read replaces the cached copy with the stored one",
)

sharedClock = 3_000
const staleCopy = { ...b1, memory: { ...b1.memory, goal: "B-stale" }, updatedAt: 1_000 }
ok(
  (await storeB.save("pair", staleCopy)) === false,
  "a save refuses to overwrite a record written after its copy was read",
)
ok(sharedMap.get("session/pair").memory.goal === "A2", "the newer stored record survives the refused save")
ok((await storeB.load("pair")).memory.goal === "A2", "the refused instance adopts the stored record")
ok(
  sharedWarn.some((line) => line.includes("another instance")),
  "a refused write is logged instead of silently dropping the edit",
)
ok(
  (await storeB.mutate("pair", (record) => record.memory.goal)) === "A2",
  "a mutation starts from the stored record, not from this instance's cache",
)

let retried = 0
const retriedOutcome = await storeB.mutate("race", async (record) => {
  if (retried === 0) {
    retried += 1
    sharedClock += 1
    const other = await storeA.load("race", { fresh: true })
    other.memory.goal = "won"
    await storeA.save("race", other)
  }
  record.memory.goal = `${record.memory.goal}+mine`
  return record.memory.goal
})
ok(
  retriedOutcome === "won+mine" && retried === 1,
  "a write that loses the race is retried once on the newer record",
)

let attempts = 0
await assert.rejects(
  storeB.mutate("clash", async (record) => {
    attempts += 1
    sharedClock += 1
    const other = await storeA.load("clash", { fresh: true })
    other.memory.goal = `n${attempts}`
    await storeA.save("clash", other)
    record.memory.goal = "mine"
  }),
  (error) => error instanceof StoreConflictError,
)
ok(attempts === 2, "a second loss in a row is thrown after one retry, with nothing written")

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
// Delegated reads: recall/expand from the spawning session's archive
// ---------------------------------------------------------------------------

// The core path: a child session with parentOf wired, a parent record holding one
// archived turn with raw messages, and a config that pins both switches.
const parentStore = new SessionStore()
const parentDeps = {
  store: parentStore,
  config: resolveConfig({ options: { memoryTokens: 100_000 } }),
  parentOf: async (sessionID) => (sessionID.startsWith("child") ? "parent-9" : undefined),
}
const parentSeed = [
  user("p1", "The exports live in src/index.ts. ".repeat(3)),
  assistant("pa1", "Noted. ".repeat(3)),
]
await buildPayload({ sessionID: "parent-9", system: [{ type: "text", text: "base" }], messages: parentSeed, model: {} }, parentDeps)
const seeded = await parentStore.load("parent-9")
seeded.pending = [] // start from a clean slate; the seats are taken below
seeded.archive.push({
  id: "p1",
  gist: "answer: the exports live in src/index.ts",
  chars: 500,
  createdAt: 0,
  messages: parentSeed.map((message) => ({ ...message })),
})
ok(seeded.archive.length === 1, "the parent fixture owns one archived turn")

outcome = await runMemoryTool({ sessionID: "child-9", action: "recall", query: "exports", lost: true, from: "parent" }, parentDeps)
ok(outcome.ok && outcome.text.includes("spawning session's archive"), "recall from a child searches the parent's archive")
ok(outcome.text.includes('turn:"p1" from:"parent"'), "the delegated match hints how to expand it")
ok(outcome.text.includes("exports") && outcome.text.length < 1_200, "a match carries a snippet, not a replay of the turn")
outcome = await runMemoryTool({ sessionID: "child-9", action: "recall", query: "zzz", lost: true, from: "parent" }, parentDeps)
ok(outcome.text.includes("in the spawning session's archive"), "a delegated no-match names the archive it searched")
outcome = await runMemoryTool({ sessionID: "child-9", action: "expand", turn: "p1", from: "parent" }, parentDeps)
ok(outcome.ok && outcome.text.includes("Noted."), "expand from a child reads the parent's raw turn")

// Recall matches terms, not one contiguous phrase: "exports index.ts" is not a
// substring of the turn, but every word is in it.
outcome = await runMemoryTool({ sessionID: "child-9", action: "recall", query: "exports index.ts", lost: true, from: "parent" }, parentDeps)
ok(outcome.ok && outcome.text.includes('turn:"p1"'), "recall matches terms that are not adjacent")
ok(/@\d+ /.test(outcome.text), "a snippet reports the offset it sits at")

// The way in is narrow: bad value, disabled config, host without the answer, top level.
outcome = await runMemoryTool({ sessionID: "child-9", action: "recall", query: "x", lost: true, from: "sibling" }, parentDeps)
ok(!outcome.ok && outcome.text.includes('from must be "parent"'), "a non-parent from is refused")
outcome = await runMemoryTool(
  { sessionID: "child-9", action: "expand", turn: "p1", from: "parent" },
  { ...parentDeps, config: resolveConfig({ options: { parentArchive: false } }) },
)
ok(!outcome.ok && outcome.text.includes("parentArchive:false"), "the disabled config refuses the parent read")
outcome = await runMemoryTool({ sessionID: "child-9", action: "expand", turn: "p1", from: "parent" }, {
  store: parentStore,
  config: resolveConfig({}),
  // no parentOf at all: the host never explained parentage
})
ok(!outcome.ok && outcome.text.includes("cannot look up"), "a host without parent facts refuses the parent read")
outcome = await runMemoryTool({ sessionID: "parent-9", action: "expand", turn: "p1", from: "parent" }, parentDeps)
ok(!outcome.ok && outcome.text.includes("no parent"), "a top-level session has no parent to read from")

// Writes stay local even when the reader is a delegate: from cannot move them.
const childRecordBeforePurge = (await parentStore.load("parent-9")).archive.length
outcome = await runMemoryTool({ sessionID: "child-9", action: "purge", query: "exports", from: "parent" }, parentDeps)
ok(!outcome.ok && outcome.text.includes("only recall and expand"), "purge refuses to act from")
ok((await parentStore.load("parent-9")).archive.length === childRecordBeforePurge, "the refused purge left the parent alone")
outcome = await runMemoryTool({ sessionID: "child-9", action: "recall", query: "x", lost: true, from: true }, parentDeps)
ok(!outcome.ok && !outcome.text.startsWith("no archived turn"), "a non-string from is refused, not resolved")

// Paging: a long turn comes back in honest pages sized under the compression
// limit, so the next pass cannot cut a page in the middle.
const longTurn = [user("p2", "Long. ".repeat(2200)), assistant("pa2", "Reply. ".repeat(2200))]
const deepTurn = [user("p4", "Head. "), assistant("pa4", "filler ".repeat(8000) + " zebra")]
await parentStore.mutate("parent-9", (record) => {
  record.archive.push({ id: "p2", gist: "long turn", chars: 10_000, createdAt: 0, messages: longTurn })
  record.archive.push({ id: "p4", gist: "a deep turn", chars: 60_000, createdAt: 0, messages: deepTurn })
})
const first = await runMemoryTool({ sessionID: "child-9", action: "expand", turn: "p2", from: "parent" }, parentDeps)
ok(first.ok && first.text.includes("continue with offset:"), "a long expansion is paged, not truncated")
const footer = /\(chars (\d+)–(\d+) of (\d+); (continue with offset:(\d+)|end of turn)\)/.exec(first.text)
ok(footer !== null, "a page footer reports its own range and the turn's size")
const total = Number(footer?.[3] ?? 0)
ok(total > 20_000, "the footer reports the whole turn, not the page")
ok(first.text.length <= parentDeps.config.maxResultChars, "a page plus its footer stays under the compression limit")

const next = await runMemoryTool(
  { sessionID: "child-9", action: "expand", turn: "p2", offset: Number(footer?.[5]), from: "parent" },
  parentDeps,
)
const secondFooter = /\(chars (\d+)–(\d+) of (\d+);/.exec(next.text)
ok(secondFooter?.[1] === footer?.[2], "the next page starts where the last one ended")
ok(Number(secondFooter?.[3] ?? 0) === total, "every page reports the same total")

const tail = await runMemoryTool(
  { sessionID: "child-9", action: "expand", turn: "p2", offset: total - 100, from: "parent" },
  parentDeps,
)
ok(tail.ok && tail.text.includes("end of turn"), "the last page says end of turn")
const fromEnd = await runMemoryTool(
  { sessionID: "child-9", action: "expand", turn: "p2", offset: -100, from: "parent" },
  parentDeps,
)
ok(fromEnd.ok && fromEnd.text.includes("end of turn"), "a negative offset counts from the end")
const pastEnd = await runMemoryTool(
  { sessionID: "child-9", action: "expand", turn: "p2", offset: 10_000_000, from: "parent" },
  parentDeps,
)
ok(pastEnd.ok && pastEnd.text.startsWith(`(chars ${total}–${total} of ${total}; end of turn)`), "an offset past the end is an empty end page")

// A turn that fits is one page, and says so rather than pushing a summary.
const whole = await runMemoryTool({ sessionID: "child-9", action: "expand", turn: "p1", from: "parent" }, parentDeps)
ok(whole.text.includes("end of turn") && !whole.text.includes("continue with offset:"), "a turn that fits is one page")
const sized = await runMemoryTool(
  { sessionID: "child-9", action: "expand", turn: "p2", from: "parent" },
  { ...parentDeps, config: resolveConfig({ options: { expandDigestChars: 1_500 } }) },
)
ok(sized.text.length <= 1_500, "the page size follows the configured number")

// The outline is the map: one line per part, its offset and its size in one page.
const outline = await runMemoryTool({ sessionID: "child-9", action: "expand", turn: "p2", mode: "outline", from: "parent" }, parentDeps)
ok(outline.ok && outline.text.includes("@0 [user]") && outline.text.includes("@13208 [assistant]"), "the outline names where each part sits")
ok(/\+\d+ chars\]/.test(outline.text) && outline.text.includes(`${total} chars`), "the outline names the elided size and the total")
ok(outline.text.length <= parentDeps.config.maxResultChars, "the outline fits one result")
const badMode = await runMemoryTool({ sessionID: "child-9", action: "expand", turn: "p2", mode: "digest", from: "parent" }, parentDeps)
ok(!badMode.ok && badMode.text.includes('"page"') && badMode.text.includes('"outline"'), "expand mode must be page or outline")

// A delegated read names the reply budget, because the caller's next pass erodes
// the child's answer to maxResultChars no matter how long it wrote.
ok(first.text.includes("your caller keeps at most 4000 chars of your reply"), "a delegated expand names the reply budget")
const delegatedRecall = await runMemoryTool({ sessionID: "child-9", action: "recall", query: "exports", lost: true, from: "parent" }, parentDeps)
ok(delegatedRecall.text.includes("your caller keeps at most 4000 chars"), "a delegated recall names the reply budget")
const localRecall = await runMemoryTool({ sessionID: "child-9", action: "recall", query: "exports", lost: true }, parentDeps)
ok(!localRecall.text.includes("delegating:"), "a local recall carries no delegation note")

// Search covers the whole turn: the old 40,000-char render stopped well short.
const deep = await runMemoryTool({ sessionID: "child-9", action: "recall", query: "zebra", lost: true, from: "parent" }, parentDeps)
ok(deep.ok && deep.text.includes('turn:"p4"'), "recall finds a term past the old forty-thousand cap")
const deepAt = /@(\d+) /.exec(deep.text)
ok(Number(deepAt?.[1] ?? 0) > 40_000, "a deep snippet reports its real offset")

// A pending turn is readable too: its raw sits in the record from the moment the
// window drops it, so a turn is not lost just because nobody archived it yet.
const pendingTurn = [user("p5", 'the spec says: add a new option "overlay"'), assistant("pa5", "Noted.")]
await parentStore.mutate("parent-9", (record) => {
  record.pending.push({ id: "p5", gist: "a pending spec", chars: 200, createdAt: 0, age: 1, messages: pendingTurn })
})
const pendingRead = await runMemoryTool({ sessionID: "parent-9", action: "expand", turn: "p5" }, parentDeps)
ok(pendingRead.ok && pendingRead.text.includes('add a new option "overlay"'), "expand reads a pending turn's raw")
ok(pendingRead.text.includes("pending turn") && pendingRead.text.includes("keepRaw:true"), "a pending read says it is not durable")
const pendingOutline = await runMemoryTool({ sessionID: "parent-9", action: "expand", turn: "p5", mode: "outline" }, parentDeps)
ok(pendingOutline.ok && pendingOutline.text.includes("@0 [user]"), "a pending turn has an outline too")
const pendingRecall = await runMemoryTool({ sessionID: "parent-9", action: "recall", query: "overlay", lost: true }, parentDeps)
ok(!pendingRecall.text.includes('turn:"p5"'), "recall stays archive-only; a pending turn is read with expand")
const missingTurn = await runMemoryTool({ sessionID: "parent-9", action: "expand", turn: "nope" }, parentDeps)
ok(
  !missingTurn.ok && missingTurn.text.includes("pending eviction queue") && missingTurn.text.includes("Pending:"),
  "a missing expansion names both places it looked",
)

// A gist-only archive reports what it cost: the raw is gone and expand can only
// return the gist. The warning is the last moment the choice can be undone.
await parentStore.mutate("archive-c", (record) => {
  record.pending.push({ id: "pc", gist: "mechanical", chars: 10, createdAt: 0, age: 0, messages: [user("pc", "spec"), assistant("pac", "ok")] })
  record.pending.push({ id: "pc2", gist: "mechanical", chars: 10, createdAt: 0, age: 0, messages: [user("pc2", "spec"), assistant("pac2", "ok")] })
})
const droppedRaw = await runMemoryTool({ sessionID: "archive-c", action: "archive", turn: "pc", gist: "my gist" }, parentDeps)
ok(droppedRaw.ok && droppedRaw.text.includes("gist only; the raw was discarded"), "a gist-only archive warns that the raw is gone")
ok(droppedRaw.text.includes("expand will show only this gist"), "the warning says what expand will return now")
const afterDrop = await runMemoryTool({ sessionID: "archive-c", action: "expand", turn: "pc" }, parentDeps)
ok(afterDrop.ok && afterDrop.text.includes("gist only"), "the archived entry really has no raw left")
const keptRaw = await runMemoryTool({ sessionID: "archive-c", action: "archive", turn: "pc2", gist: "my gist", keepRaw: true }, parentDeps)
ok(keptRaw.ok && keptRaw.text.includes("gist + raw") && !keptRaw.text.includes("discarded"), "keeping the raw is reported plainly")

// The mechanical gist is a head AND a tail: a head-only 90-char cut once threw
// away the one word a spec's whole plan hung on.
const spec = `${"preamble. ".repeat(20)}add a new option "overlay" to the tray menu`
const cut = gistText(spec)
ok(cut.length <= 163 && cut.startsWith("preamble."), "a mechanical gist keeps the head for context")
ok(cut.endsWith('"overlay" to the tray menu'), "the gist keeps the tail where the decisive word sits")
ok(cut.includes("…"), "a cut gist marks what it skipped")
ok(gistText("  one   line ") === "one line", "a short gist is just the collapsed text")
ok(gistText("   ") === "(no text)", "an empty turn still gets a placeholder")
const gistSpan = { id: "m1", turn: 1, startIdx: 0, endIdx: 1, userText: spec, tools: ["bash"], chars: 900 }
ok(mechanicalGist(gistSpan, 4).includes('"overlay"'), "the eviction gist carries the decisive word")

// The host path: the fixture gives every "child*" session the parent "parent-1".
// Give that parent a real archive: four passes over a growing transcript — one to
// bootstrap the seen turns, one to evict them into pending, one to age them past
// the lead, one to confirm the archive the delegate will read.
const parentEvent = () => ({ sessionID: "parent-1", system: [{ type: "text", text: "base" }], messages: [], tools: {}, model: {} })
const transcript2 = [
  ...transcript,
  user("u4", "New turn. ".repeat(20)),
  assistant("a5", "Done. ".repeat(20)),
  user("u5", "One more. ".repeat(20)),
  assistant("a6", "More. ".repeat(20)),
]

const transcript3 = [
  ...transcript,
  user("u4", "New turn. ".repeat(20)),
  assistant("a5", "Done. ".repeat(20)),
  user("u5", "One more. ".repeat(20)),
  assistant("a6", "More. ".repeat(20)),
  user("u6", "Another turn. ".repeat(20)),
  assistant("a7", "Ok. ".repeat(20)),
]

const parentGrow = [
  ...transcript3,
  user("u7", "One more. ".repeat(20)),
  assistant("a8", "More. ".repeat(20)),
]
const parentGrow2 = [
  ...parentGrow,
  user("u8", "Again. ".repeat(20)),
  assistant("a9", "Ok. ".repeat(20)),
]
// Append archives at a fold, not on a working-budget eviction. Seed the
// parent's archive directly so the delegated recall/expand path has one turn.
const hostParentStore = new SessionStore(host.ctx.storage)
const parentRecord = await hostParentStore.load("parent-1")
parentRecord.archive.push({
  id: "u4",
  gist: "New turn: the parent fixture's archived turn",
  chars: 2_000,
  createdAt: 0,
  messages: [
    user("u4", "New turn. ".repeat(20)),
    assistant("a5", "Done. ".repeat(20)),
  ],
})
await hostParentStore.save("parent-1", parentRecord)
const parentStats = (await tool.execute({ action: "stats" }, { ...callContext, sessionID: "parent-1" })).content[0].text
ok(/archive [1-9]/.test(parentStats), "the parent fixture owns archived turns")

outcome = await tool.execute({ action: "recall", query: "New turn", lost: true, from: "parent" }, childContext)
ok(outcome.content[0].text.includes("spawning session's archive"), "the host-wired tool delegates recall to the parent")
outcome = await tool.execute({ action: "expand", turn: "u4", from: "parent" }, childContext)
ok(outcome.content[0].text.includes("Done."), "the host-wired tool expands the parent's turn")
outcome = await tool.execute({ action: "archive", turn: "u4", gist: "moving in", from: "parent" }, childContext)
ok(outcome.content[0].text.includes("only recall and expand"), "the host-wired tool refuses a delegated write")
const fromSchema = tool.input?.properties?.from
ok(
  JSON.stringify(fromSchema?.enum) === '["parent"]' && /recall\/expand/.test(String(fromSchema?.description ?? "")),
  "the schema exposes from only as parent",
)

// ---------------------------------------------------------------------------
// Compaction and the command
// ---------------------------------------------------------------------------
const compaction = { sessionID: "s1", system: [], messages: [], tools: {} }
const compactionOutcome = await host.hooks.compaction(compaction)
ok(compactionOutcome?.owned === true, "compaction is owned when memory is non-empty")
ok(compaction.result.summary.includes("ship v0.1"), "compaction returns the memory document")
ok(!compaction.result.summary.includes("budget:"), "the compaction summary carries no live numbers either")

await host.commands[0].execute({ sessionID: "s1", prompt: { text: "/context" } })
const statsFirstLine = host.replies.at(-1).text.split("\n")[0]
ok(statsFirstLine.startsWith(`${PRODUCT_NAME} v`), "/context prints the status under the product name")
ok(
  /\d+\.\d+\.\d+ · memory /.test(statsFirstLine),
  "/context status shows the build's version ahead of the budgets",
)
await host.commands[0].execute({ sessionID: "s1", prompt: { text: "/context memory goal" } })
ok(host.replies.at(-1).text.includes("ship v0.1"), "/context memory reads one key")

const repliesBeforeResume = host.replies.length
const syntheticsBeforeResume = host.synthetics.length
await host.commands[0].execute({ sessionID: "s1", prompt: { text: "/context resume" } })
ok(
  host.synthetics.length === syntheticsBeforeResume + 1,
  "/context resume admits exactly one synthetic input",
)
ok(
  host.synthetics.at(-1).text === RESUMED_TEXT && host.synthetics.at(-1).resume === true,
  "/context resume asks the host to schedule a turn",
)
ok(host.replies.length === repliesBeforeResume, "/context resume sends no user message")
await host.commands[0].execute({ sessionID: "s1", prompt: { text: "/context nope" } })
ok(host.replies.at(-1).text.includes("resume"), "the usage lists resume")

const noSynthetic = []
await runContextCommand("s1", "resume", {
  store: new SessionStore(),
  config: resolveConfig({ options: {} }),
  reply: async (sessionID, text) => {
    noSynthetic.push({ sessionID, text })
  },
})
ok(
  noSynthetic.length === 1 && /synthetic channel/.test(noSynthetic[0].text),
  "a host without a synthetic channel answers instead of resuming",
)

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

// ---------------------------------------------------------------------------
// The update check: pure arithmetic, then the TUI half over a fake context
// ---------------------------------------------------------------------------
ok(compareVersions("0.1.9", "0.1.10") < 0, "versions compare per segment, not as text")
ok(compareVersions("0.1.21", "0.1.21") === 0, "equal versions compare equal")
ok(compareVersions("1.0.0", "0.9.9") > 0, "the major segment decides first")
ok(compareVersions("v0.2", "0.1.9") > 0, "a leading v and a missing patch are tolerated")
ok(updateAvailable("0.1.21", "0.1.22"), "a newer published version is available")
ok(!updateAvailable("0.1.22", "0.1.22"), "the same version is not an update")
ok(!updateAvailable("0.2.0", "0.1.99"), "a regression is not an update")
ok(!updateAvailable("0.1.21", "not-a-version"), "a malformed manifest never looks newer")
ok(dueForCheck(0, 1_000_000), "a check that never ran is due")
ok(!dueForCheck(1_000_000, 1_000_000), "a check just made is not due")
ok(dueForCheck(1_000_000, 1_000_000 + CHECK_INTERVAL_MS), "a check is due after the interval")
ok(
  !dueForCheck(1_000_000, 1_000_000 + CHECK_INTERVAL_MS - 1),
  "the interval is not shortened by a millisecond",
)
ok(CHECK_INTERVAL_MS === 24 * 60 * 60 * 1000, "the check is daily")
ok(parseManifestVersion('{"version":"0.1.23"}') === "0.1.23", "the manifest's version is read")
ok(parseManifestVersion("not json") === undefined, "a non-JSON body has no version")
ok(parseManifestVersion('{"version":23}') === undefined, "a non-string version is ignored")
ok(announceVersion("0.1.21", "0.1.22", "") === "0.1.22", "a newer version is announced once")
ok(
  announceVersion("0.1.21", "0.1.22", "0.1.22") === undefined,
  "an already announced version stays quiet",
)
ok(announceVersion("0.1.21", "0.1.21", "") === undefined, "up-to-date is silent")
ok(announceVersion(undefined, "0.1.22", "") === undefined, "an unknown installed version is silent")
ok(
  updateMessage("0.1.21", "0.1.22").includes("0.1.22") &&
    updateMessage("0.1.21", "0.1.22").includes("0.1.21") &&
    updateMessage("0.1.21", "0.1.22").includes("npm run plugin:install"),
  "the toast names both versions and the update step",
)

/** A TUI context just real enough for `tui.ts`: no renderer, no host. */
function makeTui(options, state, scene = {}) {
  const toasts = []
  const seen = {
    fetches: 0,
    listeners: 0,
    commands: [],
    dialogs: [],
    synthetic: [],
    purges: [],
    notices: [],
    profiles: [],
    stats: 0,
    rpcDefinition: undefined,
    rpcCalls: [],
    slots: [],
    released: [],
    memory: 0,
  }
  const answers = [...(scene.answers ?? [])]
  const memoryStores = new Map()
  const context = {
    options,
    location: "location" in scene ? scene.location : { directory: "C:\\work\\acme" },
    storage: {
      store: () => [
        state,
        async (mutation) => {
          mutation(state)
        },
      ],
      ...(scene.withSlots
        ? {
            memory: (key, { initial }) => {
              seen.memory += 1
              if (!memoryStores.has(key)) memoryStores.set(key, structuredClone(initial))
              const held = memoryStores.get(key)
              return [held, (mutation) => mutation(held)]
            },
          }
        : {}),
    },
    theme: {
      text: { base: "#ffffff", muted: "#888888", feedback: { error: { base: "#ff0000" }, warning: { base: "#ffaa00" } } },
    },
    client: {
      rpc: (definition) => {
        seen.rpcDefinition = definition
        return {
          stats: async (input, options) => {
            seen.stats += 1
            seen.rpcCalls.push({ method: "stats", options })
            if (scene.statsError !== undefined) throw new Error(scene.statsError)
            return scene.reply
          },
          purge: async (input, options) => {
            seen.purges.push(input)
            seen.rpcCalls.push({ method: "purge", options })
            return scene.purgeReply ?? { ok: true, text: `purged ${input.turn}` }
          },
          notice: async (input, options) => {
            seen.notices.push(input)
            seen.rpcCalls.push({ method: "notice", options })
            return scene.noticeReply ?? { ok: true, text: `retired ${input.id}` }
          },
          profile: async (input, options) => {
            seen.profiles.push(input)
            seen.rpcCalls.push({ method: "profile", options })
            return (
              scene.profileReply ?? {
                ok: true,
                text: `profile ${input.mode === "profile" ? input.name : input.mode} (applies from the next pass)`,
              }
            )
          },
        }
      },
      session: {
        synthetic: async (input) => {
          seen.synthetic.push(input)
          return {}
        },
      },
    },
    keymap: {
      layer: (factory) => {
        seen.commands.push(...(factory().commands ?? []))
      },
    },
    ui: {
      toast: { show: (toast) => toasts.push(toast) },
      dialog: {
        alert: async (options) => {
          seen.dialogs.push({ kind: "alert", ...options })
        },
        confirm: async (options) => {
          seen.dialogs.push({ kind: "confirm", ...options })
          return scene.confirm ?? true
        },
        select: async (options) => {
          seen.dialogs.push({ kind: "select", ...options })
          return answers.shift()
        },
      },
      router: { current: () => scene.route ?? { type: "session", sessionID: "ses_tui" } },
      ...(scene.withSlots
        ? {
            slot: (claim) => {
              seen.slots.push(claim)
              return () => seen.released.push(claim)
            },
          }
        : {}),
    },
    data: {
      on: () => {
        seen.listeners += 1
        return () => {}
      },
    },
  }
  return { context, toasts, seen }
}

async function settle(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((done) => setTimeout(done, 5))
  }
  assert.ok(predicate(), "the update check did not settle")
}

const realFetch = globalThis.fetch
let published = "0.3.99"
let fetchCount = 0
globalThis.fetch = async () => {
  fetchCount += 1
  return new Response(JSON.stringify({ version: published }), { status: 200 })
}

const updateState = { checkedAt: 0, latest: "", notified: "" }
const tuiOne = makeTui({}, updateState)
const stopTui = await setupTui(tuiOne.context)
await settle(() => tuiOne.toasts.length === 1)
ok(tuiOne.toasts.length === 1, "the TUI half toasts once for a newer version")
ok(
  tuiOne.toasts[0].message.includes("0.3.99 is available"),
  "the toast names the published version",
)
ok(
  tuiOne.toasts[0].message.includes(readPluginVersion()),
  "the toast names the loaded version",
)
ok(updateState.notified === "0.3.99" && updateState.checkedAt > 0, "the check records what it said")
ok(tuiOne.seen.listeners === 1, "the check wakes on session.idle")

const fetchesAfterFirst = fetchCount
const tuiTwo = makeTui({}, updateState)
await setupTui(tuiTwo.context)
await new Promise((done) => setTimeout(done, 50))
ok(fetchCount === fetchesAfterFirst, "a second start inside 24h makes no request")
ok(tuiTwo.toasts.length === 0, "a second start inside 24h does not toast")

updateState.checkedAt = 0
const tuiThree = makeTui({}, updateState)
await setupTui(tuiThree.context)
await settle(() => fetchCount > fetchesAfterFirst)
await new Promise((done) => setTimeout(done, 50))
ok(tuiThree.toasts.length === 0, "a version already announced is not announced again")

const fetchesBeforeOptOut = fetchCount
const quietState = { checkedAt: 0, latest: "", notified: "" }
const tuiFour = makeTui({ updateCheck: false }, quietState)
await setupTui(tuiFour.context)
await new Promise((done) => setTimeout(done, 50))
ok(fetchCount === fetchesBeforeOptOut, "updateCheck:false performs no request")
ok(tuiFour.toasts.length === 0, "updateCheck:false says nothing")

// ---------------------------------------------------------------------------
// The status bridge and the TUI dialog it feeds
// ---------------------------------------------------------------------------

const statusConfig = resolveConfig({ options: { memoryTokens: 20_000, workingTokens: 20_000, defaultProfile: "" } })
const statusRecord = blankRecord()
statusRecord.memory.goal = "ship the status dialog"
statusRecord.pending = [
  { id: "msg_p", gist: "a pending\nturn", chars: 10, messages: [], createdAt: 2, age: 0 },
]
statusRecord.archive = [{ id: "msg_a", gist: "the archived turn", chars: 20, createdAt: 1 }]
statusRecord.lastReport = {
  workingTokens: 45_000,
  workingTurns: 3,
  droppedTurns: 41,
  hostSystemTokens: 4_200,
  hostSystemParts: 5,
}
// The clock is explicit so the freshness line is a pinned string, not a race.
const statusReply = statsOf(statusRecord, statusConfig, "0.1.99", statusRecord.updatedAt + 6 * 60_000)

ok(
  statusReply.version === "0.1.99" &&
    statusReply.pending[0].id === "msg_p" &&
    statusReply.archive[0].raw === false,
  "statsOf reports the record and whether each turn keeps its raw messages",
)
ok(
  statusReply.workingTokens === 45_000 && statusReply.overBudget === true,
  "statsOf carries the working share and the shared-pool over-cap flag",
)
ok(
  statusReply.memoryCap === statusConfig.memoryTokens && statusReply.workingCap === statusConfig.workingTokens,
  "statsOf reports the caps the server enforces",
)
ok(
  statsReplySchema["~standard"].validate(statusReply).issues === undefined,
  "the stats reply matches the schema the host validates",
)
ok(
  isStatsRequest({ sessionID: "s" }) && !isStatsRequest({ sessionID: "" }) && !isStatsRequest({}),
  "a stats request needs a non-empty session id",
)
ok(
  isPurgeRequest({ sessionID: "s", turn: "t" }) && !isPurgeRequest({ sessionID: "s" }),
  "a purge request needs a turn",
)
ok(
  STATUS_RPC.id === "mega-smart-context" &&
    Object.keys(STATUS_RPC.methods).sort().join(",") === "notice,profile,purge,stats",
  "both halves share one RPC id and four methods",
)
const quarterBar = statusBarParts(15_000, 20_000)
ok(
  quarterBar.filled.length === Math.round(STATUS_BAR_WIDTH * 0.75) &&
    quarterBar.filled.length + quarterBar.empty.length === STATUS_BAR_WIDTH &&
    quarterBar.empty === "░".repeat(STATUS_BAR_WIDTH - quarterBar.filled.length),
  "a bar fills to its ratio at the shared width",
)
ok(
  statusBar(25_000, 20_000) === "█".repeat(STATUS_BAR_WIDTH),
  "a bar over cap fills every cell",
)
ok(turnLabel("  line one\n\nline two  ") === "line one line two", "a gist label collapses to one line")
ok(
  turnLabel("x".repeat(100), 10).endsWith("…") && turnLabel("x".repeat(100), 10).length === 10,
  "a long gist label is cut with an ellipsis",
)

const statusRowsReply = statusRows(statusReply)
ok(
  statusRowsReply[0].title.startsWith("memory ") && statusRowsReply[1].title.startsWith("working "),
  "the status rows lead with the two budgets",
)
ok(
  statusRowsReply[1].title.includes("over cap") && statusRowsReply[1].description.includes("current turn"),
  "the working row explains the normal over-cap case",
)
ok(
  statusRowsReply[0].title.search(/[█░]/) === statusRowsReply[1].title.search(/[█░]/),
  "the dialog's two budget rows line their bars up",
)
ok(
  statusRowsReply.some((row) => row.value === RESUME_ACTION) &&
    statusRowsReply.some((row) => row.value === PURGE_ACTION && row.disabled !== true),
  "the dialog offers resume and purge",
)
ok(
  statusRows({ ...statusReply, pending: [], archive: [] }).find((row) => row.value === PURGE_ACTION).disabled === true,
  "purge is disabled when there is nothing to purge",
)
const noHostReply = statsOf(
  { ...statusRecord, lastReport: { workingTokens: 0, workingTurns: 0, droppedTurns: 0 } },
  statusConfig,
)
ok(
  noHostReply.hostSystemTokens === undefined &&
    statusRows(noHostReply).every((row) => !row.title.startsWith("host system")),
  "a host-system line drops out when the pass did not measure one",
)

// The sidebar renders the same reply as a short block. The block is pure data,
// so its shape is pinned here rather than in a host.
const sidebarBody = sidebarText(statusReply)
ok(
  sidebarBody.split("\n")[0] === "Mega Smart Context v0.1.99",
  "the sidebar names the build on its first line",
)
const sidebarHeader = sidebarLines(statusReply)[0]
ok(
  sidebarHeader.spread === true &&
    sidebarHeader.spans.length === 2 &&
    sidebarHeader.spans[0].text === PRODUCT_NAME &&
    sidebarHeader.spans[1].text === "v0.1.99" &&
    sidebarHeader.spans[0].tone === "title",
  "the sidebar header puts the version on a right edge the renderer spreads to",
)
ok(
  sidebarLines({ ...statusReply, version: undefined })[0].spread === undefined &&
    sidebarLines({ ...statusReply, version: undefined })[0].spans.length === 1,
  "a header with no version keeps one span and asks for no spread",
)
ok(
  sidebarBody.includes("mem ") && sidebarBody.includes("/ 20k"),
  "the sidebar draws the memory budget",
)
ok(
  sidebarBody.includes("win ") && sidebarBody.includes("*45k / 20k") && statusReply.overBudget,
  "the sidebar marks a working window that is over cap with a star in the gutter",
)
ok(
  sidebarBody.includes("3 kept · 41 dropped") && sidebarBody.includes("1 pending · 1 archive · 0 ref"),
  "the sidebar counts turns, pending, archive and refs",
)
ok(
  statusReply.updatedAt === statusRecord.updatedAt && statusReply.ageMs === 6 * 60_000,
  "a reply built with a clock carries the record's stamp and how old it is",
)
ok(
  statsOf(statusRecord, statusConfig).updatedAt === undefined &&
    !isStatsReply({ ...statusReply, ageMs: -1 }),
  "a reply built without a clock omits the age, and a negative age is refused",
)
ok(
  sidebarBody.includes("measured 6m ago") && !sidebarBody.includes("host ~"),
  "the sidebar says how old its numbers are instead of the host system size",
)
ok(
  !sidebarText(noHostReply).includes("measured "),
  "a reply with no clock draws no freshness line rather than a guessed one",
)
ok(
  ageLabel(0) === "just now" && ageLabel(4_999) === "just now" && ageLabel(42_000) === "42s ago",
  "a fresh reply reads 'just now' and seconds keep counting up",
)
ok(
  ageLabel(6 * 60_000) === "6m ago" &&
    ageLabel(3 * 3_600_000) === "3h ago" &&
    ageLabel(2 * 86_400_000) === "2d ago",
  "the age line moves from minutes to hours to days",
)
ok(
  !sidebarText({ ...statusReply, version: undefined }).includes(" v0.1.99"),
  "a reply without a version does not leave a dangling v",
)
const bars = statusBarParts(statusReply.workingTokens, statusReply.workingCap)
ok(
  bars.filled.length + bars.empty.length === STATUS_BAR_WIDTH &&
    bars.filled === "█".repeat(STATUS_BAR_WIDTH) &&
    bars.empty === "",
  "an over-cap bar fills every cell and never overflows the width",
)
const alertLines = sidebarLines(statusReply).filter((line) => line.spans.some((span) => span.tone === "alert"))
ok(
  alertLines.length === 1 &&
    alertLines[0].spans
      .map((span) => span.text)
      .join("")
      .includes("*45k / 20k"),
  "only the over-cap working line carries the alert tone",
)
const sidebarMeters = sidebarBody
  .split("\n")
  .filter((line) => line.startsWith("mem ") || line.startsWith("win "))
ok(
  sidebarMeters.length === 2 && sidebarMeters[0].indexOf("/") === sidebarMeters[1].indexOf("/"),
  "the two budget lines align their value, slash and cap",
)
const meterSidebar = sidebarLines(statusReply).filter(
  (line) => line.spans[0]?.text === "mem " || line.spans[0]?.text === "win ",
)
ok(
  meterSidebar.length === 2 && meterSidebar.every((line) => line.spread === true),
  "both budget lines ask the renderer to put their numbers on the right edge",
)
ok(
  meterSidebar.every((line) => line.spans[1].text.length + line.spans[2].text.length === STATUS_BAR_WIDTH),
  "each budget line draws the shared bar width",
)
ok(
  meterSidebar.every((line) => /\/ \d+k?$/.test(line.spans[line.spans.length - 1].text)),
  "the numbers are a budget line's last span, which is what the renderer pushes right",
)
ok(
  sidebarMeters.every((line) => /\/ \d+k?$/.test(line)),
  "the flat form of a budget line still ends with its cap",
)
const wideSidebar = sidebarText({
  ...statusReply,
  memoryTokens: 9_000,
  workingTokens: 121_000,
  workingCap: 40_000,
}).split("\n")
ok(
  wideSidebar[2].includes("   9k / 20k") &&
    wideSidebar[3].includes("*121k / 40k") &&
    wideSidebar[2].indexOf("/") === wideSidebar[3].indexOf("/"),
  "a shorter value is padded on the left so the digits stay right-aligned",
)
ok(
  sidebarLines({ ...noHostReply, overBudget: false }).every((line) =>
    line.spans.every((span) => span.tone !== "alert"),
  ),
  "a window inside its cap paints no alert tone",
)

// The panel is the full report: everything the sidebar leaves out, still built
// by a pure function so its shape does not need a host.
const panelRecord = {
  ...statusRecord,
  notices: [
    { id: "msg_n1", text: "<system-reminder>\nYou are in Plan mode. Do not edit.", at: 1 },
    { id: "msg_n2", text: "<system-reminder>\nYou are NO LONGER in Plan mode.", at: 2 },
  ],
  history: [{ workingTokens: 2_000 }, { workingTokens: 5_000 }, { workingTokens: 3_000 }],
  lastUndo: { turn: "msg_u", at: 3, memory: 2, turns: 1, dropped: 1, lost: 0 },
  undo: [{ turn: "msg_u" }],
}
const panelReply = statsOf(panelRecord, statusConfig, "0.1.99")
const panelBody = panelText(panelReply)

ok(
  panelReply.notices[0].id === "msg_n2" && panelReply.notices[0].live === true && panelReply.notices[1].live === false,
  "the panel lists the newest notice first and marks only it live",
)
ok(
  panelReply.history.join(",") === "2000,5000,3000" && panelReply.goal === "ship the status dialog",
  "statsOf carries the pass history and the goal into the panel's reply",
)
ok(
  statusReply.pending[0].chars === 10 && statusReply.pending[0].age === 0 && statusReply.archive[0].age === 0,
  "a turn reply carries its size and its eviction age",
)
ok(
  panelBody.includes("## Pending eviction (1)") &&
    panelBody.includes("a pending turn · 10 ch · gist + raw · msg_p [purge]") &&
    panelBody.includes("the archived turn · 20 ch · gist only · msg_a [purge]"),
  "the panel lists pending and archived turns with a purge action",
)
ok(
  panelBody.includes("## Pinned notices (2)") &&
    panelBody.includes("You are NO LONGER in Plan mode. · live") &&
    panelBody.includes("You are in Plan mode. Do not edit. · msg_n1 [retire]"),
  "only a superseded notice offers its retire action",
)
ok(
  panelBody.includes("## Budget") &&
    panelBody.includes("host system ~4.2k est (5 parts)") &&
    panelBody.includes("## Undo") &&
    panelBody.includes("last undo: before msg_u · 2 memory key(s), 1 turn(s) dropped") &&
    panelBody.includes("journal: 1 turn(s)"),
  "the panel reports the budgets, the host system size and the undo state",
)
const panelBudget = panelSections(panelReply)[0].rows
  .slice(0, 2)
  .map((row) => row.spans.map((span) => span.text).join(""))
ok(
  panelBudget[0].indexOf("/") === panelBudget[1].indexOf("/") &&
    panelBudget[1].includes("*45k / 20k") &&
    panelBudget[0].startsWith("mem "),
  "the panel's budget rows share the sidebar's alignment and over-cap star",
)
ok(
  panelBody.includes("passes ") && panelBody.includes("3 samples · peak 5k"),
  "the panel draws the pass sparkline with its peak",
)
ok(
  !panelBody.includes("measured ") &&
    panelText({ ...panelReply, ageMs: 10_000 }).indexOf("measured") === -1 &&
    panelText({ ...panelReply, ageMs: PANEL_MEASURED_STALE_MS + 60_000 }).includes("measured 2m ago"),
  "the panel says how old the record is only once a minute has passed without a write",
)
ok(
  !panelText({ ...panelReply, notices: [], history: [], lastUndo: undefined, undoTurns: 0 }).includes("[retire]") &&
    panelText({ ...panelReply, notices: [], history: [], lastUndo: undefined, undoTurns: 0 }).includes("none pinned"),
  "an empty panel says so instead of leaving blank sections",
)
const longArchive = statsOf(
  { ...statusRecord, archive: Array.from({ length: 20 }, (_, index) => ({ id: `msg_a${index}`, gist: `turn ${index}`, chars: 1, createdAt: index })) },
  statusConfig,
)
ok(
  panelText(longArchive).includes("msg_a19") && panelText(longArchive).includes("… 8 older"),
  "the archive lists the newest turns and collapses the rest behind a count",
)
ok(sparkline([]) === "", "an empty history draws no sparkline")
ok(sparkline([0, 5, 10]) === "▁▅█", "the sparkline scales its cells to the tallest sample")
ok(sparkline(Array.from({ length: 100 }, () => 1)).length === 40, "the sparkline keeps only its recent width")
ok(
  panelSections(panelReply).map((section) => section.title).join("|") ===
    "Budget|Window|Pending eviction (1)|Archive (1)|Pinned notices (2)|Undo",
  "the panel's sections have a fixed order",
)
ok(PANEL_NAME === "mega-smart-context" && PANEL_ACTION === "panel", "the panel has one open name and one dialog value")
ok(
  isNoticeRequest({ sessionID: "s", id: "n" }) && !isNoticeRequest({ sessionID: "s", id: "" }),
  "a retire request needs a notice id",
)
ok(
  noticeRequestSchema["~standard"].validate({ sessionID: "s", id: "n" }).issues === undefined,
  "the retire request matches the schema the host validates",
)

// The pull rule: one per window, one in flight, bounded store.
ok(
  snapshotStale(undefined, 0) === true &&
    snapshotStale({ reply: statusReply, at: 1_000 }, 1_100) === false &&
    snapshotStale({ reply: statusReply, at: 1_000 }, 1_000 + SIDEBAR_STALE_MS) === true,
  "a snapshot is stale only after the window, and always when absent",
)
ok(snapshotStale({ reply: statusReply, at: Number.NaN }, 5) === true, "a snapshot without a time is stale")

let pullNow = 1_000
const pullStore = { sessions: {} }
let pullCalls = 0
const pull = sidebarRefreshOf({
  rpc: () => ({
    stats: async ({ sessionID }) => {
      pullCalls += 1
      return { ...statusReply, version: sessionID }
    },
    purge: async () => ({ ok: true, text: "" }),
  }),
  store: () => pullStore,
  mutate: (mutation) => {
    mutation(pullStore)
  },
  now: () => pullNow,
})
await pull("ses_one")
ok(pullCalls === 1 && pullStore.sessions.ses_one.reply.version === "ses_one", "the sidebar pulls a session once")
await pull("ses_one")
ok(pullCalls === 1, "a second ask inside the window does not pull again")
pullNow += SIDEBAR_STALE_MS
await pull("ses_one")
ok(pullCalls === 2, "an ask after the window pulls again")
await pull("ses_one", true)
ok(pullCalls === 3, "a forced ask pulls even inside the window")
await Promise.all([pull("ses_two", true), pull("ses_two", true)])
ok(pullCalls === 4, "two asks at once share one pull")
ok(pullStore.sessions.ses_two.reply.version === "ses_two", "the pull writes the session it was asked about")

const noBridge = sidebarRefreshOf({ rpc: () => undefined, store: () => pullStore, mutate: () => {} })
await noBridge("ses_three", true)
ok(pullCalls === 4 && pullStore.sessions.ses_three === undefined, "a host without the bridge pulls nothing")

const failing = sidebarRefreshOf({
  rpc: () => ({
    stats: async () => {
      throw new Error("RPC is unavailable")
    },
    purge: async () => ({ ok: true, text: "" }),
  }),
  store: () => pullStore,
  mutate: (mutation) => {
    mutation(pullStore)
  },
})
await failing("ses_four", true)
ok(pullStore.sessions.ses_four === undefined, "a failed pull leaves the mirror alone")

const crowded = {}
for (let index = 0; index < MAX_SIDEBAR_SESSIONS + 3; index += 1) {
  crowded[`ses_${index}`] = { reply: statusReply, at: index }
}
const dropped = sessionsToDrop(crowded)
ok(
  dropped.length === 3 && dropped[0] === "ses_0" && dropped[2] === "ses_2",
  "the mirror drops the oldest pulls first",
)
ok(sessionsToDrop({ a: { reply: statusReply, at: 1 } }).length === 0, "a mirror inside the bound drops nothing")

// The host dispatches a plugin RPC by location (OpenCode 2.2.7+): a call that
// names none is `rpc.unavailable`, which the block reads as "no numbers yet".
// The binder must add the location to every method, not only stats.
const boundSeen = []
const plainClient = {
  stats: async (input, options) => {
    boundSeen.push(["stats", options])
    return statusReply
  },
  purge: async (input, options) => {
    boundSeen.push(["purge", options])
    return { ok: true, text: "" }
  },
  notice: async (input, options) => {
    boundSeen.push(["notice", options])
    return { ok: true, text: "" }
  },
  profile: async (input, options) => {
    boundSeen.push(["profile", options])
    return { ok: true, text: "" }
  },
}
const bound = bindLocation(plainClient, { directory: "C:\\work\\acme" })
await bound.stats({ sessionID: "s" })
await bound.purge({ sessionID: "s", turn: "t" })
await bound.notice({ sessionID: "s", id: "n" })
await bound.profile({ sessionID: "s", mode: "auto" })
ok(
  boundSeen.length === 4 &&
    boundSeen.every(([, options]) => options?.location?.directory === "C:\\work\\acme"),
  "the RPC binder names the terminal's location on every method",
)
ok(bindLocation(plainClient, undefined) === plainClient, "a host without a location keeps the raw client")

const statusScene = makeTui(
  { updateCheck: false },
  { checkedAt: 0, latest: "", notified: "" },
  { reply: statusReply, answers: [RESUME_ACTION] },
)
await setupTui(statusScene.context)
const statusCommand = statusScene.seen.commands.find((command) => command.id === "mega-smart-context.status")
ok(statusCommand !== undefined, "the status command is registered even with updateCheck:false")
ok(
  statusScene.seen.commands.some((command) => command.id === "mega-smart-context.panel"),
  "the panel command is registered alongside the dialog",
)
await statusCommand.run()
ok(statusScene.seen.rpcDefinition === STATUS_RPC, "the command builds its client from the shared definition")
ok(
  statusScene.seen.rpcCalls.length === 1 &&
    statusScene.seen.rpcCalls[0].method === "stats" &&
    statusScene.seen.rpcCalls[0].options?.location?.directory === "C:\\work\\acme",
  "the status dialog's RPC call carries the terminal's location",
)
const statusDialog = statusScene.seen.dialogs.find((dialog) => dialog.kind === "select")
ok(
  statusDialog !== undefined && statusDialog.title.includes("0.1.99") && statusDialog.options[0].disabled === true,
  "the dialog is titled with the version and opens on the status rows",
)
ok(
  statusScene.seen.synthetic.length === 1 && statusScene.seen.synthetic[0].resume === true,
  "resume sends a synthetic cue with no user message",
)
ok(
  statusScene.seen.synthetic[0].text === RESUMED_TEXT && statusScene.toasts.at(-1).message.includes("resumed"),
  "resume uses the same cue as /context and reports it",
)

const purgeScene = makeTui(
  { updateCheck: false },
  {},
  { reply: statusReply, answers: [PURGE_ACTION, "msg_p"] },
)
await setupTui(purgeScene.context)
await purgeScene.seen.commands.find((command) => command.id === "mega-smart-context.status").run()
ok(
  purgeScene.seen.dialogs.filter((dialog) => dialog.kind === "select").length === 2 &&
    purgeScene.seen.dialogs.at(-1).kind === "confirm",
  "purge asks which turn, then confirms before writing",
)
ok(
  purgeScene.seen.purges.length === 1 &&
    purgeScene.seen.purges[0].turn === "msg_p" &&
    purgeScene.toasts.at(-1).message === "purged msg_p",
  "purge sends the chosen turn and reports the reply",
)
ok(
  purgeScene.seen.rpcCalls.find((call) => call.method === "purge")?.options?.location?.directory ===
    "C:\\work\\acme",
  "a purge carries the terminal's location too",
)

const homeScene = makeTui({ updateCheck: false }, {}, { route: { type: "home" } })
await setupTui(homeScene.context)
await homeScene.seen.commands.find((command) => command.id === "mega-smart-context.status").run()
ok(
  homeScene.seen.dialogs[0].kind === "alert" && homeScene.seen.dialogs[0].message.includes("Open a session"),
  "outside a session the dialog says why it cannot read a record",
)
ok(homeScene.seen.stats === 0, "outside a session no RPC is attempted")

const errorScene = makeTui(
  { updateCheck: false },
  {},
  { reply: statusReply, statsError: "RPC is unavailable: mega-smart-context" },
)
await setupTui(errorScene.context)
await errorScene.seen.commands.find((command) => command.id === "mega-smart-context.status").run()
ok(
  errorScene.seen.dialogs[0].kind === "alert" && errorScene.seen.dialogs[0].message.includes("did not answer"),
  "an RPC failure becomes a dialog, not a crash",
)

// The sidebar half. Whether the JSX module loads depends on the runtime (Bun
// resolves `@opentui/solid` for the host, plain Node cannot parse this file at
// all), so the assertions are about the contract either way: a claim with one
// placement, a store only when the module loaded, and teardown that releases it.
const slotScene = makeTui({ updateCheck: false }, {}, { reply: statusReply, withSlots: true })
const stopSlots = await setupTui(slotScene.context)
ok(
  slotScene.seen.slots.length === 0 ||
    (slotScene.seen.slots[0].append === "sidebar.content" &&
      slotScene.seen.slots[0].prepend === undefined),
  "the sidebar appends to sidebar.content when the TUI can render it, and claims nothing when it cannot",
)
ok(
  slotScene.seen.slots.length > 0 || slotScene.seen.memory === 0,
  "a sidebar that cannot render leaves the ephemeral store unmade",
)
await slotScene.seen.commands.find((command) => command.id === "mega-smart-context.status").run()
ok(slotScene.seen.dialogs[0].kind === "select", "a host with slots still opens the status dialog")
ok(
  slotScene.seen.dialogs[0].options.some(
    (row) => typeof row.title === "string" && row.title.startsWith("sidebar:"),
  ) &&
    slotScene.seen.dialogs[0].options.some(
      (row) => typeof row.title === "string" && row.title.startsWith("panel:"),
    ),
  "the dialog says whether the sidebar draws and whether the panel can open",
)
stopSlots()
ok(slotScene.seen.released.length === slotScene.seen.slots.length, "teardown releases the claim it made")

// The block's header is bold so it sits alongside the host's own section
// headers; the numbers stay plain. `attributes` is a bitmask, and every other
// tone must leave it at zero rather than, say, half-bold.
ok(
  toneAttributes("title") === TextAttributes.BOLD && toneAttributes("muted") === TextAttributes.NONE,
  "only the title tone is bold",
)
ok(
  toneAttributes("value") === TextAttributes.NONE &&
    toneAttributes("meter") === TextAttributes.NONE &&
    toneAttributes("alert") === TextAttributes.NONE,
  "the sidebar's data tones are not bold",
)

const noSidebar = makeTui({ updateCheck: false, sidebar: false }, {}, { withSlots: true })
const stopNoSidebar = await setupTui(noSidebar.context)
ok(
  noSidebar.seen.slots.length === 0,
  "sidebar:false claims no sidebar slot (the panel would share the one mirror)",
)
stopNoSidebar()

// ---------------------------------------------------------------------------
// Profiles: one named bundle of per-session settings, chosen by a click or a model
// ---------------------------------------------------------------------------

const profileLayer = {
  profiles: {
    lean: { memoryTokens: 5_000, workingTokens: 1_200, maxResultChars: 900 },
    deep: {
      memoryTokens: 60_000,
      workingTokens: 60_000,
      charsPerToken: 9,
      refs: false,
    },
  },
  modelProfiles: {
    "opencode/deepseek#fast": "lean",
    "opencode/deepseek": "lean",
    deepseek: "lean",
    "gpt-5": "deep",
  },
  defaultProfile: "lean",
}
const profileConfig = resolveConfig({ user: profileLayer })
ok(
  profileNames(profileConfig).join(",") === "deep,lean" &&
    profileConfig.profiles.lean.memoryTokens === 5_000 &&
    profileConfig.profiles.deep.workingTokens === 60_000,
  "a profile parses and keeps its name",
)
ok(
  profileConfig.profiles.deep.workingTokens === 60_000 &&
    profileConfig.profiles.deep.charsPerToken === 8 &&
    profileConfig.profiles.lean.workingTokens === 1_200,
  "a profile's numbers are clamped by the same rules as the top-level keys",
)
ok(
  SESSION_KEYS.includes("maxResultChars") && !SESSION_KEYS.includes("sidebar") && !SESSION_KEYS.includes("enabled"),
  "only the per-session keys are profile-able",
)
const mergedProfiles = resolveConfig({
  package: { profiles: { lean: { workingTokens: 1_000 } } },
  user: { profiles: { deep: { workingTokens: 2_000 } }, modelProfiles: { "a/b": "deep" } },
})
ok(
  profileNames(mergedProfiles).join(",") === "deep,lean" && mergedProfiles.modelProfiles["a/b"] === "deep",
  "profiles and model mappings merge across config layers by name",
)
assert.throws(
  () => resolveConfig({ user: { profiles: { lean: { sidebar: false } } } }),
  /unknown key "sidebar" in profile "lean"/,
  "a profile may not set a process key",
)
passed += 1
assert.throws(
  () => resolveConfig({ user: { profiles: { lean: { memoryTokens: "big" } } } }),
  /memoryTokens in profile "lean"/,
  "a profile's value has to have the right type",
)
passed += 1
assert.throws(
  () => resolveConfig({ user: { profiles: { "bad name": {} } } }),
  /profile name/,
  "a profile name has to be usable as a dialog row",
)
passed += 1
assert.throws(
  () => resolveConfig({ user: { modelProfiles: { "a/b": "nope" } } }),
  /names profile "nope", which is not defined/,
  "a model mapping may not name a profile that does not exist",
)
passed += 1
assert.throws(
  () => resolveConfig({ user: { defaultProfile: "nope" } }),
  /defaultProfile names profile "nope"/,
  "the default profile may not be missing either",
)
passed += 1
assert.throws(
  () => resolveConfig({ user: { modelProfiles: { "a/b": 7 } } }),
  /must name a profile/,
  "a model mapping's value is a profile name",
)
passed += 1

const fastStamp = stampModel({ providerID: "opencode", id: "deepseek", variant: "fast" })
ok(
  fastStamp?.id === "deepseek" && fastStamp.providerID === "opencode" && fastStamp.variant === "fast",
  "a model stamp reads the host's model reference",
)
ok(
  stampModel("opencode/deepseek") === undefined && stampModel({ providerID: "x" }) === undefined,
  "a stamp without an id is no stamp",
)
ok(
  modelKeys(fastStamp).join("|") === "opencode/deepseek#fast|opencode/deepseek|deepseek#fast|deepseek",
  "the model keys go from most to least specific",
)
ok(
  modelLabel(fastStamp) === "opencode/deepseek#fast" &&
    modelLabel({ providerID: "", id: "local" }) === "local",
  "a model label is provider/id plus the variant",
)

const leanModel = { providerID: "opencode", id: "deepseek" }
ok(
  choiceLabel(chooseProfile(profileConfig, undefined, leanModel)) === "lean · auto",
  "a model mapping chooses a profile automatically",
)
ok(
  chooseProfile(profileConfig, { mode: "profile", name: "deep", at: 1 }, leanModel).name === "deep" &&
    chooseProfile(profileConfig, { mode: "profile", name: "deep", at: 1 }, leanModel).source === "pin",
  "a manual pin wins over the model mapping",
)
ok(
  choiceLabel(chooseProfile(profileConfig, { mode: "base", at: 1 }, leanModel)) === "base · pinned",
  "a base pin runs the plain config even when the model maps to a profile",
)
ok(
  choiceLabel(chooseProfile(profileConfig, undefined, { providerID: "p", id: "unknown" })) === "lean · default",
  "the default profile answers when no model mapping matches",
)
ok(
  choiceLabel(chooseProfile(resolveConfig({}), undefined, undefined)) === "deep · default",
  "the shipped deep profile answers when no model mapping matches",
)
ok(
  choiceLabel(chooseProfile(resolveConfig({ user: { defaultProfile: "" } }), undefined, undefined)) === "base",
  "clearing defaultProfile runs the base config",
)
const orphanPin = chooseProfile(
  resolveConfig({ user: { profiles: { deep: {} } } }),
  { mode: "profile", name: "lean", at: 1 },
  undefined,
)
ok(
  orphanPin.name === undefined && choiceLabel(orphanPin) === "base · lean is not configured",
  "a pin that outlived its profile falls back to base and says which name is missing",
)
const leanEffective = applyProfile(profileConfig, chooseProfile(profileConfig, undefined, leanModel))
ok(
  leanEffective.memoryTokens === 5_000 &&
    leanEffective.workingTokens === 1_200 &&
    leanEffective.maxResultChars === 900 &&
    leanEffective.sidebar === profileConfig.sidebar &&
    leanEffective.enabled === profileConfig.enabled,
  "a profile merges its session keys and leaves the install keys alone",
)
ok(
  profileSummary(profileConfig, "lean") === "memory 5k · working 1.2k · results 900" &&
    profileSummary(profileConfig, "missing") === "not configured",
  "a profile summary lists exactly the keys it sets, in a fixed order",
)

// A pass runs on the profile's numbers, not the base ones, and stamps the model
// so the tool, /context and the RPC can re-derive the same automatic choice.
const profileStore = new SessionStore()
const profileDeps = { store: profileStore, config: profileConfig, now: () => 10 }
const wideMessages = [user("pu1", "one"), user("pu2", "x".repeat(20_000)), user("pu3", "three")]
const basePlan = await buildPayload(
  { sessionID: "prof", system: [], messages: wideMessages, model: { providerID: "opencode", id: "deepseek" } },
  { store: new SessionStore(), config: resolveConfig({}), now: () => 10 },
)
const profilePlan = await buildPayload(
  { sessionID: "prof", system: [], messages: wideMessages, model: { providerID: "opencode", id: "deepseek" } },
  profileDeps,
)
const profRecord = await profileStore.load("prof")
ok(
  basePlan.report.workingTurns === 3 && profilePlan.report.workingTurns === 1,
  "a mapped profile's working cap decides the window, not the base cap",
)
ok(
  profRecord.lastModel?.providerID === "opencode" && profRecord.lastModel.id === "deepseek",
  "the pass stamps the model it ran with",
)
ok(
  profileConfig.profiles.lean.memoryTokens === 5_000 &&
    profilePlan.report.memoryTokens < 5_000 &&
    profRecord.lastReport.overBudget === false,
  "the pass measures against the profile's caps",
)
await profileStore.mutate("prof", (record) => {
  record.profile = { mode: "profile", name: "deep", at: 5 }
})
const pinnedPlan = await buildPayload(
  { sessionID: "prof", system: [], messages: wideMessages, model: { providerID: "other", id: "m" } },
  profileDeps,
)
const pinnedRecord = await profileStore.load("prof")
ok(
  pinnedPlan.report.workingTurns === profilePlan.report.workingTurns && pinnedRecord.profile?.name === "deep",
  "a pin survives a model change and keeps the append era stable",
)
const autoChoiceRecord = { ...blankRecord(), lastModel: { providerID: "opencode", id: "deepseek" } }
ok(
  configForRecord(profileConfig, pinnedRecord).workingTokens === 60_000 &&
    configForRecord(profileConfig, autoChoiceRecord).workingTokens === 1_200,
  "configForRecord re-derives the profile from the record alone",
)

const profStats = statsOf(pinnedRecord, profileConfig)
ok(
  profStats.profile?.name === "deep" && profStats.profile.source === "pin" && profStats.workingCap === 60_000,
  "statsOf reports the profile and the caps it enforces",
)
ok(
  statsReplySchema["~standard"].validate(profStats).issues === undefined && isStatsReply(profStats),
  "a reply carrying a profile still matches the schema the host validates",
)
ok(
  renderStats(pinnedRecord, profileConfig, "0.2.0").includes("profile: deep · pinned · other/m"),
  "/context prints the profile, how it was chosen and the model",
)
ok(
  sidebarText(profStats).split("\n")[1] === "profile deep · pinned",
  "the sidebar says which profile the session runs on",
)
ok(
  panelText(profStats).includes("profile deep · pinned · model other/m"),
  "the panel says which profile and model are in force",
)
ok(
  statusRows(profStats).some((row) => row.value === PROFILE_ACTION) &&
    statusRows(profStats).some((row) => row.title === "profile deep · pinned"),
  "the dialog shows the profile and offers the switch",
)
ok(
  isProfileRequest({ sessionID: "s", mode: "profile", name: "deep" }) &&
    isProfileRequest({ sessionID: "s", mode: "auto" }) &&
    !isProfileRequest({ sessionID: "s", mode: "profile" }) &&
    !isProfileRequest({ sessionID: "s", mode: "nope" }),
  "a profile request needs a mode and, for a named pick, a name",
)
ok(
  profileRequestSchema["~standard"].validate({ sessionID: "s", mode: "base" }).issues === undefined,
  "the profile request matches the schema the host validates",
)

// /context profile is the no-TUI path: it reads the inventory and sets the pin.
const commandReplies = []
const commandStore = new SessionStore()
await commandStore.mutate("cmd", (record) => {
  record.lastModel = { providerID: "opencode", id: "deepseek" }
})
const commandDeps = {
  store: commandStore,
  config: profileConfig,
  reply: async (sessionID, text) => {
    commandReplies.push(text)
  },
  now: () => 99,
}
await runContextCommand("cmd", "profile", commandDeps)
ok(
  commandReplies.at(-1).includes("profile: lean · auto") &&
    commandReplies.at(-1).includes("deep ·") &&
    commandReplies.at(-1).includes("model mappings:"),
  "/context profile lists the choice, the profiles and the mappings",
)
await runContextCommand("cmd", "profile deep", commandDeps)
ok(
  (await commandStore.load("cmd")).profile?.name === "deep" &&
    commandReplies.at(-1).includes("profile deep · pinned"),
  "/context profile <name> pins the session",
)
await runContextCommand("cmd", "profile auto", commandDeps)
ok(
  (await commandStore.load("cmd")).profile === undefined && commandReplies.at(-1).includes("profile lean · auto"),
  "/context profile auto clears the pin and the model decides again",
)
await runContextCommand("cmd", "profile nope", commandDeps)
ok(commandReplies.at(-1).includes("unknown profile"), "an unknown profile is refused before any write")

// The RPC is the TUI's write path: same config, same refusal, same one-field pin.
const profileRpcHost = makeHost({ profiles: profileLayer.profiles, defaultProfile: "lean" })
await plugin.setup(profileRpcHost.ctx)
const profileHandler = profileRpcHost.rpcs[0].handlers.profile
const refusedProfile = await profileHandler({ sessionID: "s1", mode: "profile", name: "nope" })
ok(
  refusedProfile.ok === false && refusedProfile.text.includes("no profile"),
  "the RPC refuses a profile the config does not define",
)
const pinnedRpc = await profileHandler({ sessionID: "s1", mode: "profile", name: "lean" })
const rpcRecord = await new SessionStore(profileRpcHost.ctx.storage).load("s1")
ok(
  pinnedRpc.ok && rpcRecord.profile?.mode === "profile" && rpcRecord.profile.name === "lean",
  "the RPC pins the named profile on that one session",
)
const autoRpc = await profileHandler({ sessionID: "s1", mode: "auto" })
ok(
  autoRpc.ok && (await new SessionStore(profileRpcHost.ctx.storage).load("s1")).profile === undefined,
  "the RPC's auto clears the pin",
)

const profileReplyRecord = blankRecord()
profileReplyRecord.profile = { mode: "profile", name: "lean", at: 1 }
profileReplyRecord.lastModel = { providerID: "opencode", id: "deepseek" }
const profileScene = makeTui(
  {
    updateCheck: false,
    profiles: profileLayer.profiles,
    modelProfiles: profileLayer.modelProfiles,
    defaultProfile: "lean",
  },
  {},
  { reply: statsOf(profileReplyRecord, profileConfig), answers: [PROFILE_ACTION, "deep"] },
)
await setupTui(profileScene.context)
await profileScene.seen.commands.find((command) => command.id === "mega-smart-context.status").run()
const profilePicker = profileScene.seen.dialogs.filter((dialog) => dialog.kind === "select").at(-1)
ok(
  profilePicker.title === "Context profile" &&
    profilePicker.options.map((option) => option.value).join(",") === "auto,base,deep,lean",
  "the picker lists auto, base and every named profile",
)
ok(
  profilePicker.options[0].description.includes("follow the model") &&
    profilePicker.options[2].description === "memory 60k · working 60k · chars/token 8 · refs off",
  "auto explains itself and a row shows the profile's own overrides",
)
ok(
  profileScene.seen.profiles.length === 1 &&
    profileScene.seen.profiles[0].mode === "profile" &&
    profileScene.seen.profiles[0].name === "deep",
  "the picker's choice goes to the RPC as a named pin",
)
ok(
  profileScene.seen.rpcCalls.find((call) => call.method === "profile")?.options?.location?.directory ===
    "C:\\work\\acme",
  "a profile switch carries the terminal's location too",
)
ok(profileScene.toasts.at(-1).message.includes("profile deep"), "the switch is reported in a toast")

stopTui()
globalThis.fetch = realFetch

// ---------------------------------------------------------------------------
// Undo: the record follows a committed host revert
// ---------------------------------------------------------------------------

function blankRecord() {
  return {
    version: 1,
    memory: emptyMemory(),
    seenTurns: [],
    pending: [],
    archive: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

ok(
  revertTarget({ type: "session.revert.staged", data: { sessionID: "s", revert: { messageID: "u2" } } }) === undefined,
  "a staged revert is not applied: /redo can still cancel it",
)
ok(
  revertTarget({ type: "session.revert.committed", data: { sessionID: "s" } }) === undefined,
  "a committed event without a boundary is ignored",
)
const revert = revertTarget({ type: "session.revert.committed", data: { sessionID: "s", to: "u2" } })
ok(revert.sessionID === "s" && revert.to === "u2", "a committed revert names the session and the boundary")

const markRecord = blankRecord()
ok(queueRevert(markRecord, "u3", 1) && markRecord.revert.to === "u3", "a committed revert is queued on the record")
ok(!queueRevert(markRecord, "u4", 2) && markRecord.revert.to === "u3", "a later boundary does not widen an earlier one")
ok(queueRevert(markRecord, "u2", 3) && markRecord.revert.to === "u2", "an earlier boundary replaces a later one")

// The journal keeps the turn's starting value even after several writes.
const firstWrite = blankRecord()
firstWrite.seenTurns = ["u1"]
captureMemory(firstWrite, firstWrite.memory, ["goal"], 10)
firstWrite.memory.goal = "one"
captureMemory(firstWrite, firstWrite.memory, ["goal"], 11)
firstWrite.memory.goal = "two"
ok(firstWrite.undo.length === 1, "a turn writes one journal entry")
ok(firstWrite.undo[0].memory.goal === "", "a key written twice still rolls back to the turn's start")
applyRevert(firstWrite, { to: "u1", at: 20 }, 20)
ok(firstWrite.memory.goal === "", "the undo restores the captured value")

// Bounds.
const bounded = blankRecord()
for (let index = 0; index < MAX_UNDO_TURNS + 4; index += 1) {
  noteTurn(bounded, "t" + String(index).padStart(3, "0"), index)
}
ok(bounded.undo.length === MAX_UNDO_TURNS, "the journal keeps only the newest turns")
ok(bounded.undo[bounded.undo.length - 1].turn === "t011", "the newest turn is the one that survives")

const oversized = blankRecord()
const huge = emptyMemory()
huge.notes = "x".repeat(MAX_UNDO_CHARS)
captureMemory(oversized, huge, ["notes"], 1)
noteTurn(oversized, "a2", 2)
ok(oversized.undo.length === 1 && oversized.undo[0].turn === "a2", "the byte cap drops the oldest whole entry")

// A boundary newer than every journal entry keeps the entries: the turns before
// it are still reversible.
const pastJournal = blankRecord()
pastJournal.undo = [{ turn: "u1", at: 1 }, { turn: "u2", at: 2 }]
pastJournal.seenTurns = ["u1", "u2", "u3"]
applyRevert(pastJournal, { to: "u9", at: 5 }, 5)
ok(pastJournal.undo?.length === 2, "a boundary past the journal keeps every entry")
ok(pastJournal.seenTurns.join(",") === "u1,u2,u3", "and leaves turns older than the boundary alone")

// A turn the span auto-archived comes back to pending with its raw messages.
const archivedDuring = blankRecord()
archivedDuring.seenTurns = ["u1", "u2"]
archivedDuring.undo = [
  { turn: "u2", at: 1, pending: [{ id: "u1", gist: "g1", chars: 4, createdAt: 1, age: 1 }] },
]
archivedDuring.archive = [{ id: "u1", gist: "g1", chars: 4, messages: [user("u1", "one")], createdAt: 2 }]
const archivedUndo = applyRevert(archivedDuring, { to: "u2", at: 5 }, 5)
ok(archivedDuring.pending.length === 1 && archivedDuring.pending[0].id === "u1", "an auto-archived turn returns to pending")
ok(archivedDuring.pending[0].messages.length === 1, "its raw messages come out of the archive with it")
ok(archivedDuring.archive.length === 0, "the archive no longer holds the restored turn")
ok(archivedDuring.seenTurns.join(",") === "u1", "seenTurns drops the undone turn")
ok(archivedUndo.dropped === 0, "nothing is counted dropped when the turn was only moved")

// A pending turn that stayed pending still gets its snapshot age back.
const agedRecord = blankRecord()
agedRecord.seenTurns = ["u1", "u2"]
agedRecord.pending = [{ id: "u1", gist: "g1", chars: 1, messages: [user("u1", "one")], createdAt: 1, age: 5 }]
agedRecord.undo = [{ turn: "u2", at: 1, pending: [{ id: "u1", gist: "g1", chars: 1, createdAt: 1, age: 1 }] }]
applyRevert(agedRecord, { to: "u2", at: 9 }, 9)
ok(agedRecord.pending[0].age === 1, "a turn still pending gets its age back from the snapshot")

// A pending turn whose raw messages are gone is counted, not fabricated.
const lostRecord = blankRecord()
lostRecord.seenTurns = ["u1", "u2"]
lostRecord.undo = [{ turn: "u2", at: 1, pending: [{ id: "u1", gist: "g", chars: 1, createdAt: 1, age: 1 }] }]
const lostUndo = applyRevert(lostRecord, { to: "u2", at: 5 }, 5)
ok(lostUndo.lost === 1 && lostRecord.pending.length === 0, "a pending turn with no raw left is counted as lost")

// A purged turn is restored whole.
const purgedRecord = blankRecord()
purgedRecord.seenTurns = ["u2"]
purgedRecord.undo = [
  {
    turn: "u2",
    at: 1,
    purged: [{ list: "archive", index: 0, entry: { id: "u0", gist: "g", chars: 1, createdAt: 1 } }],
  },
]
applyRevert(purgedRecord, { to: "u2", at: 5 }, 5)
ok(purgedRecord.archive.length === 1 && purgedRecord.archive[0].id === "u0", "a purged turn is put back")

// A retired notice is pinned again, and its retirement is cleared.
const noticeRecord = blankRecord()
noticeRecord.seenTurns = ["u2"]
noticeRecord.notices = [{ id: "n1", text: "one", at: 1 }]
noticeRecord.retired = [{ id: "n2", text: "two" }]
noticeRecord.undo = [
  { turn: "u2", at: 1, notices: [{ notice: { id: "n2", text: "two", at: 2 }, index: 1 }] },
]
applyRevert(noticeRecord, { to: "u2", at: 5 }, 5)
ok(noticeRecord.notices.map((entry) => entry.text).join(",") === "one,two", "a retired notice is pinned again")
ok((noticeRecord.retired ?? []).length === 0, "the retirement is cleared with it")

// End to end: a pass journals a turn, a patch fills it, a revert unwinds it.
const undoStore = new SessionStore()
const undoConfig = resolveConfig({
  options: { workingTokens: 4000, memoryTokens: 3000, charsPerToken: 2, defaultProfile: "" },
})
const undoDeps = { store: undoStore, config: undoConfig, now: () => 1000 }
const undoPass = (messages) =>
  buildPayload({ sessionID: "undo", system: [], messages, model: {} }, undoDeps)
const undoTool = (input) => runMemoryTool({ sessionID: "undo", ...input }, undoDeps)
const turnOne = [user("u1", "First. ".repeat(20)), assistant("a1", "ok")]
const turnTwo = [...turnOne, user("u2", "Second. ".repeat(20)), assistant("a2", "ok")]
const turnThree = [...turnTwo, user("u3", "Third. ".repeat(20)), assistant("a3", "ok")]

await undoPass(turnOne)
await undoTool({ action: "patch", patch: { goal: "one", facts: { a: "1" } } })
await undoPass(turnTwo)
await undoTool({ action: "patch", patch: { goal: "two", facts: { b: "2" } } })
await undoPass(turnThree)
await undoTool({ action: "patch", patch: { goal: "three" } })

let undoRecord = await undoStore.load("undo")
ok(undoRecord.undo.length === 3, "a pass journals each turn once")
ok(undoRecord.undo.map((entry) => entry.turn).join(",") === "u1,u2,u3", "the journal is in turn order")

await undoStore.mutate("undo", (record) => queueRevert(record, "u3", 5000))
const undoPayload = await undoPass(turnTwo)
undoRecord = await undoStore.load("undo")
ok(undoRecord.memory.goal === "two", "the undone turn's memory write is rolled back")
ok(undoRecord.memory.facts.b === "2", "a write from the turn before the boundary survives")
ok(undoRecord.seenTurns.join(",") === "u1,u2", "seenTurns drops the undone turn")
ok(undoRecord.revert === undefined, "the revert marker is cleared in the same pass")
ok(undoRecord.lastUndo.turn === "u3" && undoRecord.lastUndo.memory === 1, "lastUndo records what was restored")
const undoText = renderMemory(undoRecord)
ok(undoText.includes("## Undo") && undoText.includes("u3"), "the memory block tells the model about the undo")
const undoTail = undoPayload.messages[undoPayload.messages.length - 1].content[0].text
ok(
  undoTail.includes("undo: the host reverted"),
  "the pass that applies the undo renders it immediately in the tail state note",
)
ok(renderStats(undoRecord, undoConfig).includes("last undo"), "/context reports the last undo")

const turnFour = [...turnTwo, user("u4", "Fourth. ".repeat(20)), assistant("a4", "ok")]
await undoPass(turnFour)
undoRecord = await undoStore.load("undo")
ok(undoRecord.lastUndo === undefined, "a later user turn drops the undo line")
ok(!renderMemory(undoRecord).includes("## Undo"), "and the memory block stops carrying it")

// Two undos in a row: the second boundary still restores the earlier turn.
await undoStore.mutate("undo", (record) => queueRevert(record, "u1", 6000))
await undoPass([])
undoRecord = await undoStore.load("undo")
ok(undoRecord.memory.goal === "", "a revert to the first turn restores the empty goal")
ok(Object.keys(undoRecord.memory.facts).length === 0, "and the facts written after it are gone")
ok(undoRecord.undo === undefined, "the journal is emptied when the first turn is reverted")

// The event subscription is what queues a committed revert.
const eventHost = makeHost()
const fed = [
  { type: "session.revert.staged", data: { sessionID: "ev-staged", revert: { messageID: "u2" } } },
  {
    type: "session.revert.committed",
    data: { sessionID: "ev-other", to: "u2" },
    location: { directory: "C:/somewhere/else" },
  },
  { type: "session.revert.committed", data: { sessionID: "ev-ok", to: "u2" }, location: { directory: root } },
  { type: "session.revert.committed", data: { sessionID: "ev-last", to: "u5" } },
]
eventHost.ctx.event = {
  subscribe({ signal } = {}) {
    return (async function* () {
      for (const event of fed) {
        if (signal?.aborted) return
        yield event
      }
    })()
  },
}
const disposeEvents = await plugin.setup(eventHost.ctx)
await new Promise((done) => setTimeout(done, 50))
ok(eventHost.storage.get("session/ev-ok")?.revert?.to === "u2", "a committed revert is queued on its record")
ok(eventHost.storage.get("session/ev-staged") === undefined, "a staged revert queues nothing")
ok(eventHost.storage.get("session/ev-other") === undefined, "an event from another directory is ignored")
ok(eventHost.storage.get("session/ev-last")?.revert?.to === "u5", "an event without a location is accepted")
await disposeEvents()

// The RPC handlers the TUI calls, driven directly. The host's routing is the
// only link this does not cover; the live check calls /api/rpc/<id>/<method>.
const rpcHost = makeHost()
const disposeRpc = await plugin.setup(rpcHost.ctx)
const statusRpc = rpcHost.rpcs[0]
const rpcSeeded = blankRecord()
rpcSeeded.pending = [
  { id: "msg_p", gist: "a pending turn", chars: 10, messages: [], createdAt: 2, age: 0 },
]
await rpcHost.storage.set("session/s-rpc", rpcSeeded)
const rpcStats = await statusRpc.handlers.stats({ sessionID: "s-rpc" })
ok(
  rpcStats.pending.length === 1 && rpcStats.pending[0].id === "msg_p",
  "the RPC reads the record the server half owns",
)
ok(isStatsReply(rpcStats), "the RPC reply is the shape the dialog renders")
const rpcPurged = await statusRpc.handlers.purge({ sessionID: "s-rpc", turn: "msg_p" })
ok(rpcPurged.ok === true && rpcPurged.text === "purged msg_p", "the RPC purges the named turn")
const rpcStored = await rpcHost.storage.get("session/s-rpc")
ok(
  rpcStored.pending.length === 0 &&
    (rpcStored.undo ?? []).some((entry) => (entry.purged ?? []).some((item) => item.entry.id === "msg_p")),
  "an RPC purge is journaled like the tool's",
)
const rpcMissing = await statusRpc.handlers.purge({ sessionID: "s-rpc", turn: "nope" })
ok(rpcMissing.ok === false && rpcMissing.text === "no turn nope", "the RPC reports a turn that is not there")
await disposeRpc()

// `/context purge` and the tool share purgeWithUndo, so the command's purge is
// journaled too (it was the known undo gap before the dialog needed it).
const purgeStore = new SessionStore()
const commandRecord = blankRecord()
commandRecord.archive = [{ id: "msg_c", gist: "context purge", chars: 5, createdAt: 1 }]
await purgeStore.save("s-cmd", commandRecord)
await runContextCommand("s-cmd", "purge msg_c", {
  store: purgeStore,
  config: statusConfig,
  reply: async () => {},
})
const afterCommand = await purgeStore.load("s-cmd")
ok(afterCommand.archive.length === 0, "/context purge removes the turn")
ok(
  (afterCommand.undo ?? []).some((entry) => (entry.purged ?? []).some((item) => item.entry.id === "msg_c")),
  "/context purge is journaled, so a later undo can restore it",
)

// ---------------------------------------------------------------------------
// Unit: the loop guard's config surface, state bounds and payload seam
// ---------------------------------------------------------------------------

const guardDefaults = resolveConfig({})
ok(
  guardDefaults.loopGuard === true &&
    guardDefaults.loopGuardMode === "default" &&
    guardDefaults.loopGuardNudges === 1 &&
    guardDefaults.loopGuardMinCalls === 20 &&
    guardDefaults.loopGuardEnvelope === true,
  "the loop guard defaults are on with one redirect and a 20-call envelope",
)
assert.throws(() => parseLayer({ loopGuardMode: "wild" }, "test"), /loopGuardMode/, "an unknown loop guard mode is refused")
passed += 1
ok(parseLayer({ loopGuardNudges: 9 }, "test").loopGuardNudges === 1, "the redirect budget clamps to one")
ok(parseLayer({ loopGuardMinCalls: 1 }, "test").loopGuardMinCalls === 4, "the loop guard envelope has a floor")

function repeatedGuardFailure(callPrefix, resultPrefix, command, count) {
  const messages = []
  for (let index = 0; index < count; index += 1) {
    messages.push(call(callPrefix + index, resultPrefix + index + "-call", "bash", { command }))
    messages.push(result(resultPrefix + index, resultPrefix + index + "-call", "bash", "Error: expected 2, got 3"))
  }
  return messages
}

const guardMessages = [user("gu1", "fix the failing test"), ...repeatedGuardFailure("ga", "gr", "npm test", 3)]
const guardSnapshot = JSON.stringify(guardMessages)
const guardStore = new SessionStore()
const guardDeps = { store: guardStore, config: resolveConfig({}) }
const guardPlan = await buildPayload(
  { sessionID: "loop-guard", system: [{ type: "text", text: "base" }], messages: guardMessages, model: {} },
  guardDeps,
)
const guardTail = guardPlan.messages[guardPlan.messages.length - 1].content[0].text
ok(guardTail.includes("process check:"), "a repeated call and error appends one redirect")
ok(guardTail.endsWith("</smart-context-state>"), "the redirect stays inside the trailing state note")
ok((guardTail.match(/process check:/g) ?? []).length === 1, "exactly one redirect line is rendered")
ok(JSON.stringify(guardMessages) === guardSnapshot, "the loop guard does not mutate the transcript")
const guardRecord = await guardStore.load("loop-guard")
ok(
  guardRecord.guard?.redirected === true && guardRecord.guard?.redirectReason === "repeat",
  "the redirect and its reason are stored on the session record",
)

const guardLonger = [
  ...guardMessages,
  call("ga3", "gr3-call", "bash", { command: "npm test" }),
  result("gr3", "gr3-call", "bash", "Error: expected 2, got 3"),
]
const guardPlanAgain = await buildPayload(
  { sessionID: "loop-guard", system: [{ type: "text", text: "base" }], messages: guardLonger, model: {} },
  guardDeps,
)
const guardTailAgain = guardPlanAgain.messages[guardPlanAgain.messages.length - 1].content[0].text
const guardLine = guardTailAgain.split("\n").find((line) => line.startsWith("process check:"))
ok(
  guardLine !== undefined && (guardTailAgain.match(/process check:/g) ?? []).length === 1,
  "a later call keeps exactly the one redirect",
)
ok(
  guardLine === guardTail.split("\n").find((line) => line.startsWith("process check:")),
  "the redirect text is stable across passes",
)

const guardOffPlan = await buildPayload(
  { sessionID: "loop-guard-off", system: [{ type: "text", text: "base" }], messages: guardMessages, model: {} },
  { store: new SessionStore(), config: resolveConfig({ options: { loopGuard: false } }) },
)
ok(
  JSON.stringify(guardPlan.system) === JSON.stringify(guardOffPlan.system) &&
    JSON.stringify(guardPlan.messages.slice(0, -1)) === JSON.stringify(guardOffPlan.messages.slice(0, -1)),
  "a redirect changes no byte before the trailing state note",
)
const guardOffTail = guardOffPlan.messages[guardOffPlan.messages.length - 1].content[0].text
const guardLineText = guardLine ?? ""
const maskedGuard = (guardLineText.length === 0 ? guardTail : guardTail.replace(guardLineText + "\n", "")).replace(/^pool:.*$/m, "pool: …")
const maskedOff = guardOffTail.replace(/^pool:.*$/m, "pool: …")
ok(maskedGuard === maskedOff, "the redirect is the only line the trailing note adds")

const greenMessages = [
  user("gg1", "fix the failing test"),
  ...repeatedGuardFailure("gga", "ggr", "npm test", 3),
  call("ggt", "ggt-call", "bash", { command: "npm test" }),
  result("ggtr", "ggt-call", "bash", "ok 12 tests passed"),
]
const greenStore = new SessionStore()
const greenPlan = await buildPayload(
  { sessionID: "loop-guard-green", system: [{ type: "text", text: "base" }], messages: greenMessages, model: {} },
  { store: greenStore, config: resolveConfig({}) },
)
const greenTail = greenPlan.messages[greenPlan.messages.length - 1].content[0].text
const greenRecord = await greenStore.load("loop-guard-green")
ok(!greenTail.includes("process check:"), "a green turn never redirects")
ok(
  greenRecord.guard !== undefined && loopGuardGreen(greenRecord.guard) && greenRecord.guard.redirected === false,
  "a green turn is recorded as green and unredirected",
)

const nextTurnMessages = [
  ...guardLonger,
  user("gu2", "a fresh request"),
  call("gn1", "gn1-call", "read", { path: "README.md" }),
  result("gnr1", "gn1-call", "read", "text"),
]
const nextTurnPlan = await buildPayload(
  { sessionID: "loop-guard", system: [{ type: "text", text: "base" }], messages: nextTurnMessages, model: {} },
  guardDeps,
)
const nextTurnTail = nextTurnPlan.messages[nextTurnPlan.messages.length - 1].content[0].text
const nextTurnRecord = await guardStore.load("loop-guard")
ok(!nextTurnTail.includes("process check:"), "a new user turn drops the old redirect")
ok(
  nextTurnRecord.guard?.turn === "gu2" &&
    nextTurnRecord.guard?.calls === 1 &&
    nextTurnRecord.guard?.failures === 0 &&
    nextTurnRecord.guard?.redirected === false,
  "a new user turn resets the guard's per-turn counters",
)

const oldTurnStore = new SessionStore()
const oldTurnPlan = await buildPayload(
  { sessionID: "loop-guard-old", system: [{ type: "text", text: "base" }], messages: nextTurnMessages, model: {} },
  { store: oldTurnStore, config: resolveConfig({}) },
)
const oldTurnTail = oldTurnPlan.messages[oldTurnPlan.messages.length - 1].content[0].text
ok(!oldTurnTail.includes("process check:"), "failures in an old completed turn never redirect a new turn")

const editMessages = [user("ge1", "change files")]
for (let index = 0; index < 8; index += 1) {
  editMessages.push(
    call("gea" + index, "gea" + index + "-call", "edit", {
      path: "src/file-" + index + ".ts",
      oldString: "a",
      newString: "b",
    }),
  )
  editMessages.push(result("ger" + index, "gea" + index + "-call", "edit", "Applied 1 edit"))
}
const editStore = new SessionStore()
const editPlan = await buildPayload(
  { sessionID: "loop-guard-edits", system: [{ type: "text", text: "base" }], messages: editMessages, model: {} },
  { store: editStore, config: resolveConfig({}) },
)
const editTail = editPlan.messages[editPlan.messages.length - 1].content[0].text
const editRecord = await editStore.load("loop-guard-edits")
ok(
  editTail.includes("process check:") && editRecord.guard?.redirectReason === "edits",
  "eight edits without a verification redirect",
)

const envelopeMessages = [user("gv1", "debug the failure")]
for (let index = 0; index < 20; index += 1) {
  envelopeMessages.push(
    call("gva" + index, "gva" + index + "-call", "bash", { command: "npm test -- --shard=" + index }),
  )
  envelopeMessages.push(result("gvr" + index, "gva" + index + "-call", "bash", "Error: boom"))
}
const envelopeStore = new SessionStore()
const envelopePlan = await buildPayload(
  { sessionID: "loop-guard-envelope", system: [{ type: "text", text: "base" }], messages: envelopeMessages, model: {} },
  { store: envelopeStore, config: resolveConfig({}) },
)
const envelopeTail = envelopePlan.messages[envelopePlan.messages.length - 1].content[0].text
const envelopeRecord = await envelopeStore.load("loop-guard-envelope")
ok(
  envelopeTail.includes("process check:") &&
    envelopeRecord.guard?.redirectReason === "envelope" &&
    envelopeRecord.guard?.calls === 20,
  "a turn past the envelope with a repeating failure redirects on the envelope",
)

const guardNormStore = new SessionStore(memoryStorage(new Map()))
const guardNormRecord = await guardNormStore.load("loop-guard-norm")
const manySigs = {}
const manyRepeats = {}
for (let index = 0; index < MAX_LOOP_GUARD_SIGNATURES + 5; index += 1) {
  manySigs["sig-" + index] = index + 1
  manyRepeats["key-" + index] = { count: 1, signature: "sig-" + index, label: "label-" + index }
}
guardNormRecord.guard = {
  turn: "u".repeat(500),
  calls: -1,
  failures: Number.NaN,
  edits: 2.8,
  verifications: 1,
  lastVerifyOk: true,
  errorSigs: manySigs,
  repeatKeys: manyRepeats,
  samples: Array.from({ length: 100 }, (_, index) => index + 1),
  redirected: true,
  redirectReason: "bogus",
  redirectText: "x".repeat(MAX_LOOP_GUARD_REDIRECT + 100),
}
await guardNormStore.save("loop-guard-norm", guardNormRecord)
const guardNorm = await guardNormStore.load("loop-guard-norm", { fresh: true })
ok(
  guardNorm.guard?.turn.length === 200 &&
    guardNorm.guard?.calls === 0 &&
    guardNorm.guard?.failures === 0 &&
    guardNorm.guard?.edits === 3 &&
    guardNorm.guard?.samples.length === MAX_LOOP_GUARD_SAMPLES &&
    Object.keys(guardNorm.guard?.errorSigs ?? {}).length === MAX_LOOP_GUARD_SIGNATURES &&
    Object.keys(guardNorm.guard?.repeatKeys ?? {}).length === MAX_LOOP_GUARD_SIGNATURES &&
    guardNorm.guard?.redirectReason === undefined &&
    guardNorm.guard?.redirectText?.length === MAX_LOOP_GUARD_REDIRECT,
  "a stored guard state is normalized and bounded on load",
)

// The run tool: the classifier and the learned clock are the shell slot contract.
const runQuick = classify("Write-Output hi", undefined)
ok(runQuick.kind === "quick", "a short command is classified quick")
ok(classify("npm run dev", undefined).kind === "service", "a dev server is classified service")
ok(classify("npm test", undefined).kind === "job", "a test run is classified job")
const runManifest = { services: [{ match: "start-api", ready: "listening" }] }
const runService = classify("start-api --port 3000", runManifest)
ok(runService.kind === "service", "a manifest service rule wins")
ok(runService.rule?.ready === "listening", "the ready pattern is carried")
ok(TimingStore.signature("npm test -- 123456") === "npm test -- #", "a volatile number collapses in a timing signature")
ok(TimingStore.project("C:\\Work\\App") === "c:/work/app", "the project key is normalized")
const runTimingsStore = new TimingStore()
await runTimingsStore.load()
ok(runTimingsStore.p90("__none__", "__none__") === undefined, "no sample means no learned deadline")
const runDefaultDeadline = runTimingsStore.deadline("__none__", "__none__", undefined)
ok(runDefaultDeadline >= 30_000 && runDefaultDeadline <= 30 * 60_000, "the default deadline is bounded")
ok(runTimingsStore.deadline("__none__", "__none__", 1_800_000) === 1_800_000, "a larger hint is honored up to the cap")
const runNpmVersion = resolveNpmScript(".", "npm run version:check")
ok(runNpmVersion?.command === "node scripts/version.mjs --check", "an npm run script resolves to its package command")
const runNpmStatus = resolveNpmScript(".", "npm run plugin:status")
ok(runNpmStatus?.command === "node scripts/install.ts --status", "the status script resolves to its package command")
ok(resolveNpmScript(".", "npm exec -- node -v") === undefined, "npm exec is not a package script")
ok(resolveNpmScript(".", "npm run __no_such_script__") === undefined, "an unknown script falls back to npm")
const runNpmDirect = runNpmVersion === undefined ? "" : npmScriptCommand(runNpmVersion)
ok(runNpmDirect.includes("npm_lifecycle_event = 'version:check'"), "the direct npm command carries the lifecycle event")
ok(runNpmDirect.includes("node_modules") && runNpmDirect.includes(".bin"), "the direct npm command puts node_modules/.bin on PATH")
ok(runNpmDirect.includes("try { node scripts/version.mjs --check } finally"), "the direct npm command restores the environment")
ok(hideConsoleWindow(true) === (process.platform === "win32" ? false : true), "a host console is shared on Windows")
ok(hideConsoleWindow(false) === true, "no host console keeps the child hidden")

await dispose()
console.log(`smoke: ${passed} assertions passed`)

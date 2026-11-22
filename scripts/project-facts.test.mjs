/**
 * Track B tests: project keys, the project store, the fact lifecycle, the
 * learner's extraction/redaction and the rendered block.
 *
 * Run from the repo root: node scripts/project-facts.test.mjs
 */
import assert from "node:assert/strict"

import {
  FIRE_MIN_N,
  GAMMA,
  K_PROMOTE,
  MAX_FACTS,
  MAX_RETIRED,
  MAX_TOKENS,
  RETENTION_MS,
  applyEvidence,
  createFact,
  describeFacts,
  emptyLifecycle,
  factId,
  firingRate,
  forgetFact,
  isInjectable,
  lifecycleScore,
  markInjected,
  normalizeFact,
  pruneFacts,
  recordEvidence,
  renderFacts,
  retireFact,
  unforgetFact,
} from "../src/core/facts.ts"
import {
  PROJECT_RECORD_VERSION,
  ProjectStore,
  emptyProjectRecord,
  emptyToolUsage,
  normalizeProjectRoot,
  normalizeProjectRecord,
  projectKeyFor,
} from "../src/core/project.ts"
import {
  commandForm,
  extractObservations,
  foldObservations,
  redactText,
  signatureOf,
  toolOf,
} from "../src/core/facts-learn.ts"

const PROJECT = projectKeyFor({ directory: "C:/repo" })
const NOW = 1_000_000

function empty() {
  return emptyProjectRecord(PROJECT, NOW)
}

function add(record, draft, session, step, extra = {}) {
  return applyEvidence(
    record,
    draft,
    {
      kind: "confirm",
      session,
      step,
      exercised: extra.exercised ?? true,
      fired: extra.fired ?? true,
      files: extra.files ?? [],
    },
    { now: NOW + step },
  )
}

function promote(record, draft, sessionPrefix = "s", count = K_PROMOTE) {
  let outcome
  for (let index = 0; index < count; index += 1) {
    outcome = add(record, draft, sessionPrefix + index, index + 1)
  }
  return outcome
}

function shellMessages(id, command, value) {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", id, name: "shell", input: { command } }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id,
          name: "shell",
          result: { type: "text", value },
        },
      ],
    },
  ]
}

function observationsFor(sessionID, command, value) {
  return extractObservations(shellMessages(sessionID + "-call", command, value), { sessionID })
}

class MemoryStorage {
  constructor() {
    this.map = new Map()
  }
  async get(key) {
    return this.map.get(key)
  }
  async set(key, value) {
    this.map.set(key, value)
  }
  async remove(key) {
    this.map.delete(key)
  }
}

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log("ok - " + name)
  } catch (error) {
    failed += 1
    console.error("not ok - " + name)
    console.error(error)
  }
}

// ---------------------------------------------------------------------------
// Project key
// ---------------------------------------------------------------------------

await test("project key normalizes drive case and separators", () => {
  const a = projectKeyFor({ directory: "C:\\Repo\\Packages\\App" })
  const b = projectKeyFor({ directory: "c:/repo/packages/app/" })
  assert.equal(a.key, "c:/repo/packages/app")
  assert.equal(a.key, b.key)
  assert.equal(a.hash, b.hash)
  assert.equal(a.storageKey, b.storageKey)
  assert.match(a.storageKey, /^project\/[0-9a-f]{64}$/u)
  assert.equal(normalizeProjectRoot("C:\\Repo\\..\\Other"), "c:/other")
  assert.equal(normalizeProjectRoot("//Server/Share/Repo"), "//server/share/repo")
})

await test("a worktree shares the git root key", () => {
  const worktree = projectKeyFor({
    directory: "C:/Repo/.worktrees/feature",
    gitRoot: "C:\\Repo",
  })
  const root = projectKeyFor({ directory: "C:/Repo" })
  assert.equal(worktree.key, root.key)
  assert.equal(worktree.hash, root.hash)
  assert.equal(worktree.source, "git")
  assert.equal(root.source, "directory")
  const other = projectKeyFor({ directory: "D:/Repo" })
  assert.notEqual(other.hash, root.hash)
})

// ---------------------------------------------------------------------------
// Project record and store
// ---------------------------------------------------------------------------

await test("the project record carries the documented JSON shape", () => {
  const record = empty()
  assert.deepEqual(Object.keys(record).sort(), [
    "candidates",
    "createdAt",
    "envelope",
    "facts",
    "key",
    "retired",
    "root",
    "toolUsage",
    "updatedAt",
    "version",
  ])
  assert.equal(record.version, PROJECT_RECORD_VERSION)
  assert.equal(record.key, "c:/repo")
  assert.deepEqual(record.facts, {})
  assert.deepEqual(record.envelope.seen, [])
})

await test("the store merges independent mutations", async () => {
  const storage = new MemoryStorage()
  let clock = 10_000
  const store = new ProjectStore(storage, { now: () => ++clock })
  await store.mutate(PROJECT, (record) => {
    record.toolUsage.shell = { ...emptyToolUsage(), calls: 2, ok: 1, failed: 1 }
  })
  await store.mutate(PROJECT, (record) => {
    record.envelope.sessions = 2
  })
  const loaded = await store.load(PROJECT, { fresh: true })
  assert.deepEqual(loaded.toolUsage.shell, { ...emptyToolUsage(), calls: 2, ok: 1, failed: 1 })
  assert.equal(loaded.envelope.sessions, 2)
})

await test("a stale save is refused and the stored record wins", async () => {
  const storage = new MemoryStorage()
  let clock = 20_000
  const a = new ProjectStore(storage, { now: () => ++clock })
  const b = new ProjectStore(storage, { now: () => ++clock })
  const base = await a.load(PROJECT)
  const stale = await b.load(PROJECT)
  base.envelope.step = 7
  assert.equal(await a.save(PROJECT, base), true)
  stale.envelope.step = 99
  assert.equal(await b.save(PROJECT, stale), false)
  const stored = await a.load(PROJECT, { fresh: true })
  assert.equal(stored.envelope.step, 7)
  assert.equal((await b.load(PROJECT)).envelope.step, 7)
})

await test("mutate retries once on a concurrent write", async () => {
  const storage = new MemoryStorage()
  let clock = 30_000
  const a = new ProjectStore(storage, { now: () => ++clock })
  const b = new ProjectStore(storage, { now: () => ++clock })
  const base = await b.load(PROJECT)
  base.envelope.sessions = 10
  await b.save(PROJECT, base)

  let raced = false
  const result = await b.mutate(PROJECT, async (record) => {
    if (!raced) {
      raced = true
      const other = await a.load(PROJECT, { fresh: true })
      other.envelope.sessions += 5
      assert.equal(await a.save(PROJECT, other), true)
    }
    record.envelope.sessions += 1
    return record.envelope.sessions
  })
  assert.equal(result, 16)
  const stored = await a.load(PROJECT, { fresh: true })
  assert.equal(stored.envelope.sessions, 16)
})

await test("normalizeProjectRecord drops malformed facts and keeps counts", () => {
  const record = normalizeProjectRecord(
    {
      version: 99,
      facts: { bad: { nope: true }, good: createFact({ family: "absent_tool", params: { tool: "x" } }, NOW) },
      candidates: {},
      retired: {},
      toolUsage: { shell: { ...emptyToolUsage(), calls: 3, ok: 2, failed: 1 } },
      envelope: { step: 4, sessions: 2, seen: ["a", "b"] },
      createdAt: 5,
      updatedAt: 6,
    },
    PROJECT,
    NOW,
  )
  assert.equal(record.version, PROJECT_RECORD_VERSION)
  assert.equal(Object.keys(record.facts).length, 1)
  assert.deepEqual(record.toolUsage.shell, { ...emptyToolUsage(), calls: 3, ok: 2, failed: 1 })
  assert.equal(record.envelope.step, 4)
  assert.deepEqual(record.envelope.seen, ["a", "b"])
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

await test("K=3 confirmations across separate sessions promote a candidate", () => {
  const record = empty()
  const draft = { family: "absent_tool", params: { tool: "mytool" }, high: true }
  const id = factId("absent_tool", { tool: "mytool" })

  add(record, draft, "s1", 1)
  add(record, draft, "s1", 2)
  assert.ok(record.candidates[id])
  assert.equal(record.candidates[id].lifecycle.confirms.length, 1, "same session counts once")
  assert.equal(record.facts[id], undefined)

  add(record, draft, "s2", 3)
  assert.equal(record.candidates[id].lifecycle.confirms.length, 2)
  add(record, draft, "s3", 4)
  assert.equal(record.facts[id].lifecycle.state, "ACTIVE")
  assert.equal(record.candidates[id], undefined)
  assert.equal(record.facts[id].lifecycle.confirms.length, 3)
})

await test("the fire gate holds an ACTIVE fact back until four exercises", () => {
  const record = empty()
  const draft = { family: "absent_tool", params: { tool: "gated" }, high: true }
  const id = factId("absent_tool", { tool: "gated" })
  for (let index = 0; index < K_PROMOTE; index += 1) {
    add(record, draft, "promote-" + index, index + 1, { exercised: false })
  }
  assert.equal(record.facts[id].lifecycle.state, "ACTIVE")
  assert.equal(isInjectable(record.facts[id].lifecycle), false)
  assert.equal(renderFacts(record).text, "")

  add(record, draft, "gate-1", 4)
  add(record, draft, "gate-2", 5, { fired: false })
  add(record, draft, "gate-3", 6, { fired: false })
  assert.equal(record.facts[id].lifecycle.fireDen, FIRE_MIN_N - 1)
  assert.equal(isInjectable(record.facts[id].lifecycle), false)

  add(record, draft, "gate-4", 7, { fired: false })
  assert.equal(record.facts[id].lifecycle.fireDen, FIRE_MIN_N)
  assert.equal(firingRate(record.facts[id].lifecycle), 0.25)
  assert.equal(isInjectable(record.facts[id].lifecycle), false)

  add(record, draft, "gate-5", 8)
  add(record, draft, "gate-6", 9)
  assert.ok(firingRate(record.facts[id].lifecycle) >= 0.4)
  assert.equal(isInjectable(record.facts[id].lifecycle), true)
  assert.ok(renderFacts(record).text.includes(id))
})

await test("recency decay lowers the score and a later contradiction retires a non-high fact", () => {
  const lifecycle = emptyLifecycle(false)
  recordEvidence(lifecycle, { kind: "confirm", session: "s1", step: 1, fired: true })
  recordEvidence(lifecycle, { kind: "confirm", session: "s2", step: 2, fired: true })
  recordEvidence(lifecycle, { kind: "confirm", session: "s3", step: 3, fired: true })
  const early = lifecycleScore(lifecycle, 3)
  const late = lifecycleScore(lifecycle, 20)
  assert.ok(late < early)
  assert.ok(late > 0)
  assert.equal(GAMMA, 0.8)

  const record = empty()
  const draft = { family: "empty_probe", params: { probe: "git remote" }, high: false }
  promote(record, draft)
  const fact = Object.values(record.facts)[0]
  assert.equal(fact.lifecycle.high, false)
  applyEvidence(
    record,
    draft,
    { kind: "contradict", session: "late", step: 100, exercised: true, fired: false },
    { now: NOW + 100 },
  )
  assert.ok(record.retired[fact.id])
  assert.equal(record.facts[fact.id], undefined)
})

await test("a high-stakes contradiction retires at once", () => {
  const record = empty()
  const draft = { family: "absent_tool", params: { tool: "gone" }, high: true }
  promote(record, draft)
  const id = factId("absent_tool", { tool: "gone" })
  assert.equal(record.facts[id].lifecycle.state, "ACTIVE")
  applyEvidence(
    record,
    draft,
    { kind: "contradict", session: "works-now", step: 10, exercised: true, fired: false },
    { now: NOW + 10 },
  )
  assert.equal(record.facts[id], undefined)
  assert.equal(record.retired[id].reason, "contradiction")
  assert.equal(renderFacts(record).text, "")
})

await test("forget hides a fact, blocks re-learning and unforget restores it", () => {
  const record = empty()
  const draft = { family: "absent_tool", params: { tool: "private-tool" }, high: true }
  promote(record, draft)
  const id = factId("absent_tool", { tool: "private-tool" })
  add(record, draft, "before-forget-gate", 4)
  assert.equal(renderFacts(record).ids.includes(id), true)

  assert.equal(forgetFact(record, id, NOW + 50), true)
  assert.equal(record.facts[id], undefined)
  assert.equal(record.retired[id].reason, "forgotten")
  assert.equal(renderFacts(record).text, "")

  const outcome = add(record, draft, "after-forget", 20)
  assert.equal(outcome.action, "skipped")
  assert.equal(record.facts[id], undefined)
  assert.equal(record.candidates[id], undefined)

  assert.equal(unforgetFact(record, id, NOW + 60), true)
  assert.ok(record.facts[id])
  assert.equal(renderFacts(record).ids.includes(id), true)
})

await test("stale candidates and an over-cap retired map are pruned", () => {
  const record = empty()
  add(record, { family: "absent_tool", params: { tool: "stale" } }, "old", 1)
  const stale = Object.values(record.candidates)[0]
  assert.ok(stale)
  assert.deepEqual(pruneFacts(record, NOW + RETENTION_MS + 2), { candidates: 1, retired: 0 })
  assert.equal(Object.keys(record.candidates).length, 0)

  for (let index = 0; index < MAX_RETIRED + 8; index += 1) {
    const fact = createFact({ family: "absent_tool", params: { tool: "retired-" + index } }, NOW + index)
    fact.lifecycle.state = "ACTIVE"
    record.facts[fact.id] = fact
    assert.equal(retireFact(record, fact.id, "contradiction", { now: NOW + index }), true)
  }
  assert.ok(Object.keys(record.retired).length > MAX_RETIRED)
  pruneFacts(record, NOW + 100)
  assert.equal(Object.keys(record.retired).length, MAX_RETIRED)
})

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

await test("render is stable across passes and insertion order", () => {
  const drafts = [
    { family: "absent_tool", params: { tool: "alpha" }, high: true },
    { family: "absent_tool", params: { tool: "beta" }, high: true },
  ]
  const first = empty()
  for (const draft of drafts) {
    promote(first, draft, draft.params.tool + "-")
    add(first, draft, draft.params.tool + "-gate", 4)
  }
  const second = empty()
  for (const draft of [...drafts].reverse()) {
    promote(second, draft, draft.params.tool + "-")
    add(second, draft, draft.params.tool + "-gate", 4)
  }
  const one = renderFacts(first)
  const again = renderFacts(first)
  const other = renderFacts(second)
  assert.equal(one.text, again.text)
  assert.equal(one.text, other.text)
  assert.equal(one.ids.length, 2)
  assert.ok(one.ids[0] < one.ids[1], "deterministic id order")
  assert.equal(markInjected(first, one.ids), 2)
  assert.equal(first.facts[one.ids[0]].injected, 1)
})

await test("the render cap is four facts and 150 estimated tokens, hard", () => {
  const record = empty()
  for (let index = 0; index < 8; index += 1) {
    const draft = { family: "absent_tool", params: { tool: "cap-tool-" + index }, high: true }
    for (let step = 0; step < 4; step += 1) {
      add(record, draft, "cap-" + index + "-" + step, step + 1)
    }
  }
  const rendered = renderFacts(record)
  assert.equal(rendered.ids.length, MAX_FACTS)
  assert.ok(rendered.tokens <= MAX_TOKENS)
  assert.ok(rendered.chars <= MAX_TOKENS * 4)
  assert.equal(rendered.text.split("\n").length, MAX_FACTS + 1)

  const long = empty()
  for (let index = 0; index < 3; index += 1) {
    const draft = {
      family: "form_repair",
      params: {
        failed: "first-command-" + "a".repeat(80) + "-" + index,
        worked: "second-command-" + "b".repeat(80) + "-" + index,
        error: "non-zero exit",
      },
      high: false,
    }
    for (let step = 0; step < 4; step += 1) {
      add(long, draft, "long-" + index + "-" + step, step + 1)
    }
  }
  const capped = renderFacts(long)
  assert.ok(capped.ids.length >= 1)
  assert.ok(capped.ids.length <= MAX_FACTS)
  assert.ok(capped.tokens <= MAX_TOKENS)
  assert.ok(capped.chars <= MAX_TOKENS * 4)
  const override = renderFacts(long, { maxFacts: 99, maxTokens: 999 })
  assert.ok(override.ids.length <= MAX_FACTS)
  assert.ok(override.tokens <= MAX_TOKENS)
})

await test("describeFacts reports evidence and injectability", () => {
  const record = empty()
  const draft = { family: "absent_tool", params: { tool: "describe-me" } }
  promote(record, draft)
  const rows = describeFacts(record)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].confirms, 3)
  assert.equal(rows[0].state, "ACTIVE")
  assert.equal(rows[0].fireDen, 3)
  assert.equal(rows[0].injectable, false)
})

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

await test("redaction removes secrets, credentials and home paths", () => {
  const raw = [
    "API_KEY=sk-abcdef1234567890",
    "password=hunter2",
    "https://user:pass@example.com/path?token=abcd1234",
    "C:\\Users\\mega\\project\\file.txt",
    "Authorization: Bearer abcdefghijklmnop",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  ].join(" ")
  const clean = redactText(raw)
  for (const secret of ["sk-abcdef", "hunter2", "user:pass", "abcd1234", "mega", "abcdefghijklmnop", "ghp_"]) {
    assert.equal(clean.includes(secret), false, "still contains " + secret)
  }
  assert.ok(clean.includes("<redacted>"))
  assert.ok(clean.includes("<home>"))
})

await test("extraction parses a signature but never stores raw output", () => {
  const observations = observationsFor("privacy", "deploy --token sk-abcdef1234567890", {
    output: "TOP-SECRET-OUTPUT-1234567890\ncommand not found: deploy",
    exitCode: 127,
  })
  assert.equal(observations.length, 1)
  assert.equal(observations[0].signature, "command not found")
  assert.equal(observations[0].ok, false)
  assert.equal(observations[0].exitCode, 127)
  assert.equal(JSON.stringify(observations).includes("TOP-SECRET"), false)
  assert.equal(observations[0].command.includes("sk-"), false)

  const record = empty()
  const result = foldObservations(record, observations, { sessionID: "privacy", turnID: "t1", now: NOW })
  assert.equal(result.factIds.length, 1)
  assert.equal(result.factIds[0], "absent_tool:deploy")
  const stored = JSON.stringify(record)
  assert.equal(stored.includes("TOP-SECRET"), false)
  assert.equal(stored.includes("sk-abcdef"), false)
  assert.equal(Object.values(record.candidates)[0].params.tool, "deploy")
})

// ---------------------------------------------------------------------------
// Observation folding
// ---------------------------------------------------------------------------

await test("a shell failure becomes a candidate and three sessions promote it", () => {
  const record = empty()
  let step = 0
  for (const session of ["one", "two", "three"]) {
    step += 1
    const observations = observationsFor(session, "mytool status", {
      output: "command not found: mytool",
      exitCode: 127,
    })
    foldObservations(record, observations, { sessionID: session, turnID: "t1", step, now: NOW + step })
  }
  const id = factId("absent_tool", { tool: "mytool" })
  assert.ok(record.facts[id])
  assert.equal(record.facts[id].lifecycle.confirms.length, 3)
  assert.equal(record.facts[id].lifecycle.fireDen, 3)
  assert.equal(renderFacts(record).text, "")

  foldObservations(
    record,
    observationsFor("four", "mytool status", { output: "command not found: mytool", exitCode: 127 }),
    { sessionID: "four", turnID: "t1", step: 4, now: NOW + 4 },
  )
  assert.equal(record.facts[id].lifecycle.fireDen, 4)
  assert.ok(renderFacts(record).text.includes(id))

  const before = JSON.stringify(record)
  const duplicate = foldObservations(
    record,
    observationsFor("four", "mytool status", { output: "command not found: mytool", exitCode: 127 }),
    { sessionID: "four", turnID: "t1", step: 5, now: NOW + 5 },
  )
  assert.equal(duplicate.duplicate, true)
  assert.equal(JSON.stringify(record), before)
})

await test("a working tool contradicts an absent-tool fact and retires it", () => {
  const record = empty()
  for (let step = 1; step <= 3; step += 1) {
    foldObservations(
      record,
      observationsFor("missing-" + step, "mytool status", { output: "command not found: mytool", exitCode: 127 }),
      { sessionID: "missing-" + step, turnID: "t1", step, now: NOW + step },
    )
  }
  const id = factId("absent_tool", { tool: "mytool" })
  assert.ok(record.facts[id])

  const result = foldObservations(
    record,
    observationsFor("working", "mytool status", { output: "ok", exitCode: 0 }),
    { sessionID: "working", turnID: "t1", step: 4, now: NOW + 4 },
  )
  assert.equal(result.retired, 1)
  assert.equal(record.facts[id], undefined)
  assert.equal(record.retired[id].reason, "contradiction")
})

await test("an empty git probe is a candidate; an empty echo is not", () => {
  const record = empty()
  foldObservations(
    record,
    observationsFor("probe", "git remote", { output: "", exitCode: 0 }),
    { sessionID: "probe", turnID: "t1", now: NOW },
  )
  const id = factId("empty_probe", { probe: "git remote" })
  assert.ok(record.candidates[id])

  const noise = empty()
  foldObservations(
    noise,
    observationsFor("noise", "echo -n", { output: "", exitCode: 0 }),
    { sessionID: "noise", turnID: "t1", now: NOW },
  )
  assert.equal(Object.keys(noise.candidates).length, 0)
})

await test("a later working form repairs the failed form", () => {
  const record = empty()
  const messages = [
    ...shellMessages("repair-1", "npm test", { output: "not found: vitest", exitCode: 1 }),
    ...shellMessages("repair-2", "npm test -- --run", { output: "ok", exitCode: 0 }),
  ]
  const observations = extractObservations(messages, { sessionID: "repair" })
  foldObservations(record, observations, { sessionID: "repair", turnID: "t1", now: NOW })
  const id = factId("form_repair", {
    failed: "npm test",
    worked: "npm test -- --run",
    error: "non-zero exit",
  })
  assert.ok(record.candidates[id], JSON.stringify(Object.keys(record.candidates)))
  assert.equal(record.candidates[id].params.failed, "npm test")
  assert.equal(record.candidates[id].params.worked, "npm test -- --run")
  assert.equal(commandForm("npm test -- --run"), commandForm("npm test"))
  assert.equal(toolOf("C:\\bin\\mytool.exe status"), "mytool.exe")
})

await test("facts folding leaves tool usage to the usage fold", () => {
  const record = empty()
  const observations = observationsFor("usage", "echo hi", { output: "hi", exitCode: 0 })
  foldObservations(record, observations, { sessionID: "usage", turnID: "t1", now: NOW })
  foldObservations(record, observations, { sessionID: "usage", turnID: "t1", now: NOW })
  assert.deepEqual(record.toolUsage, {})
})

await test("lifecycle normalization accepts a stored fact and rejects a malformed one", () => {
  const fact = createFact({ family: "absent_tool", params: { tool: "normalized" } }, NOW)
  const normalized = normalizeFact(fact)
  assert.ok(normalized)
  assert.equal(normalized.id, fact.id)
  assert.equal(normalizeFact({ id: "x", family: "nope" }), undefined)
  assert.equal(normalizeFact(null), undefined)
  assert.equal(signatureOf("bash: foo: not found"), "command not found")
})

console.log("\n" + passed + " passed, " + failed + " failed")
if (failed > 0) process.exit(1)

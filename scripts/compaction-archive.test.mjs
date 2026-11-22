/**
 * Pinning test: a host compaction must not lose the turns it replaces.
 *
 * The host's compaction seam hands the plugin the full pre-compaction
 * transcript and then replaces it with the summary the plugin returns. Owning
 * the summary without archiving first is a data-loss path: a planning turn that
 * was still in the working window would vanish without ever entering the cold
 * store, and `recall` could never find it.
 *
 * The test drives the real `runCompaction` against an in-memory `SessionStore`
 * and asserts the contract the adapter relies on:
 *
 * - every real turn is archived with its raw messages, mechanical gist and
 *   character count, and duplicates across runs are not appended twice;
 * - a turn already pending is not copied into the archive;
 * - the era fields are cleared and `seenTurns` is empty, so the next pass does
 *   not try to evict a transcript the host has already replaced;
 * - `hostCompact` records the append count and the archive size, including a
 *   zero-append second run;
 * - empty memory still preserves the turns but declines ownership, leaving the
 *   host's own summary in place;
 * - `archiveMaxTurns` and `archiveMaxChars` still bound the archive.
 *
 * Run with: node scripts/compaction-archive.test.mjs
 */

import test from "node:test"
import assert from "node:assert/strict"

import { charsOfMessages, mechanicalGist, turnMessages } from "../src/core/archive.ts"
import { runCompaction } from "../src/core/compaction.ts"
import { resolveConfig } from "../src/core/config.ts"
import { renderMemory } from "../src/core/prompts.ts"
import { SessionStore } from "../src/core/state.ts"
import { turnSpans } from "../src/core/view.ts"

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

const SESSION = "compaction-lossless"

const transcript = [
  user("u1", "Plan the lossless compaction seam before the host replaces the transcript."),
  assistant("a1", "I will archive the window first."),
  call("a2", "c1", "read", { path: "src/core/compaction.ts" }),
  result("r1", "c1", "read", "export async function runCompaction(event, deps) { … }"),
  user("u2", "Now make it lossless and keep both turns."),
  assistant("a3", "Archiving both turns before returning the summary."),
]

const config = resolveConfig({ options: {} })

async function seedMemory(store, sessionID = SESSION) {
  await store.mutate(sessionID, (record) => {
    record.memory.goal = "make host compaction lossless"
    record.memory.plan = [{ step: 1, text: "archive the working window", status: "active" }]
    record.windowStart = "u1"
    record.compact = { at: 1, turn: "u1", due: true }
    record.ext = { at: 1, turn: "u1", reason: "keep the plan", fromCap: 100, toCap: 200, factor: 2 }
    record.rebuilt = ["u1"]
    record.rebuildSaved = 42
    record.seenTurns = ["u1", "u2"]
  })
}

test("a host compaction archives every in-window turn with its raw messages", async () => {
  const store = new SessionStore(undefined, { now: () => 1_000 })
  await seedMemory(store)
  const event = { sessionID: SESSION, messages: transcript }

  const outcome = await runCompaction(event, { store, config })
  assert.deepEqual(outcome, { owned: true, archived: 2 })

  const record = await store.load(SESSION, { fresh: true })
  const spans = turnSpans(transcript)
  assert.equal(record.archive.length, 2)
  assert.deepEqual(record.archive.map((entry) => entry.id), ["u1", "u2"])

  for (const [index, span] of spans.entries()) {
    const entry = record.archive[index]
    const raw = turnMessages(transcript, span)
    assert.deepEqual(entry.messages, raw, `turn ${span.id} kept its raw messages`)
    assert.notEqual(entry.messages[0], transcript[span.startIdx], "the archive holds copies, not the host's objects")
    assert.equal(entry.gist, mechanicalGist(span, config.charsPerToken), `turn ${span.id} carries the mechanical gist`)
    assert.equal(entry.chars, charsOfMessages(raw), `turn ${span.id} carries its real character count`)
    assert.equal(typeof entry.createdAt, "number")
  }

  assert.equal(event.result.summary, renderMemory(record), "the owned summary is the memory document")
})

test("the next pass after a host compaction no longer sees the old era", async () => {
  const store = new SessionStore(undefined, { now: () => 1_000 })
  await seedMemory(store)
  await runCompaction({ sessionID: SESSION, messages: transcript }, { store, config })

  const record = await store.load(SESSION, { fresh: true })
  assert.equal(record.windowStart, undefined)
  assert.equal(record.compact, undefined)
  assert.equal(record.ext, undefined)
  assert.equal(record.rebuilt, undefined)
  assert.equal(record.rebuildSaved, undefined)
  assert.deepEqual(record.seenTurns, [])
  assert.deepEqual(record.hostCompact, { at: record.hostCompact.at, turns: 2, archived: 2 })
  assert.ok(record.hostCompact.at > 0)
})

test("a second compaction of the same transcript does not duplicate turns", async () => {
  const store = new SessionStore(undefined, { now: () => 1_000 })
  await seedMemory(store)
  const deps = { store, config }
  await runCompaction({ sessionID: SESSION, messages: transcript }, deps)

  const second = { sessionID: SESSION, messages: transcript }
  const outcome = await runCompaction(second, deps)
  assert.deepEqual(outcome, { owned: true, archived: 0 })

  const record = await store.load(SESSION, { fresh: true })
  assert.deepEqual(record.archive.map((entry) => entry.id), ["u1", "u2"])
  assert.equal(second.result.summary, renderMemory(record))
  assert.equal(record.hostCompact.turns, 0)
  assert.equal(record.hostCompact.archived, 2)
})

test("a turn already pending is not copied into the archive", async () => {
  const store = new SessionStore(undefined, { now: () => 1_000 })
  await seedMemory(store)
  await store.mutate(SESSION, (record) => {
    record.pending.push({
      id: "u1",
      gist: "the model is deciding about this one",
      chars: 10,
      messages: [transcript[0]],
      createdAt: 1,
      age: 0,
    })
  })

  const outcome = await runCompaction({ sessionID: SESSION, messages: transcript }, { store, config })
  assert.deepEqual(outcome, { owned: true, archived: 1 })

  const record = await store.load(SESSION, { fresh: true })
  assert.deepEqual(record.archive.map((entry) => entry.id), ["u2"])
  assert.deepEqual(record.pending.map((entry) => entry.id), ["u1"])
})

test("empty memory still preserves the turns but declines ownership", async () => {
  const store = new SessionStore(undefined, { now: () => 1_000 })
  const event = { sessionID: "compaction-empty-memory", messages: transcript }

  const outcome = await runCompaction(event, { store, config })
  assert.deepEqual(outcome, { owned: false, archived: 2 })
  assert.equal(event.result, undefined, "the host keeps its own summary")

  const record = await store.load("compaction-empty-memory", { fresh: true })
  assert.deepEqual(record.archive.map((entry) => entry.id), ["u1", "u2"])
  assert.equal(record.archive[0].messages.length, 4)
  assert.deepEqual(record.hostCompact, { at: record.hostCompact.at, turns: 2, archived: 2 })
})

test("archiveMaxTurns trims the oldest host-compaction turns", async () => {
  const store = new SessionStore(undefined, { now: () => 1_000 })
  await seedMemory(store)
  const bounded = resolveConfig({ options: { archiveMaxTurns: 1 } })

  const outcome = await runCompaction({ sessionID: SESSION, messages: transcript }, { store, config: bounded })
  assert.deepEqual(outcome, { owned: true, archived: 2 })

  const record = await store.load(SESSION, { fresh: true })
  assert.deepEqual(record.archive.map((entry) => entry.id), ["u2"], "newest wins")
  assert.equal(record.hostCompact.turns, 2, "the append count is what was archived, not what survived")
  assert.equal(record.hostCompact.archived, 1)
})

test("archiveMaxChars trims the oldest host-compaction turns", async () => {
  const store = new SessionStore(undefined, { now: () => 1_000 })
  await seedMemory(store, "compaction-char-cap")
  const bounded = resolveConfig({ options: { archiveMaxChars: 10_000 } })
  const big = "x".repeat(12_000)
  const messages = [user("big1", big), assistant("ba1", "ok"), user("big2", big), assistant("ba2", "ok")]

  const outcome = await runCompaction({ sessionID: "compaction-char-cap", messages }, { store, config: bounded })
  assert.deepEqual(outcome, { owned: true, archived: 2 })

  const record = await store.load("compaction-char-cap", { fresh: true })
  assert.deepEqual(record.archive.map((entry) => entry.id), ["big2"], "the character cap keeps at least one entry")
  assert.equal(record.hostCompact.archived, 1)
})

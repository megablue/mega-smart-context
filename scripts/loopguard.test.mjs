/**
 * The loop guard's pinning test.
 *
 * These are pure state-machine tests: no store, no host, no model call. The
 * payload seam is pinned separately in scripts/smoke.mjs.
 *
 * Run from the repo root: node scripts/loopguard.test.mjs
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  AGGRESSIVE_LOOP_GUARD_ENVELOPE,
  DEFAULT_LOOP_GUARD_ENVELOPE,
  LOOP_GUARD_MIN_SAMPLES,
  MAX_LOOP_GUARD_REDIRECT,
  MAX_LOOP_GUARD_SAMPLES,
  MAX_LOOP_GUARD_SIGNATURES,
  emptyLoopGuard,
  loopGuardEnvelope,
  loopGuardGreen,
  normalizeLoopGuard,
  updateLoopGuard,
} from "../src/core/loopguard.ts"

function user(id, text = "work") {
  return { id, role: "user", content: [{ type: "text", text }] }
}

function assistant(id, text = "ok") {
  return { id, role: "assistant", content: [{ type: "text", text }] }
}

function call(id, callId, name, input) {
  return { id, role: "assistant", content: [{ type: "tool-call", id: callId, name, input }] }
}

function result(id, callId, name, value, extra = {}) {
  return {
    id,
    role: "tool",
    content: [{ type: "tool-result", id: callId, name, result: { type: "text", value }, ...extra }],
  }
}

function failing(id, callId, name, input, message = "Error: expected 2, got 3") {
  return [call(id, callId, name, input), result("r" + id, callId, name, message)]
}

function repeatedFailure(count, message = "Error: expected 2, got 3") {
  const messages = [user("u1", "fix the failing test")]
  for (let index = 0; index < count; index += 1) {
    messages.push(...failing("a" + index, "c" + index, "bash", { command: "npm test" }, message))
  }
  return messages
}

test("the same call and error three times redirects once and names the signature", () => {
  const messages = repeatedFailure(3)
  const first = updateLoopGuard(undefined, messages)
  assert.equal(first.state.redirected, true)
  assert.equal(first.reason, "repeat")
  assert.match(first.redirect, /^process check:/)
  assert.match(first.redirect, /npm test/)
  assert.match(first.redirect, /expected #, got #/)
  assert.match(first.redirect, /envelope 20/)

  const same = updateLoopGuard(first.state, messages)
  assert.equal(same.redirect, first.redirect, "a repeated pass renders the same redirect")
  assert.equal(same.state.redirected, true)

  const longer = [...messages, ...failing("a3", "c3", "bash", { command: "npm test" })]
  const after = updateLoopGuard(first.state, longer)
  assert.equal(after.redirect, first.redirect, "a later call keeps the one redirect")
  assert.equal(after.redirect.match(/process check:/g).length, 1, "there is exactly one redirect line")
})

test("a green turn never redirects, even after a repeated failure", () => {
  const messages = [
    user("u1", "fix the failing test"),
    ...failing("a1", "c1", "bash", { command: "npm test" }),
    ...failing("a2", "c2", "bash", { command: "npm test" }),
    ...failing("a3", "c3", "bash", { command: "npm test" }),
    call("a4", "c4", "bash", { command: "npm test" }),
    result("r4", "c4", "bash", "ok 12 tests passed"),
  ]
  const decision = updateLoopGuard(undefined, messages)
  assert.equal(decision.redirect, undefined)
  assert.equal(decision.state.redirected, false)
  assert.equal(loopGuardGreen(decision.state), true)
})

test("a normal ten-call turn produces no redirect", () => {
  const messages = [user("u1", "read the files")]
  for (let index = 0; index < 10; index += 1) {
    messages.push(call("a" + index, "c" + index, "read", { path: "src/file-" + index + ".ts" }))
    messages.push(result("r" + index, "c" + index, "read", "contents"))
  }
  const decision = updateLoopGuard(undefined, messages)
  assert.equal(decision.redirect, undefined)
  assert.equal(decision.state.calls, 10)
})

test("a new user turn resets the counters and drops the old redirect", () => {
  const messages = repeatedFailure(3)
  const first = updateLoopGuard(undefined, messages)
  assert.equal(first.state.redirected, true)

  const next = [...messages, user("u2", "now do something else"), call("a4", "c4", "read", { path: "README.md" }), result("r4", "c4", "read", "text")]
  const second = updateLoopGuard(first.state, next)
  assert.equal(second.redirect, undefined)
  assert.equal(second.state.turn, "u2")
  assert.equal(second.state.calls, 1)
  assert.equal(second.state.failures, 0)
  assert.equal(second.state.redirected, false)
  assert.equal(second.state.repeated, 0)
})

test("repeated failures in an old completed turn never redirect the new turn", () => {
  const messages = [
    ...repeatedFailure(5),
    user("u2", "a fresh request"),
    call("a20", "c20", "read", { path: "README.md" }),
    result("r20", "c20", "read", "text"),
  ]
  const decision = updateLoopGuard(undefined, messages)
  assert.equal(decision.redirect, undefined)
  assert.equal(decision.state.turn, "u2")
  assert.equal(decision.state.calls, 1)
  assert.equal(decision.state.failures, 0)
})

test("five failures without a verification redirect after eight calls", () => {
  const messages = [user("u1", "try things")]
  for (let index = 0; index < 5; index += 1) {
    messages.push(...failing("a" + index, "c" + index, "bash", { command: "make target-" + index }, "Error: boom"))
  }
  for (let index = 5; index < 8; index += 1) {
    messages.push(call("a" + index, "c" + index, "read", { path: "file-" + index + ".ts" }), result("r" + index, "c" + index, "read", "text"))
  }
  const decision = updateLoopGuard(undefined, messages)
  assert.equal(decision.reason, "failures")
  assert.equal(decision.state.failures, 5)
  assert.equal(decision.state.verifications, 0)
  assert.match(decision.redirect, /no test\/build\/typecheck/)
})

test("eight edits without a check redirect, and a check resets the edit count", () => {
  const edits = [user("u1", "change files")]
  for (let index = 0; index < 8; index += 1) {
    edits.push(call("a" + index, "c" + index, "edit", { path: "src/file-" + index + ".ts", oldString: "a", newString: "b" }), result("r" + index, "c" + index, "edit", "applied"))
  }
  const decision = updateLoopGuard(undefined, edits)
  assert.equal(decision.reason, "edits")
  assert.match(decision.redirect, /8 edits/)

  const verified = [
    user("u2", "change more files"),
    call("a0", "c0", "bash", { command: "npm run typecheck" }),
    result("r0", "c0", "bash", "ok"),
    ...edits.slice(1),
  ]
  const afterVerify = updateLoopGuard(undefined, verified)
  assert.equal(afterVerify.reason, "edits", "edits after a successful check still count")
  assert.equal(afterVerify.state.editsAtVerify, 0)
})

test("a shell edit counts toward the edit rule", () => {
  const messages = [user("u1", "edit through the shell")]
  for (let index = 0; index < 8; index += 1) {
    messages.push(call("a" + index, "c" + index, "bash", { command: "sed -i 's/a/b/' src/file-" + index + ".ts" }))
    messages.push(result("r" + index, "c" + index, "bash", "done"))
  }
  const decision = updateLoopGuard(undefined, messages)
  assert.equal(decision.reason, "edits")
  assert.equal(decision.state.edits, 8)
})

test("a turn past the envelope with a repeating failure redirects on the envelope", () => {
  const messages = [user("u1", "debug")]
  for (let index = 0; index < 20; index += 1) {
    messages.push(
      ...failing(
        "a" + index,
        "c" + index,
        "bash",
        { command: "npm test -- --shard=" + index },
        "Error: boom " + index,
      ),
    )
  }
  const before = updateLoopGuard(undefined, messages.slice(0, messages.length - 2))
  assert.equal(before.redirect, undefined, "nineteen calls stay inside the envelope")

  const atEnvelope = updateLoopGuard(before.state, messages)
  assert.equal(atEnvelope.reason, "envelope")
  assert.match(atEnvelope.redirect, /20 calls/)
  assert.match(atEnvelope.redirect, /envelope 20/)
})

test("an external envelope wins and is clamped, and aggressive pulls it in", () => {
  const messages = [user("u1", "debug")]
  for (let index = 0; index < 20; index += 1) {
    messages.push(
      ...failing(
        "a" + index,
        "c" + index,
        "bash",
        { command: "npm test -- --shard=" + index },
        "Error: boom",
      ),
    )
  }
  const outside = updateLoopGuard(undefined, messages, { envelope: 25 })
  assert.equal(outside.redirect, undefined, "an external 25-call envelope delays the redirect")

  const inside = updateLoopGuard(outside.state, messages, { envelope: 25 })
  assert.equal(inside.redirect, undefined)
  const atExternalEnvelope = [...messages]
  for (let index = 20; index < 25; index += 1) {
    atExternalEnvelope.push(
      ...failing("a" + index, "c" + index, "bash", { command: "npm test -- --shard=" + index }, "Error: boom"),
    )
  }
  const fired = updateLoopGuard(outside.state, atExternalEnvelope, { envelope: 25 })
  assert.equal(fired.reason, "envelope")

  const aggressive = updateLoopGuard(undefined, messages.slice(0, 29), { mode: "aggressive" })
  assert.equal(aggressive.reason, "envelope", "aggressive fires at its 14-call fallback")
  assert.equal(loopGuardEnvelope(emptyLoopGuard(), { mode: "aggressive" }), AGGRESSIVE_LOOP_GUARD_ENVELOPE)
})

test("the envelope learns from green-turn samples and clamps", () => {
  const state = { ...emptyLoopGuard(), samples: [10, 10, 12, 12, 14] }
  assert.equal(loopGuardEnvelope(state), 14)
  assert.equal(loopGuardEnvelope(state, { envelope: 30 }), 30)
  assert.equal(loopGuardEnvelope({ ...state, samples: [] }), DEFAULT_LOOP_GUARD_ENVELOPE)
  assert.equal(loopGuardEnvelope({ ...state, samples: [2] }, { envelope: 1 }), 4)
  assert.equal(loopGuardEnvelope({ ...state, samples: [2] }, { envelope: 999 }), 200)
  assert.equal(state.samples.length >= LOOP_GUARD_MIN_SAMPLES, true)
})

test("normalization bounds strings, counters, maps and samples", () => {
  assert.equal(normalizeLoopGuard(undefined), undefined)
  assert.equal(normalizeLoopGuard("nope"), undefined)

  const repeatKeys = {}
  for (let index = 0; index < MAX_LOOP_GUARD_SIGNATURES + 10; index += 1) {
    repeatKeys["key-" + index] = { count: index + 1, signature: "sig-" + index, label: "label-" + index }
  }
  const errorSigs = {}
  for (let index = 0; index < MAX_LOOP_GUARD_SIGNATURES + 10; index += 1) {
    errorSigs["sig-" + index] = index + 1
  }
  const samples = Array.from({ length: MAX_LOOP_GUARD_SAMPLES + 10 }, (_, index) => index + 1)
  const state = normalizeLoopGuard({
    turn: "u".repeat(500),
    calls: -3,
    failures: Number.NaN,
    edits: 1.9,
    verifications: "many",
    lastVerifyOk: "yes",
    errorSigs,
    repeatKeys,
    samples,
    redirected: true,
    redirectReason: "not-a-reason",
    redirectText: "x".repeat(MAX_LOOP_GUARD_REDIRECT + 100),
    repeatedLabel: "l".repeat(500),
  })
  assert.equal(state.turn.length, 200)
  assert.equal(state.calls, 0)
  assert.equal(state.failures, 0)
  assert.equal(state.edits, 2)
  assert.equal(state.verifications, 0)
  assert.equal(state.lastVerifyOk, false)
  assert.equal(Object.keys(state.errorSigs).length, MAX_LOOP_GUARD_SIGNATURES)
  assert.equal(Object.keys(state.repeatKeys).length, MAX_LOOP_GUARD_SIGNATURES)
  assert.equal(state.samples.length, MAX_LOOP_GUARD_SAMPLES)
  assert.equal(state.redirectText.length, MAX_LOOP_GUARD_REDIRECT)
  assert.equal(state.redirectReason, undefined)
  assert.equal(state.repeatedLabel.length, 80)
})

test("the digest records reads, new files and verification, and never mutates a message", () => {
  const messages = [
    user("u1", "inspect"),
    call("a1", "c1", "write", { path: "src/new.ts", content: "x" }),
    result("r1", "c1", "write", "wrote 1 byte"),
    call("a2", "c2", "read", { path: "src/new.ts" }),
    result("r2", "c2", "read", "x"),
    call("a3", "c3", "bash", { command: "npm run build" }),
    result("r3", "c3", "bash", "built"),
  ]
  const before = JSON.stringify(messages)
  const decision = updateLoopGuard(undefined, messages)
  assert.equal(JSON.stringify(messages), before)
  assert.equal(decision.state.calls, 3)
  assert.equal(decision.state.newFiles, 1)
  assert.equal(decision.state.reads, 1)
  assert.equal(decision.state.verifications, 1)
  assert.equal(decision.state.lastVerifyOk, true)
  assert.equal(decision.state.edits, 1)
})

test("the decision is deterministic and nudges can be disabled", () => {
  const messages = repeatedFailure(3)
  const first = updateLoopGuard(undefined, messages)
  const second = updateLoopGuard(undefined, messages)
  assert.equal(JSON.stringify(first), JSON.stringify(second))

  const off = updateLoopGuard(undefined, messages, { nudges: 0 })
  assert.equal(off.redirect, undefined)
  assert.equal(off.state.redirected, false)
})

test("a shrunken transcript keeps the one delivered redirect", () => {
  const messages = repeatedFailure(3)
  const first = updateLoopGuard(undefined, messages)
  const shrunken = updateLoopGuard(first.state, messages.slice(0, -2))
  assert.equal(shrunken.state.calls, 2)
  assert.equal(shrunken.state.redirected, true)
  assert.equal(shrunken.redirect, first.redirect)
})
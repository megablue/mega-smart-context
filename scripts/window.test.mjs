/**
 * The working-window extension's pinning test.
 *
 * Pure arithmetic: no store, no host, no model call. The decision is pinned
 * against the host reserve mirrored from scripts/native-compaction.mjs.
 *
 * Run from the repo root: node scripts/window.test.mjs
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  EXTEND_FACTOR_MAX,
  EXTEND_FACTOR_MIN,
  WARN_PERCENT_MAX,
  WARN_PERCENT_MIN,
  budgetPercent,
  decideExtension,
  effectivePoolCap,
  extensionHeadroom,
  isNear,
} from "../src/core/window.ts"

function request(overrides = {}) {
  return {
    enabled: true,
    factor: 2,
    memoryTokens: 100_000,
    workingTokens: 200_000,
    modelContext: 1_000_000,
    alreadyExtended: false,
    ...overrides,
  }
}

test("the bounds are the documented ones", () => {
  assert.equal(EXTEND_FACTOR_MIN, 1.1)
  assert.equal(EXTEND_FACTOR_MAX, 4)
  assert.equal(WARN_PERCENT_MIN, 50)
  assert.equal(WARN_PERCENT_MAX, 95)
})

test("a 1M window doubles the working budget (100k+200k) under an 810k hard cap", () => {
  assert.deepEqual(decideExtension(request()), {
    ok: true,
    toCap: 500_000,
    factor: 2,
    hardCap: 810_000,
  })
})

test("a 400k window binds the extension at the 324k hard cap", () => {
  assert.deepEqual(decideExtension(request({ modelContext: 400_000 })), {
    ok: true,
    toCap: 324_000,
    factor: 1.12,
    hardCap: 324_000,
  })
})

test("a 200k window refuses because the hard cap is below the base", () => {
  assert.deepEqual(decideExtension(request({ modelContext: 200_000 })), {
    ok: false,
    why: "no headroom under the ~162k model ceiling; checkpoint now",
  })
})

test("the exact refusal message is returned for each gate", () => {
  assert.deepEqual(decideExtension(request({ enabled: false })), {
    ok: false,
    why: "the extension is disabled in config",
  })
  assert.deepEqual(decideExtension(request({ alreadyExtended: true })), {
    ok: false,
    why: "this era already has an extension; checkpoint now",
  })
  assert.deepEqual(decideExtension(request({ modelContext: undefined })), {
    ok: false,
    why: "the model window is unknown; checkpoint now",
  })
  assert.deepEqual(decideExtension(request({ modelContext: 0 })), {
    ok: false,
    why: "the model window is unknown; checkpoint now",
  })
  assert.deepEqual(decideExtension(request({ modelContext: Number.NaN })), {
    ok: false,
    why: "the model window is unknown; checkpoint now",
  })
  assert.deepEqual(decideExtension(request({ modelContext: Number.POSITIVE_INFINITY })), {
    ok: false,
    why: "the model window is unknown; checkpoint now",
  })
})

test("a spent extension and a disabled one are refused in that order of precedence", () => {
  assert.deepEqual(decideExtension(request({ enabled: false, alreadyExtended: true })), {
    ok: false,
    why: "the extension is disabled in config",
  })
})

test("host system tokens reduce the hard cap by their overhead", () => {
  const decision = decideExtension(request({ hostSystemTokens: 100_000 }))
  assert.equal(decision.ok, true)
  assert.equal(decision.hardCap, 720_000)
  assert.equal(decision.toCap, 500_000)
})

test("the factor is clamped at both ends", () => {
  const low = decideExtension(request({ factor: 0.5 }))
  assert.equal(low.ok, true)
  assert.equal(low.toCap, 320_000)
  assert.equal(low.factor, 1.1)

  const high = decideExtension(request({ factor: 10 }))
  assert.equal(high.ok, true)
  assert.equal(high.toCap, 810_000)
  assert.equal(high.factor, 3.55)
  assert.equal(high.hardCap, 810_000)
})

test("the host reply reserve steps up at a 32k window", () => {
  const below = decideExtension(request({ modelContext: 31_999, memoryTokens: 5_000, workingTokens: 5_000 }))
  assert.equal(below.ok, true)
  assert.equal(below.hardCap, 25_920)
  assert.equal(below.toCap, 15_000)

  const at = decideExtension(request({ modelContext: 32_000, memoryTokens: 5_000, workingTokens: 5_000 }))
  assert.equal(at.ok, true)
  assert.equal(at.hardCap, 14_400)
  assert.equal(at.toCap, 14_400)
})

test("the effective pool cap prefers an extension over the sum", () => {
  assert.equal(effectivePoolCap(120_000, 80_000), 200_000)
  assert.equal(effectivePoolCap(120_000, 80_000, { toCap: 600_000 }), 600_000)
})

test("budget percent rounds and clamps to a display-safe range", () => {
  assert.equal(budgetPercent(123, 1000), 12)
  assert.equal(budgetPercent(125, 1000), 13)
  assert.equal(budgetPercent(2_000_000, 100_000), 999)
  assert.equal(budgetPercent(-5, 1000), 0)
  assert.equal(budgetPercent(500, 0), 0)
  assert.equal(budgetPercent(500, -1), 0)
})

test("isNear triggers at exactly the warning threshold", () => {
  assert.equal(isNear(800, 1000, 80), true)
  assert.equal(isNear(799, 1000, 80), false)
  assert.equal(isNear(0, 0, WARN_PERCENT_MIN), false)
  assert.equal(isNear(1000, 1000, WARN_PERCENT_MAX), true)
})

test("extension headroom never goes negative", () => {
  assert.equal(extensionHeadroom(400_000, 1_000_000), 600_000)
  assert.equal(extensionHeadroom(1_200_000, 1_000_000), 0)
})

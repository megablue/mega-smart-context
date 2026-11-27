/**
 * Working-window extension arithmetic.
 *
 * When the working window fills, the model may ask for one extension per
 * compaction era. The extension is bounded twice: by the configured factor and
 * by what the host will accept before its own compaction. This module owns
 * both numbers and stays pure - no store, no host, no display formatting - so
 * the decision can be tested on its own.
 *
 * The host reserve mirrors `calculateCeiling` in
 * `scripts/native-compaction.mjs`: 10% of the model window, or 16k once the
 * window is at least twice that, with a further 10% kept back for tool schemas
 * and estimate error.
 *
 * @module mega-smart-context/window
 */

import { clamp, formatTokens } from "./measure.ts"

/** The smallest multiplier config accepts: a 10% extension. */
export const EXTEND_FACTOR_MIN = 1.1

/** The largest multiplier config accepts: a fourfold extension. */
export const EXTEND_FACTOR_MAX = 4

/** The lowest warning threshold `/context` accepts, as a percentage. */
export const WARN_PERCENT_MIN = 50

/** The highest warning threshold `/context` accepts, as a percentage. */
export const WARN_PERCENT_MAX = 95

/** Everything the decision needs, all from config and the live request. */
export interface ExtensionRequest {
  /** Whether `workingWindow.extend` is on. */
  readonly enabled: boolean
  /** The configured multiplier, already validated by `config.ts`. */
  readonly factor: number
  /** The budget that does not grow: the memory document. */
  readonly memoryTokens: number
  /** The budget the factor applies to: the working window. */
  readonly workingTokens: number
  /** The model's context window, when the host reports one. */
  readonly modelContext?: number
  /** Estimated tokens the host spends on its own system prompt and tools. */
  readonly hostSystemTokens?: number
  /** True once this era has spent its one extension. */
  readonly alreadyExtended: boolean
}

/** Either a cap to extend to, or the reason not to. */
export type ExtensionDecision =
  | { readonly ok: true; readonly toCap: number; readonly factor: number; readonly hardCap: number }
  | { readonly ok: false; readonly why: string }

/**
 * The request ceiling the host itself would honour.
 *
 * Mirrors `calculateCeiling` in `scripts/native-compaction.mjs`, then keeps
 * another 10% for tool schemas and the error in a character-count estimate.
 */
function hardCapOf(modelContext: number, hostSystemTokens: number | undefined): number {
  const reserve = Math.max(
    Math.floor(modelContext * 0.1),
    modelContext >= 32_000 ? 16_000 : 0,
  )
  const ceiling = modelContext - reserve
  const overhead =
    typeof hostSystemTokens === "number" && Number.isFinite(hostSystemTokens)
      ? Math.max(0, hostSystemTokens)
      : 0
  return Math.max(0, Math.floor((ceiling - overhead) * 0.9))
}

/**
 * Decide whether the working window may grow, and to what.
 *
 * Refusals come before any division by `baseCap`: a disabled extension, a
 * spent extension, an unknown model window, and a hard cap that cannot beat
 * the base cap. The realized factor is the actual growth, which can be smaller
 * than the requested factor when the hard cap binds.
 */
export function decideExtension(request: ExtensionRequest): ExtensionDecision {
  if (!request.enabled) {
    return { ok: false, why: "the extension is disabled in config" }
  }
  if (request.alreadyExtended) {
    return { ok: false, why: "this era already has an extension; checkpoint now" }
  }
  const modelContext = request.modelContext
  if (modelContext === undefined || !Number.isFinite(modelContext) || modelContext <= 0) {
    return { ok: false, why: "the model window is unknown; checkpoint now" }
  }

  const hardCap = hardCapOf(modelContext, request.hostSystemTokens)
  const multiplier = Number.isFinite(request.factor)
    ? clamp(request.factor, EXTEND_FACTOR_MIN, EXTEND_FACTOR_MAX)
    : EXTEND_FACTOR_MIN
  const memory = Math.max(0, Math.floor(request.memoryTokens))
  const working = Math.max(0, Math.floor(request.workingTokens))
  const baseCap = memory + working
  // The factor grows the working window, not the pool: doubling a 100k+100k
  // session gives 100k + 200k, not 200k + 200k.
  const wanted = memory + Math.floor(working * multiplier)
  const toCap = Math.min(wanted, hardCap)
  if (toCap <= baseCap) {
    return {
      ok: false,
      why: `no headroom under the ~${formatTokens(hardCap)} model ceiling; checkpoint now`,
    }
  }
  return {
    ok: true,
    toCap,
    factor: working > 0 ? Math.round(((toCap - memory) / working) * 100) / 100 : 1,
    hardCap,
  }
}

/** The pool a memory or working budget is measured against; an extension wins. */
export function effectivePoolCap(
  memoryTokens: number,
  workingTokens: number,
  ext?: { toCap: number },
): number {
  return ext?.toCap ?? memoryTokens + workingTokens
}

/** Usage as a whole percentage, clamped to 0..999 so a display cannot overflow. */
export function budgetPercent(tokens: number, cap: number): number {
  if (!Number.isFinite(cap) || cap <= 0) return 0
  if (!Number.isFinite(tokens)) return 0
  return clamp(Math.round((tokens / cap) * 100), 0, 999)
}

/** Whether usage has reached the warning threshold. A zero cap is never near. */
export function isNear(tokens: number, cap: number, warnPercent: number): boolean {
  return cap > 0 && tokens >= (cap * warnPercent) / 100
}

/** Tokens still available under a cap; zero once the cap is reached. */
export function extensionHeadroom(tokens: number, cap: number): number {
  return Math.max(0, cap - tokens)
}

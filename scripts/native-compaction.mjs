/**
 * The native-compaction baseline, simulated offline.
 *
 * OpenCode's own compactor is the second counterfactual in `npm run analyze`:
 * what the same session would have sent if the plugin had not existed and the
 * host's `/compact` had managed the transcript instead. The rule is mirrored
 * from the host's `packages/core/src/session/compaction.ts`, not guessed:
 *
 * - trigger when the request estimate reaches `calculateCeiling`, which keeps a
 *   reply reserve of 10% of the window, but never less than 16k once the window
 *   is at least twice that;
 * - after compacting, the provider sees one checkpoint plus the newest `keep`
 *   tokens, so the next request is `keep + summary`;
 * - the summary is written by the model, so its size cannot be known offline.
 *
 * That last point is why the summary size is a visible flag with a default, not
 * a constant buried here. The module is pure (no SQLite) so the smoke can
 * import it.
 *
 * @module mega-smart-context/native-compaction.mjs
 */

/** The host's own fallback when a model reports no limit (`UNKNOWN_WINDOW`). */
export const UNKNOWN_WINDOW = 200_000

/** The host's smallest reply reserve (`RESERVE_MIN`). */
export const RESERVE_MIN = 16_000

/** The host's default verbatim keep (`keep: 15_000`). */
export const DEFAULT_KEEP = 15_000

/** A named assumption: the checkpoint summary's size, in tokens. */
export const DEFAULT_SUMMARY = 2_000

/**
 * The largest request the host sends before compacting.
 *
 * Mirrors `calculateCeiling`: 10% of the window, or `RESERVE_MIN` when that is
 * more; a window too small to give up 16k keeps 10%. An explicit `buffer`
 * replaces the reserve entirely, as it does in the host.
 */
export function calculateCeiling(window, buffer) {
  if (!Number.isFinite(window) || window <= 0) return Number.POSITIVE_INFINITY
  if (buffer !== undefined) return window - buffer
  const reserve = Math.max(Math.floor(window * 0.1), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
  return window - reserve
}

/**
 * Simulate the host's compaction over an observed transcript series (tokens).
 *
 * `raw` is the append-only counterfactual: every positive step of the observed
 * series is added, so a real host compaction does not erase history.
 *
 * `native` follows those steps too, but when the observed series **drops** the
 * simulation anchors to the observed value rather than pretending it kept
 * growing. That drop is a real compaction by the host, and anchoring can only
 * make native look *smaller* than it was — the bias is deliberately against the
 * plugin's own sales pitch.
 */
export function simulateNative(series, options = {}) {
  const window = options.window ?? UNKNOWN_WINDOW
  const keep = options.keep ?? DEFAULT_KEEP
  const summary = options.summary ?? DEFAULT_SUMMARY
  const buffer = options.buffer
  const ceiling = calculateCeiling(window, buffer)
  const floor = keep + summary

  const passes = []
  let raw = 0
  let native = 0
  let previous
  let compactions = 0

  for (const value of series) {
    const observed = Number.isFinite(value) && value > 0 ? value : 0
    if (previous === undefined) {
      raw = observed
      native = observed
    } else {
      const growth = Math.max(0, observed - previous)
      raw += growth
      // A drop is the host compacting for real: start from what it actually sent.
      native = observed < previous ? observed : native + growth
    }

    const compacted = native >= ceiling
    if (compacted) {
      native = floor
      compactions += 1
    }
    passes.push({ native, raw, compacted })
    previous = observed
  }

  return { window, ceiling, floor, keep, summary, buffer: buffer ?? null, compactions, passes }
}

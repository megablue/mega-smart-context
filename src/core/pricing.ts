/**
 * Cache-aware token accounting.
 *
 * Raw token counts overstate a coding session: most of the traffic is cached
 * re-reads, billed at a fraction of fresh input, while output is billed several
 * times higher. This module reweights a usage breakdown into fresh-input-token
 * equivalents, using the price snapshot from TokenEconomizer's pricing.py at
 * upstream 1bfeccd. It is an analyzer concern only; nothing here touches the
 * request payload.
 *
 * Unknown model ids fall back to the generic Claude-curve weights and are
 * labelled as such. An explicit `--weights` spec can override them.
 *
 * @module mega-smart-context/pricing
 */

/** Relative prices against one fresh input token. */
export interface ModelWeights {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cacheWrite1h?: number
  readonly output: number
}

/** One usage breakdown, in tokens. */
export interface TokenUsage {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cacheWrite1h: number
  readonly output: number
}

export const EMPTY_USAGE: TokenUsage = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  output: 0,
}

/**
 * The published-ratio snapshot from TokenEconomizer's pricing.py (2026-07-27,
 * extended 2026-11-13). Input is the unit; cache reads, cache writes (5m and
 * 1h) and output are ratios against it.
 */
export const MODEL_WEIGHTS: Readonly<Record<string, ModelWeights>> = {
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
  "claude-opus-4-6": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
  "claude-opus-4-7": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
  "claude-opus-4-8": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
  "claude-opus-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
  "claude-sonnet-4-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
  "claude-sonnet-4-6": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
  "claude-sonnet-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
  "gemini-2.5-pro": { input: 1, cacheRead: 0.096, cacheWrite: 0, output: 8 },
  "gemini-3-flash-preview": { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 6 },
  "gemini-3.1-pro-preview": { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 6 },
  "gemini-3.5-flash": { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 6 },
  "gemini-3.6-flash": { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 5 },
  "gpt-5-mini": { input: 1, cacheRead: 0.08, cacheWrite: 0, output: 8 },
  "gpt-5.3-codex": { input: 1, cacheRead: 0.0971, cacheWrite: 0, output: 8 },
  "gpt-5.4": { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 6 },
  "gpt-5.4-mini": { input: 1, cacheRead: 0.0933, cacheWrite: 0, output: 6 },
  "gpt-5.5": { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 6 },
  "gpt-5.6-luna": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 6 },
  "gpt-5.6-sol": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 6 },
  "gpt-5.6-terra": { input: 1, cacheRead: 0.1, cacheWrite: 1.248, output: 6 },
  "mai-code-1-flash-picker": { input: 1, cacheRead: 0.0933, cacheWrite: 0, output: 6 },
  "gpt-5": { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 8 },
  "gpt-5.1": { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 8 },
  "gpt-5-codex": { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 8 },
  "gpt-5.1-codex": { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 8 },
  "gpt-5.1-codex-max": { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 8 },
  "gpt-5.2-codex": { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 8 },
  "codex-mini-latest": { input: 1, cacheRead: 0.25, cacheWrite: 1, output: 4 },
}

/** The fallback curve for an unknown id: the Claude ratios, clearly labelled. */
export const GENERIC_WEIGHTS: ModelWeights = {
  input: 1,
  cacheRead: 0.1,
  cacheWrite: 1.25,
  cacheWrite1h: 2,
  output: 5,
}

export interface WeightChoice {
  readonly key: string
  readonly weights: ModelWeights
  readonly source: "table" | "generic"
}

/** Strip a provider prefix and normalize the id the host recorded. */
export function modelKeyOf(model: string | undefined): string {
  const raw = (model ?? "").trim().toLowerCase()
  if (raw.length === 0) return ""
  const slash = raw.lastIndexOf("/")
  return slash >= 0 ? raw.slice(slash + 1) : raw
}

/**
 * Weights for a host model id. An exact table entry wins; a dated Claude id
 * (e.g. `claude-sonnet-4-5-20260101`) uses the Claude curve; everything else
 * uses the generic curve and says so.
 */
export function weightsFor(model: string | undefined): WeightChoice {
  const key = modelKeyOf(model)
  if (key.length === 0) return { key: "generic", weights: GENERIC_WEIGHTS, source: "generic" }
  const exact = MODEL_WEIGHTS[key]
  if (exact !== undefined) return { key, weights: exact, source: "table" }
  if (key.startsWith("claude-")) return { key, weights: GENERIC_WEIGHTS, source: "generic" }
  return { key, weights: GENERIC_WEIGHTS, source: "generic" }
}

/** Parse `input,cache_read,cache_write,output[,cache_write_1h]`. */
export function parseWeights(spec: string): ModelWeights {
  const parts = spec.split(",").map((part) => Number(part.trim()))
  if (parts.length < 4 || parts.length > 5 || parts.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("weights need input,cache_read,cache_write,output[,cache_write_1h] with non-negative numbers")
  }
  return {
    input: parts[0],
    cacheRead: parts[1],
    cacheWrite: parts[2],
    output: parts[3],
    ...(parts[4] === undefined ? {} : { cacheWrite1h: parts[4] }),
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** Read OpenCode's `tokens` object: input, output, reasoning and cache.{read,write}. */
export function usageFromHostTokens(tokens: unknown): TokenUsage {
  if (typeof tokens !== "object" || tokens === null) return EMPTY_USAGE
  const value = tokens as Record<string, unknown>
  const cache = typeof value.cache === "object" && value.cache !== null ? (value.cache as Record<string, unknown>) : {}
  const output = count(value.output)
  return {
    input: count(value.input),
    cacheRead: count(cache.read),
    cacheWrite: count(cache.write),
    cacheWrite1h: count(cache.write1h ?? value.cacheWrite1h),
    output: output > 0 ? output : count(value.reasoning),
  }
}

/** Sum two usage breakdowns. */
export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cacheWrite1h: left.cacheWrite1h + right.cacheWrite1h,
    output: left.output + right.output,
  }
}

/** The raw token count, before cache weighting. */
export function rawTokens(usage: TokenUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output
}

/**
 * Reweight a usage breakdown into fresh-input-token equivalents.
 *
 * The 1-hour share of the cache writes is priced at `cacheWrite1h` (falling back
 * to `cacheWrite`); it is clamped to the total cache-write count.
 */
export function effectiveTokens(usage: TokenUsage, weights: ModelWeights): number {
  const write1h = Math.min(Math.max(0, usage.cacheWrite1h), Math.max(0, usage.cacheWrite))
  const write = Math.max(0, usage.cacheWrite) - write1h
  const oneHour = weights.cacheWrite1h ?? weights.cacheWrite
  return (
    Math.max(0, usage.input) * weights.input +
    Math.max(0, usage.cacheRead) * weights.cacheRead +
    write * weights.cacheWrite +
    write1h * oneHour +
    Math.max(0, usage.output) * weights.output
  )
}

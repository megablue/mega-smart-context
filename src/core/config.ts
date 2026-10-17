/**
 * The configuration surface: built-in defaults, strict validation, clamps.
 *
 * Three layers, most specific last: the defaults below, the `options` the host
 * passes to the plugin, and the user-level JSON file the adapter reads. A layer
 * replaces only the keys it sets, so a partial file is fine. An unknown key is an
 * error rather than a silently ignored typo: a setting a user believes is in
 * force but is not is worse than a plugin that refuses to start.
 *
 * The numbers are estimates, not measurements: the host exposes no token meter,
 * so every budget is `chars / charsPerToken`. See `measure.ts`.
 *
 * @module mega-smart-context/config
 */

export interface ResolvedConfig {
  /** Master switch. `false` registers nothing. */
  enabled: boolean
  /** Cap on the model-authored memory document, in estimated tokens. */
  memoryTokens: number
  /** Cap on the verbatim working window, in estimated tokens. */
  workingTokens: number
  /** The divisor used to turn characters into estimated tokens. */
  charsPerToken: number
  /** Manage child (subagent) sessions independently. */
  subagents: boolean
  /** How many pending turns the model may see before an unhandled one leaves. */
  evictionLead: number
  /** Archive unhandled evictions instead of dropping them. */
  autoArchive: boolean
  /** Keep at most this many archived turns per session. */
  archiveMaxTurns: number
  /** Keep the archive under this many characters per session. */
  archiveMaxChars: number
  /** Offer the feature-map `ref` action. */
  refs: boolean
  /** Erode one tool result larger than this many characters. */
  maxResultChars: number
  /** Register the `/context` command. */
  manualCommand: boolean
  /** Log pass decisions to stderr. */
  debug: boolean
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  memoryTokens: 50_000,
  workingTokens: 16_000,
  charsPerToken: 4,
  subagents: true,
  evictionLead: 1,
  autoArchive: true,
  archiveMaxTurns: 200,
  archiveMaxChars: 400_000,
  refs: true,
  maxResultChars: 4_000,
  manualCommand: true,
  debug: false,
}

export const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_CONFIG))

export const USER_CONFIG_FILENAME = "mega-smart-context.json"
export const USER_CONFIG_ENV = "MEGA_SMART_CONTEXT_CONFIG"
export const NO_USER_CONFIG_ENV = "MEGA_SMART_CONTEXT_NO_USER_CONFIG"

const BOOLEAN_KEYS = new Set([
  "enabled",
  "subagents",
  "autoArchive",
  "refs",
  "manualCommand",
  "debug",
])

const NUMBER_KEYS = new Set([
  "memoryTokens",
  "workingTokens",
  "charsPerToken",
  "evictionLead",
  "archiveMaxTurns",
  "archiveMaxChars",
  "maxResultChars",
])

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Validate and clamp one layer.
 *
 * @param value - the layer as read (already parsed JSON, or `ctx.options`).
 * @param source - a label used in the error, so the user knows which file to fix.
 * @throws when the layer is not an object, names an unknown key, or has the wrong type.
 */
export function parseLayer(value: unknown, source: string): Partial<ResolvedConfig> {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`config: ${source} must be a JSON object`)
  }
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`config: unknown key "${key}" in ${source}`)
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof raw !== "boolean") throw new Error(`config: ${key} in ${source} must be true or false`)
      out[key] = raw
      continue
    }
    if (!NUMBER_KEYS.has(key)) continue
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new Error(`config: ${key} in ${source} must be a finite number`)
    }
    switch (key) {
      case "memoryTokens":
        out[key] = Math.max(1000, Math.round(raw))
        break
      case "workingTokens":
        out[key] = Math.max(500, Math.round(raw))
        break
      case "charsPerToken":
        out[key] = clampInteger(raw * 100, 200, 800) / 100
        break
      case "evictionLead":
        out[key] = clampInteger(raw, 0, 20)
        break
      case "archiveMaxTurns":
        out[key] = clampInteger(raw, 0, 5000)
        break
      case "archiveMaxChars":
        out[key] = Math.max(10_000, Math.round(raw))
        break
      case "maxResultChars":
        out[key] = Math.max(200, Math.round(raw))
        break
      default:
        out[key] = raw
    }
  }
  return out as Partial<ResolvedConfig>
}

/** Merge the defaults, the package options, the host options and the user file, in that order. */
export function resolveConfig(layers: { package?: unknown; options?: unknown; user?: unknown } = {}): ResolvedConfig {
  const config: ResolvedConfig = { ...DEFAULT_CONFIG }
  Object.assign(config, parseLayer(layers.package, "package options"))
  Object.assign(config, parseLayer(layers.options, "plugin options"))
  Object.assign(config, parseLayer(layers.user, "user config"))
  return config
}

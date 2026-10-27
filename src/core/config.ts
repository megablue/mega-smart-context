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

import { isPlainObject } from "./types.ts"

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
  /** Let `recall`/`expand` reach the spawning session's archive with from:"parent". */
  parentArchive: boolean
  /** Characters per `expand` page, clamped by `maxResultChars` when used. */
  expandDigestChars: number
  /** Offer the feature-map `ref` action. */
  refs: boolean
  /** Erode one tool result larger than this many characters. */
  maxResultChars: number
  /** Register the `/context` command. */
  manualCommand: boolean
  /** Let the TUI half ask GitHub once a day for a newer version. */
  updateCheck: boolean
  /** Let the TUI half render the sidebar block. */
  sidebar: boolean
  /** Log pass decisions to stderr. */
  debug: boolean
  /**
   * Named bundles of the per-session keys, chosen per session.
   *
   * A profile may set only {@link SESSION_KEYS}: a model cannot decide whether
   * the sidebar exists, whether the plugin is enabled, or whether the update
   * check runs. The maps merge across config layers by name, so a user file adds
   * to the package's definitions rather than replacing them wholesale.
   */
  profiles: Record<string, SessionOverrides>
  /** `provider/model` (or a bare model id, or `provider/model#variant`) to a profile name. */
  modelProfiles: Record<string, string>
  /** The profile an auto session falls back to when no model mapping matches. */
  defaultProfile: string
}

/**
 * The keys a profile may override: everything that describes *this session's*
 * budget and windows, and nothing that describes the install or the process.
 */
export const SESSION_KEYS = [
  "memoryTokens",
  "workingTokens",
  "charsPerToken",
  "evictionLead",
  "autoArchive",
  "archiveMaxTurns",
  "archiveMaxChars",
  "parentArchive",
  "expandDigestChars",
  "refs",
  "maxResultChars",
] as const

export type SessionKey = (typeof SESSION_KEYS)[number]

/** One profile's body: a partial config limited to {@link SESSION_KEYS}. */
export type SessionOverrides = Partial<Pick<ResolvedConfig, SessionKey>>

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  memoryTokens: 20_000,
  workingTokens: 20_000,
  charsPerToken: 4,
  subagents: true,
  evictionLead: 1,
  autoArchive: true,
  archiveMaxTurns: 200,
  archiveMaxChars: 400_000,
  parentArchive: true,
  expandDigestChars: 4_000,
  refs: true,
  maxResultChars: 4_000,
  manualCommand: true,
  updateCheck: true,
  sidebar: true,
  debug: false,
  profiles: {},
  modelProfiles: {},
  defaultProfile: "",
}

export const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_CONFIG))

/** The same membership test for a profile body, which may set only the session keys. */
export const SESSION_KEY_SET: ReadonlySet<string> = new Set(SESSION_KEYS)

/** A profile name: short, JSON-key safe, and usable as a `dialog.select` row. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const USER_CONFIG_FILENAME = "mega-smart-context.json"
export const USER_CONFIG_ENV = "MEGA_SMART_CONTEXT_CONFIG"
export const NO_USER_CONFIG_ENV = "MEGA_SMART_CONTEXT_NO_USER_CONFIG"

const BOOLEAN_KEYS = new Set([
  "enabled",
  "subagents",
  "autoArchive",
  "parentArchive",
  "refs",
  "manualCommand",
  "updateCheck",
  "sidebar",
  "debug",
])

const NUMBER_KEYS = new Set([
  "memoryTokens",
  "workingTokens",
  "charsPerToken",
  "evictionLead",
  "archiveMaxTurns",
  "archiveMaxChars",
  "expandDigestChars",
  "maxResultChars",
])

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Validate and clamp one scalar key.
 *
 * @returns the value to store, or `undefined` when the key takes no scalar (the
 *   object keys are handled by their own parsers).
 * @throws when the value has the wrong type.
 */
function coerceValue(key: string, raw: unknown, where: string): unknown {
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof raw !== "boolean") throw new Error(`config: ${key} in ${where} must be true or false`)
    return raw
  }
  if (!NUMBER_KEYS.has(key)) return undefined
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`config: ${key} in ${where} must be a finite number`)
  }
  switch (key) {
    case "memoryTokens":
      return Math.max(1000, Math.round(raw))
    case "workingTokens":
      return Math.max(500, Math.round(raw))
    case "charsPerToken":
      return clampInteger(raw * 100, 200, 800) / 100
    case "evictionLead":
      return clampInteger(raw, 0, 20)
    case "archiveMaxTurns":
      return clampInteger(raw, 0, 5000)
    case "archiveMaxChars":
      return Math.max(10_000, Math.round(raw))
    case "expandDigestChars":
      return Math.max(500, Math.round(raw))
    case "maxResultChars":
      return Math.max(200, Math.round(raw))
    default:
      return raw
  }
}

function profileNameOf(raw: unknown, where: string): string {
  if (typeof raw !== "string" || !PROFILE_NAME.test(raw.trim())) {
    throw new Error(
      `config: a profile name in ${where} must be letters, digits, dot, dash or underscore`,
    )
  }
  return raw.trim()
}

/**
 * Parse the `profiles` map: each value may set only the per-session keys.
 *
 * Strict on purpose. A profile that silently ignored `sidebar:false` would be a
 * setting the user believes is in force; the whole config surface refuses that
 * trade, and a profile is no exception.
 */
function parseProfiles(raw: unknown, source: string): Record<string, SessionOverrides> {
  if (!isPlainObject(raw)) throw new Error(`config: profiles in ${source} must be an object`)
  const out: Record<string, SessionOverrides> = {}
  for (const [name, body] of Object.entries(raw)) {
    const profile = profileNameOf(name, source)
    if (!isPlainObject(body)) throw new Error(`config: profile ${JSON.stringify(profile)} in ${source} must be an object`)
    const where = `profile ${JSON.stringify(profile)} of ${source}`
    const overrides: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      if (!SESSION_KEY_SET.has(key)) {
        throw new Error(`config: unknown key "${key}" in ${where}`)
      }
      const coerced = coerceValue(key, value, where)
      if (coerced !== undefined) overrides[key] = coerced
    }
    out[profile] = overrides as SessionOverrides
  }
  return out
}

/** Parse `modelProfiles`: a model key to a profile name, both non-empty. */
function parseModelProfiles(raw: unknown, source: string): Record<string, string> {
  if (!isPlainObject(raw)) throw new Error(`config: modelProfiles in ${source} must be an object`)
  const out: Record<string, string> = {}
  for (const [model, value] of Object.entries(raw)) {
    const key = model.trim()
    if (key.length === 0) throw new Error(`config: a modelProfiles key in ${source} must not be empty`)
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`config: modelProfiles[${JSON.stringify(key)}] in ${source} must name a profile`)
    }
    out[key] = value.trim()
  }
  return out
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
    if (key === "profiles") {
      out.profiles = parseProfiles(raw, source)
      continue
    }
    if (key === "modelProfiles") {
      out.modelProfiles = parseModelProfiles(raw, source)
      continue
    }
    if (key === "defaultProfile") {
      if (typeof raw !== "string") throw new Error(`config: defaultProfile in ${source} must be a string`)
      out.defaultProfile = raw.trim().length === 0 ? "" : profileNameOf(raw, source)
      continue
    }
    const coerced = coerceValue(key, raw, source)
    if (coerced !== undefined) out[key] = coerced
  }
  return out as Partial<ResolvedConfig>
}

/**
 * Merge the defaults, the package options, the host options and the user file,
 * in that order.
 *
 * `profiles` and `modelProfiles` are registries, not settings: they merge by
 * name across layers so a user file can add one profile without restating the
 * shipped ones. Every other key is replaced by the most specific layer that
 * sets it. A mapping or a default that names a profile no layer defines is an
 * error - the user asked for a profile that does not exist.
 */
export function resolveConfig(layers: { package?: unknown; options?: unknown; user?: unknown } = {}): ResolvedConfig {
  const config: ResolvedConfig = { ...DEFAULT_CONFIG, profiles: {}, modelProfiles: {} }
  const sources: Array<[unknown, string]> = [
    [layers.package, "package options"],
    [layers.options, "plugin options"],
    [layers.user, "user config"],
  ]
  for (const [layer, source] of sources) {
    const parsed = parseLayer(layer, source)
    if (parsed.profiles !== undefined) Object.assign(config.profiles, parsed.profiles)
    if (parsed.modelProfiles !== undefined) Object.assign(config.modelProfiles, parsed.modelProfiles)
    delete parsed.profiles
    delete parsed.modelProfiles
    Object.assign(config, parsed)
  }
  for (const [model, name] of Object.entries(config.modelProfiles)) {
    if (config.profiles[name] === undefined) {
      throw new Error(`config: modelProfiles[${JSON.stringify(model)}] names profile "${name}", which is not defined`)
    }
  }
  if (config.defaultProfile.length > 0 && config.profiles[config.defaultProfile] === undefined) {
    throw new Error(`config: defaultProfile names profile "${config.defaultProfile}", which is not defined`)
  }
  return config
}

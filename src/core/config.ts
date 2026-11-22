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
  /**
   * Verbatim turns an append-layout compaction keeps, in estimated tokens.
   *
   * The fold is the one step that shrinks the era: it keeps the newest turns
   * that fit this budget and archives the rest, instead of keeping the whole
   * working share and freeing nothing.
   */
  compactKeepTokens: number
  /**
   * Rebuild the retained tail's bytes at an append-layout fold.
   *
   * The fold is the one moment the provider re-reads the tail anyway, so
   * dropping completed-turn reasoning and shortening successful tool results
   * there costs no extra cache. Off by default: measure `rebuildSaved` before
   * trusting it.
   */
  rebuildOnCompaction: boolean
  /**
   * Let the model extend this era's working budget when the pool is near its cap.
   *
   * The grant is clamped by the model window, so a session can never buy itself
   * past the provider's compaction ceiling. Off means the note only offers the
   * checkpoint; the model cannot extend.
   */
  windowExtend: boolean
  /** How much larger the pool becomes on a grant; 1.1..4, rounded to 2dp. */
  windowExtendFactor: number
  /** Percent of the effective pool at which the note offers extend-or-checkpoint; 50..95. */
  windowWarnPercent: number
  /** The divisor used to turn characters into estimated tokens. */
  charsPerToken: number
  /** Manage child (subagent) sessions independently. */
  subagents: boolean
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
  /** Detect a repeating failed turn and append one redirect to the trailing state note. */
  loopGuard: boolean
  /** The shipped loop-guard threshold profile. */
  loopGuardMode: "default" | "aggressive"
  /** Redirects one prompt-turn may receive; the state machine allows one. */
  loopGuardNudges: number
  /** The call-count floor for the over-envelope rule. */
  loopGuardMinCalls: number
  /** Use the learned/history envelope rule in addition to the fixed triggers. */
  loopGuardEnvelope: boolean
  /** Inject learned project facts into the system prefix. */
  projectFacts: boolean
  /** Most facts one rendered block may carry; the renderer clamps to 0..4. */
  projectFactsMaxFacts: number
  /** Estimated-token cap for one rendered block, header included; 0..150. */
  projectFactsMaxTokens: number
  /** Reserved for a paid proposer; not read by the facts modules. */
  projectFactsPropose: boolean
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
  "compactKeepTokens",
  "rebuildOnCompaction",
  "charsPerToken",
  "archiveMaxTurns",
  "archiveMaxChars",
  "parentArchive",
  "expandDigestChars",
  "refs",
  "maxResultChars",
  "windowExtend",
  "windowExtendFactor",
  "windowWarnPercent",
] as const

export type SessionKey = (typeof SESSION_KEYS)[number]

/** One profile's body: a partial config limited to {@link SESSION_KEYS}. */
export type SessionOverrides = Partial<Pick<ResolvedConfig, SessionKey>>

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  memoryTokens: 100_000,
  workingTokens: 200_000,
  compactKeepTokens: 20_000,
  rebuildOnCompaction: false,
  windowExtend: true,
  windowExtendFactor: 2,
  windowWarnPercent: 80,
  charsPerToken: 4,
  subagents: true,
  archiveMaxTurns: 200,
  archiveMaxChars: 400_000,
  parentArchive: true,
  expandDigestChars: 4_000,
  refs: true,
  loopGuard: true,
  loopGuardMode: "default",
  loopGuardNudges: 1,
  loopGuardMinCalls: 20,
  loopGuardEnvelope: true,
  projectFacts: false,
  projectFactsMaxFacts: 4,
  projectFactsMaxTokens: 150,
  projectFactsPropose: false,
  maxResultChars: 4_000,
  manualCommand: true,
  updateCheck: true,
  sidebar: true,
  debug: false,
  profiles: {
    deep: { memoryTokens: 100_000, workingTokens: 200_000 },
  },
  modelProfiles: {},
  defaultProfile: "deep",
}

export const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_CONFIG))

/**
 * Keys a previous release accepted and the append-only layout retired.
 *
 * They are still accepted and dropped, so an old user file or profile body
 * loads instead of failing the strict unknown-key check. `contextLayout` was
 * never a profile key in practice, but it is in the set for symmetry with the
 * two eviction keys.
 */
const LEGACY_KEYS = new Set(["contextLayout", "evictionLead", "autoArchive"])

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
  "rebuildOnCompaction",
  "windowExtend",
  "parentArchive",
  "refs",
  "loopGuard",
  "loopGuardEnvelope",
  "projectFacts",
  "projectFactsPropose",
  "manualCommand",
  "updateCheck",
  "sidebar",
  "debug",
])

const NUMBER_KEYS = new Set([
  "memoryTokens",
  "workingTokens",
  "compactKeepTokens",
  "windowExtendFactor",
  "windowWarnPercent",
  "charsPerToken",
  "archiveMaxTurns",
  "archiveMaxChars",
  "expandDigestChars",
  "maxResultChars",
  "loopGuardNudges",
  "loopGuardMinCalls",
  "projectFactsMaxFacts",
  "projectFactsMaxTokens",
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
    case "compactKeepTokens":
      return Math.max(500, Math.round(raw))
    case "windowExtendFactor":
      return clampInteger(raw * 100, 110, 400) / 100
    case "windowWarnPercent":
      return clampInteger(raw, 50, 95)
    case "charsPerToken":
      return clampInteger(raw * 100, 200, 800) / 100
    case "archiveMaxTurns":
      return clampInteger(raw, 0, 5000)
    case "archiveMaxChars":
      return Math.max(10_000, Math.round(raw))
    case "expandDigestChars":
      return Math.max(500, Math.round(raw))
    case "maxResultChars":
      return Math.max(200, Math.round(raw))
    case "loopGuardNudges":
      return clampInteger(raw, 0, 1)
    case "loopGuardMinCalls":
      return clampInteger(raw, 4, 200)
    case "projectFactsMaxFacts":
      return clampInteger(raw, 0, 4)
    case "projectFactsMaxTokens":
      return clampInteger(raw, 0, 150)
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
 * trade, and a profile is no exception. The retired eviction keys are the one
 * exception: they are dropped so an old profile still loads.
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
      if (LEGACY_KEYS.has(key)) {
        if (key === "contextLayout" && value !== "append") {
          throw new Error(`config: contextLayout in ${where} is no longer supported; append is the only layout`)
        }
        continue
      }
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
    if (LEGACY_KEYS.has(key)) {
      if (key === "contextLayout" && raw !== "append") {
        throw new Error(`config: contextLayout in ${source} is no longer supported; append is the only layout`)
      }
      continue
    }
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
    if (key === "loopGuardMode") {
      if (raw !== "default" && raw !== "aggressive") {
        throw new Error(`config: loopGuardMode in ${source} must be "default" or "aggressive"`)
      }
      out.loopGuardMode = raw
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
  const config: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    profiles: { ...DEFAULT_CONFIG.profiles },
    modelProfiles: {},
  }
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

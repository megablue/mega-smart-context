/**
 * Profiles: one named bundle of per-session settings, chosen by a click or by
 * the model in use.
 *
 * The base config describes the install. A profile describes *this session's*
 * budget: how much memory, how wide the verbatim window, how hard a tool result
 * is eroded, how large the archive may grow. That distinction is what makes a
 * profile safe to switch mid-session - it can never turn off the sidebar or the
 * plugin itself, because those keys are not in `SESSION_KEYS`.
 *
 * Selection is deliberately small and deterministic:
 *
 * 1. a manual pin on the session record (the sidebar's switch);
 * 2. a `modelProfiles` entry for the model of the request;
 * 3. `defaultProfile`;
 * 4. the base config.
 *
 * A pin never expires on its own. Changing the model does not clear it and no
 * timer does either: only choosing auto does, which is what "pin stays until we
 * pick auto" means. The pass stamps `record.lastModel`, so the tool, `/context`
 * and the status RPC - none of which see a request event - re-derive the same
 * automatic choice from the same inputs.
 *
 * Pure: no host import, no clock, no IO.
 *
 * @module mega-smart-context/profiles
 */

import { SESSION_KEYS, type ResolvedConfig, type SessionKey } from "./config.ts"
import { formatTokens } from "./measure.ts"
import type { ModelStamp, ProfilePin, SessionRecord } from "./types.ts"
import { isPlainObject } from "./types.ts"

/** Where the profile in force came from. */
export type ProfileSource = "pin" | "model" | "default" | "base"

/**
 * The profile in force, once `modelProfiles` and `defaultProfile` have been
 * consulted.
 *
 * `name` absent means the base config. `missing` names a pinned profile the
 * config no longer defines: the session still runs on the base, rather than
 * silently switching to some other profile, and every surface can say so.
 */
export interface ProfileChoice {
  readonly name?: string
  readonly source: ProfileSource
  readonly model?: ModelStamp
  readonly missing?: string
}

/**
 * Read the model out of a host event without trusting its shape.
 *
 * A host that names no model leaves `undefined`, which means "keep the last
 * stamp" rather than "forget it": an automatic profile must not flip back to
 * the default because one request arrived without a model.
 */
export function stampModel(model: unknown): ModelStamp | undefined {
  if (!isPlainObject(model)) return undefined
  const id = typeof model.id === "string" ? model.id.trim() : ""
  if (id.length === 0) return undefined
  const providerID = typeof model.providerID === "string" ? model.providerID.trim() : ""
  const variant = typeof model.variant === "string" && model.variant.trim().length > 0 ? model.variant.trim() : undefined
  return { providerID, id, ...(variant === undefined ? {} : { variant }) }
}

/**
 * The `modelProfiles` keys one stamp can match, most specific first.
 *
 * `provider/model#variant` wins over `provider/model`, which wins over a bare
 * model id, so a mapping can pin a thinking budget apart from the same model
 * without one.
 */
export function modelKeys(model: ModelStamp | undefined): string[] {
  if (model === undefined) return []
  const base = model.providerID.length > 0 ? `${model.providerID}/${model.id}` : model.id
  const keys: string[] = []
  if (model.variant !== undefined) keys.push(`${base}#${model.variant}`)
  keys.push(base)
  if (model.providerID.length > 0 && model.variant !== undefined) keys.push(`${model.id}#${model.variant}`)
  if (model.providerID.length > 0 && base !== model.id) keys.push(model.id)
  return keys.filter((key, index) => keys.indexOf(key) === index)
}

/** `provider/model` plus the variant, for a display that names the model. */
export function modelLabel(model: ModelStamp): string {
  const base = model.providerID.length > 0 ? `${model.providerID}/${model.id}` : model.id
  return model.variant === undefined ? base : `${base}#${model.variant}`
}

/** Resolve the profile a session runs on. */
export function chooseProfile(
  config: ResolvedConfig,
  pin: ProfilePin | undefined,
  model: ModelStamp | undefined,
): ProfileChoice {
  if (pin !== undefined) {
    if (pin.mode === "base") return { source: "pin", model }
    if (pin.name !== undefined && config.profiles[pin.name] !== undefined) {
      return { name: pin.name, source: "pin", model }
    }
    // The pin outlived the profile it named (the config was edited). Running the
    // base is the only honest choice; the surfaces report the missing name.
    return { source: "pin", model, ...(pin.name === undefined ? {} : { missing: pin.name }) }
  }
  for (const key of modelKeys(model)) {
    const name = config.modelProfiles[key]
    if (name !== undefined) return { name, source: "model", model }
  }
  if (config.defaultProfile.length > 0 && config.profiles[config.defaultProfile] !== undefined) {
    return { name: config.defaultProfile, source: "default", model }
  }
  return { source: "base", model }
}

/**
 * The config one pass, tool call or command actually uses.
 *
 * A new object only when a profile applies, so a caller that just wants the base
 * pays nothing. The merged fields are the profile's `SESSION_KEYS` on top of the
 * base - shallow on purpose: every value is a scalar.
 */
export function applyProfile(config: ResolvedConfig, choice: ProfileChoice): ResolvedConfig {
  if (choice.name === undefined) return config
  const overrides = config.profiles[choice.name]
  return overrides === undefined ? config : { ...config, ...overrides }
}

/** The same derivation for a stored record, which a later surface can read. */
export function configForRecord(config: ResolvedConfig, record: SessionRecord): ResolvedConfig {
  return applyProfile(config, chooseProfile(config, record.profile, record.lastModel))
}

/**
 * `lean · auto`, `deep · pinned`, `base · pinned`, `base`.
 *
 * One spelling for the sidebar, the dialog, the panel and `/context`, so the
 * four cannot drift apart. Only the name, the source and a missing pin matter,
 * so the bridge's `StatusProfile` (which carries the model as a label) can be
 * passed straight in.
 */
export function choiceLabel(choice: Pick<ProfileChoice, "name" | "source" | "missing">): string {
  if (choice.name === undefined) {
    if (choice.missing !== undefined) return `base · ${choice.missing} is not configured`
    return choice.source === "pin" ? "base · pinned" : "base"
  }
  const how = choice.source === "pin" ? "pinned" : choice.source === "model" ? "auto" : "default"
  return `${choice.name} · ${how}`
}

/** Every named profile, alphabetical so a dialog's rows are stable. */
export function profileNames(config: ResolvedConfig): string[] {
  return Object.keys(config.profiles).sort()
}

const LABELS: Record<SessionKey, string> = {
  memoryTokens: "memory",
  workingTokens: "working",
  charsPerToken: "chars/token",
  evictionLead: "lead",
  autoArchive: "auto-archive",
  archiveMaxTurns: "archive turns",
  archiveMaxChars: "archive chars",
  parentArchive: "parent reads",
  expandDigestChars: "expand",
  refs: "refs",
  maxResultChars: "results",
}

const TOKEN_KEYS = new Set<SessionKey>([
  "memoryTokens",
  "workingTokens",
  "archiveMaxChars",
  "expandDigestChars",
  "maxResultChars",
])

function summaryValue(key: SessionKey, value: number | boolean): string {
  if (typeof value === "boolean") return value ? "on" : "off"
  if (TOKEN_KEYS.has(key)) return formatTokens(value)
  return String(value)
}

/** One line for a dialog row: exactly the keys this profile sets, in a fixed order. */
export function profileSummary(config: ResolvedConfig, name: string): string {
  const overrides = config.profiles[name]
  if (overrides === undefined) return "not configured"
  const parts: string[] = []
  for (const key of SESSION_KEYS) {
    const value = overrides[key]
    if (value === undefined) continue
    parts.push(`${LABELS[key]} ${summaryValue(key, value)}`)
  }
  return parts.length === 0 ? "no overrides" : parts.join(" · ")
}

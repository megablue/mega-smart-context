/**
 * `/context`: the user's read-only window into what the model has written, plus
 * the control actions a user actually needs — force the archive now, purge a turn
 * the model kept by mistake, and resume without adding a user message.
 *
 * This is not a second context-management surface. It prints the same memory the
 * model sees and the same archive the model can recall; the model remains the
 * only writer of the semantic content.
 *
 * @module mega-smart-context/command
 */

import { archivePending, recall } from "./archive.ts"
import type { ResolvedConfig } from "./config.ts"
import { renderStats } from "./prompts.ts"
import {
  choiceLabel,
  chooseProfile,
  configForRecord,
  modelLabel,
  profileNames,
  profileSummary,
} from "./profiles.ts"
import { MEMORY_KEYS } from "./schema.ts"
import type { SessionStore } from "./state.ts"
import { StoreConflictError } from "./state.ts"
import type { ProfilePin, SessionRecord } from "./types.ts"
import { purgeWithUndo } from "./undo.ts"
import { RESUMED_TEXT } from "./view.ts"

export interface CommandDeps {
  readonly store: SessionStore
  readonly config: ResolvedConfig
  /** Deliver text to the session. The adapter maps this to `ctx.session.prompt`. */
  readonly reply: (sessionID: string, text: string) => Promise<void>
  /**
   * Start a model turn with no user message. The adapter maps this to
   * `ctx.session.synthetic` with `resume: true`; the sentence is a tail, so the
   * turn count and any pending eviction are untouched.
   */
  readonly resume?: (sessionID: string, text: string) => Promise<void>
  /** The loaded build's own version, shown by `status`. The adapter reads it. */
  readonly version?: string
  readonly now?: () => number
}

const USAGE =
  "usage: /context [status|now|resume|profile [auto|base|<name>]|memory <key>|recall <query>|purge <turn>]"

/** The profile inventory: what is in force, what could be, and how auto resolves. */
function profileReport(record: SessionRecord, config: ResolvedConfig): string {
  const choice = chooseProfile(config, record.profile, record.lastModel)
  const lines = [
    `profile: ${choiceLabel(choice)}${record.lastModel === undefined ? "" : ` · model ${modelLabel(record.lastModel)}`}`,
  ]
  const names = profileNames(config)
  if (names.length === 0) {
    lines.push("no profiles are configured; add a `profiles` map to mega-smart-context.json")
  } else {
    lines.push("", "profiles:")
    for (const name of names) {
      lines.push(`- ${name}${name === choice.name ? " (in force)" : ""} · ${profileSummary(config, name)}`)
    }
  }
  const mappings = Object.entries(config.modelProfiles).sort(([left], [right]) => left.localeCompare(right))
  if (mappings.length > 0) {
    lines.push("", "model mappings:")
    for (const [model, name] of mappings) lines.push(`- ${model} -> ${name}`)
  }
  lines.push(
    "",
    `defaultProfile: ${config.defaultProfile.length === 0 ? "(none)" : config.defaultProfile}`,
    "auto follows the model mapping, then the default. A pin stays until you pick auto.",
    "set: /context profile auto|base|<name>",
  )
  return lines.join("\n")
}

export async function runContextCommand(sessionID: string, args: string, deps: CommandDeps): Promise<void> {
  const text = args.trim()
  // Fresh: another instance may own the session's last write, and the report the
  // user asked for must be what is stored, not what this instance last saw.
  const record = await deps.store.load(sessionID, { fresh: true })

  if (text.length === 0 || text === "status") {
    await deps.reply(sessionID, renderStats(record, deps.config, deps.version))
    return
  }

  if (text === "now") {
    const now = deps.now?.() ?? Date.now()
    let archived: number
    try {
      archived = await deps.store.mutate(sessionID, (fresh) => {
        const config = configForRecord(deps.config, fresh)
        let count = 0
        for (const pending of [...fresh.pending]) {
          const entry = archivePending(fresh, pending.id, pending.gist, true, {
            now,
            maxTurns: config.archiveMaxTurns,
            maxChars: config.archiveMaxChars,
          })
          if (entry !== undefined) count += 1
        }
        return count
      })
    } catch (error) {
      if (error instanceof StoreConflictError) {
        await deps.reply(sessionID, error.message)
        return
      }
      throw error
    }
    const after = await deps.store.load(sessionID, { fresh: true })
    await deps.reply(
      sessionID,
      `archived ${archived} pending turn(s)\n\n` + renderStats(after, deps.config, deps.version),
    )
    return
  }

  if (text === "resume") {
    if (deps.resume === undefined) {
      await deps.reply(sessionID, "this host has no synthetic channel, so a resume needs a typed message")
      return
    }
    // Sent as a cue, not a prompt: no user row, no new turn, no aged eviction.
    await deps.resume(sessionID, RESUMED_TEXT)
    return
  }

  if (text === "profile" || text.startsWith("profile ")) {
    const arg = text.slice("profile".length).trim()
    if (arg.length === 0) {
      await deps.reply(sessionID, profileReport(record, deps.config))
      return
    }
    const now = deps.now?.() ?? Date.now()
    const names = profileNames(deps.config)
    let pin: ProfilePin | undefined
    if (arg === "auto") pin = undefined
    else if (arg === "base") pin = { mode: "base", at: now }
    else if (names.includes(arg)) pin = { mode: "profile", name: arg, at: now }
    else {
      await deps.reply(sessionID, `unknown profile ${JSON.stringify(arg)}. Profiles: ${names.join(", ") || "none"}`)
      return
    }
    try {
      const label = await deps.store.mutate(sessionID, (fresh) => {
        if (pin === undefined) delete fresh.profile
        else fresh.profile = pin
        return choiceLabel(chooseProfile(deps.config, fresh.profile, fresh.lastModel))
      })
      // The caps move at the next pass, not in the request already in flight.
      await deps.reply(sessionID, `profile ${label} (applies from the next pass)`)
    } catch (error) {
      if (error instanceof StoreConflictError) {
        await deps.reply(sessionID, error.message)
        return
      }
      throw error
    }
    return
  }

  if (text.startsWith("memory ")) {
    const key = text.slice("memory ".length).trim()
    if (!MEMORY_KEYS.has(key)) {
      await deps.reply(sessionID, `unknown memory key ${JSON.stringify(key)}. Keys: ${[...MEMORY_KEYS].join(", ")}`)
      return
    }
    await deps.reply(sessionID, JSON.stringify(record.memory[key as keyof typeof record.memory], null, 2))
    return
  }

  if (text.startsWith("recall ")) {
    const query = text.slice("recall ".length).trim()
    const found = recall(record, query, 10)
    await deps.reply(
      sessionID,
      found.length === 0
        ? `no archived turn matches ${JSON.stringify(query)}`
        : found
            .map((hit) => `- ${hit.entry.id} · ${hit.entry.gist}${hit.entry.messages === undefined ? " (gist only)" : ""}`)
            .join("\n"),
    )
    return
  }

  if (text.startsWith("purge ")) {
    const turn = text.slice("purge ".length).trim()
    // Journaled like the tool's purge: the TUI offers the same action, and a
    // purge that a later /undo cannot restore would be a hole either way.
    try {
      const removed = await deps.store.mutate(sessionID, (fresh) =>
        purgeWithUndo(fresh, turn, deps.now?.() ?? Date.now()),
      )
      await deps.reply(sessionID, removed ? `purged ${turn}` : `no turn ${turn}`)
    } catch (error) {
      // Another instance wrote between the read and the save; it retried once and
      // still lost, so the user hears the truth instead of a silent no-op.
      if (error instanceof StoreConflictError) {
        await deps.reply(sessionID, error.message)
        return
      }
      throw error
    }
    return
  }

  await deps.reply(sessionID, USAGE)
}

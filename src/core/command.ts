/**
 * `/context`: the user's read-only window into what the model has written, plus
 * the two control actions a user actually needs — force the archive now, and
 * purge a turn the model kept by mistake.
 *
 * This is not a second context-management surface. It prints the same memory the
 * model sees and the same archive the model can recall; the model remains the
 * only writer of the semantic content.
 *
 * @module mega-smart-context/command
 */

import { archivePending, purgeTurn, recall } from "./archive.ts"
import type { ResolvedConfig } from "./config.ts"
import { renderStats } from "./prompts.ts"
import { MEMORY_KEYS } from "./schema.ts"
import type { SessionStore } from "./state.ts"

export interface CommandDeps {
  readonly store: SessionStore
  readonly config: ResolvedConfig
  /** Deliver text to the session. The adapter maps this to `ctx.session.prompt`. */
  readonly reply: (sessionID: string, text: string) => Promise<void>
  /** The loaded build's own version, shown by `status`. The adapter reads it. */
  readonly version?: string
  readonly now?: () => number
}

const USAGE = "usage: /context [status|now|memory <key>|recall <query>|purge <turn>]"

export async function runContextCommand(sessionID: string, args: string, deps: CommandDeps): Promise<void> {
  const text = args.trim()
  const record = await deps.store.load(sessionID)

  if (text.length === 0 || text === "status") {
    await deps.reply(sessionID, renderStats(record, deps.config, deps.version))
    return
  }

  if (text === "now") {
    let archived = 0
    for (const pending of [...record.pending]) {
      const entry = archivePending(record, pending.id, pending.gist, true, {
        now: deps.now?.() ?? Date.now(),
        maxTurns: deps.config.archiveMaxTurns,
        maxChars: deps.config.archiveMaxChars,
      })
      if (entry !== undefined) archived += 1
    }
    await deps.store.save(sessionID, record)
    await deps.reply(sessionID, `archived ${archived} pending turn(s)\n\n` + renderStats(record, deps.config, deps.version))
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
    const removed = purgeTurn(record, turn)
    if (removed) await deps.store.save(sessionID, record)
    await deps.reply(sessionID, removed ? `purged ${turn}` : `no turn ${turn}`)
    return
  }

  await deps.reply(sessionID, USAGE)
}

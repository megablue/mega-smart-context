/**
 * mega-smart-context — the model owns the context window.
 *
 * Four contributions, registered from one `setup`:
 *
 * 1. a standing policy stating the contract: the model sees its own memory, a
 *    short verbatim working window, and the current turn — not the transcript;
 * 2. a transform on every request's `context` hook that rebuilds the payload
 *    from the memory document and the turns that fit the working budget;
 * 3. `smart_context`, the tool the model uses to write memory, archive an
 *    evicted turn, or recall one only when it is lost;
 * 4. `/context`, the same state printed for the user.
 *
 * Nothing here edits the durable transcript. Cuts land on turn boundaries, so a
 * `tool-call` is never separated from its `tool-result`. Child sessions are
 * managed independently, keyed by their own session id.
 *
 * @module mega-smart-context
 */

import { runCompaction } from "../../core/compaction.ts"
import { messageOf } from "../../core/types.ts"
import { createContextCommand } from "./command.ts"
import { resolveHostConfig } from "./config.ts"
import { createFsFeatureMap, runContextTransform } from "./context.ts"
import { SessionStore } from "../../core/state.ts"
import { createSmartContextTool } from "./tool.ts"
import type { PluginContext, Registration } from "./types.ts"

export const id = "mega-smart-context"

export async function setup(ctx: PluginContext): Promise<() => Promise<void>> {
  const warn = (line: string): void => {
    try {
      console.error("[" + id + "] " + line)
    } catch {
      // A host without a console still gets the behaviour, not the notes.
    }
  }

  // A bad config throws: the plugin refuses to load rather than silently keeping
  // a default the user believes they replaced.
  const config = resolveHostConfig(ctx, warn)
  if (!config.enabled) return async () => {}

  const store = new SessionStore(ctx.storage, { warn })
  const featureMap = createFsFeatureMap()
  const childCache = new Map<string, boolean>()
  const registrations: Registration[] = []

  registrations.push(
    await ctx.session.hook("context", async (event) => {
      try {
        return await runContextTransform(ctx, event, { store, config, featureMap, childCache, warn })
      } catch (error) {
        // A turn must never break because a pass failed.
        warn("the context pass failed and the request continues: " + messageOf(error))
        return undefined
      }
    }),
  )

  registrations.push(
    await ctx.session.hook("compaction", async (event) => {
      try {
        const outcome = await runCompaction(event, { store, config })
        if (config.debug) warn("compaction: " + (outcome?.owned === true ? "owned" : "declined"))
        return outcome
      } catch (error) {
        // Declining means the host summarizes, which is what would have happened
        // without this plugin at all.
        warn("the compaction pass was declined and the host summarizes: " + messageOf(error))
        return undefined
      }
    }),
  )

  registrations.push(
    await ctx.tool.transform((editor) => {
      editor.add(createSmartContextTool({ store, config, featureMap, root: ctx.location.directory }))
    }),
  )

  if (config.manualCommand) {
    try {
      registrations.push(
        await ctx.command.transform((editor) => {
          editor.add(
            createContextCommand({
              store,
              config,
              reply: async (sessionID, text) => {
                await ctx.session.prompt({ sessionID, text })
              },
            }),
          )
        }),
      )
    } catch (error) {
      // A host without a command registry still gets the tool and the pass.
      warn("the /context command could not be registered: " + messageOf(error))
    }
  }

  return async () => {
    for (const registration of [...registrations].reverse()) {
      try {
        await registration.dispose()
      } catch (error) {
        warn("dispose failed: " + messageOf(error))
      }
    }
  }
}

export default { id, setup }

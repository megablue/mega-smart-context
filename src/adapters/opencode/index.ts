/**
 * mega-smart-context — the model owns the context window.
 *
 * Five contributions, registered from one `setup`:
 *
 * 1. a standing policy stating the contract: the model sees its own memory, a
 *    short verbatim working window, and the current turn — not the transcript;
 * 2. a transform on every request's `context` hook that rebuilds the payload
 *    from the memory document and the turns that fit the working budget;
 * 3. `smart_context`, the tool the model uses to write memory, archive an
 *    evicted turn, or recall one only when it is lost;
 * 4. `/context`, the same state printed for the user;
 * 5. a `session.revert.committed` subscription that rolls the record back with
 *    the transcript, using the journal the pass and the tool keep.
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
import { SessionStore, sameDirectory, StoreConflictError } from "../../core/state.ts"
import { STATUS_RPC, statsOf, type NoticeRequest, type ProfileRequest, type PurgeRequest, type StatsRequest } from "../../core/status.ts"
import { retirePinned } from "../../core/notices.ts"
import { choiceLabel, chooseProfile, profileNames } from "../../core/profiles.ts"
import { purgeWithUndo, queueRevert, revertTarget } from "../../core/undo.ts"
import { createSmartContextTool } from "./tool.ts"
import { readPluginVersion } from "./version.ts"
import { sweepOrphanedSessions } from "./sessions.ts"
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

  const store = new SessionStore(ctx.storage, { warn, directory: ctx.location.directory })
  const featureMap = createFsFeatureMap()
  const childCache = new Map<string, boolean>()
  const registrations: Registration[] = []
  // The build's own version, so `/context status` shows what is loaded.
  const version = readPluginVersion()

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
      editor.add(
        createSmartContextTool({
          store,
          config,
          featureMap,
          root: ctx.location.directory,
          // The parent question is a host fact; a host that will not answer
          // simply has no delegation surface.
          parentOf: async (sessionID) => {
            try {
              const info = await ctx.session.get({ sessionID })
              return typeof info?.parentID === "string" && info.parentID.length > 0 ? info.parentID : undefined
            } catch {
              return undefined
            }
          },
        }),
      )
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
              version,
              reply: async (sessionID, text) => {
                await ctx.session.prompt({ sessionID, text })
              },
              resume: async (sessionID, text) => {
                await ctx.session.synthetic({ sessionID, text, resume: true })
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

  // The TUI half cannot read this half's record: its storage is a separate
  // per-plugin JSON file, not the host's KV. The status dialog, the block and the
  // panel therefore ask over the host's plugin RPC, and these three handlers are
  // the only bridge. A host without the domain, or one whose registry refuses the
  // definition, still gets every other surface; only the TUI reports the gap.
  if (ctx.rpc !== undefined) {
    try {
      registrations.push(
        await ctx.rpc.register(STATUS_RPC, {
          stats: async (input: StatsRequest) => {
            // Fresh on purpose: the host can load this half more than once, and a
            // cached copy from another instance made the block paint a number that
            // stopped being true hours earlier. One KV read per pull is cheap.
            const record = await store.load(input.sessionID, { fresh: true })
            return statsOf(record, config, version, Date.now())
          },
          purge: async (input: PurgeRequest) => {
            try {
              const removed = await store.mutate(input.sessionID, (record) =>
                purgeWithUndo(record, input.turn, Date.now()),
              )
              return removed
                ? { ok: true, text: `purged ${input.turn}` }
                : { ok: false, text: `no turn ${input.turn}` }
            } catch (error) {
              if (error instanceof StoreConflictError) return { ok: false, text: error.message }
              throw error
            }
          },
          notice: async (input: NoticeRequest) => {
            try {
              return await store.mutate(input.sessionID, (record) =>
                retirePinned(record, input.id, Date.now()),
              )
            } catch (error) {
              if (error instanceof StoreConflictError) return { ok: false, text: error.message }
              throw error
            }
          },
          profile: async (input: ProfileRequest) => {
            // The name is checked against the same config every surface reads, so
            // a stale picker row cannot pin a profile that was just removed.
            if (input.mode === "profile" && config.profiles[input.name ?? ""] === undefined) {
              const names = profileNames(config).join(", ") || "none"
              return { ok: false, text: `no profile ${JSON.stringify(input.name)}. Profiles: ${names}` }
            }
            try {
              const label = await store.mutate(input.sessionID, (record) => {
                if (input.mode === "auto") delete record.profile
                else if (input.mode === "base") record.profile = { mode: "base", at: Date.now() }
                else record.profile = { mode: "profile", name: input.name ?? "", at: Date.now() }
                return choiceLabel(chooseProfile(config, record.profile, record.lastModel))
              })
              return { ok: true, text: `profile ${label} (applies from the next pass)` }
            } catch (error) {
              if (error instanceof StoreConflictError) return { ok: false, text: error.message }
              throw error
            }
          },
        }),
      )
    } catch (error) {
      warn("the status RPC could not be registered: " + messageOf(error))
    }
  }

  // `/undo` commits a host revert on the next prompt: the host deletes the
  // boundary message and everything after it, and emits
  // `session.revert.committed` with `{ sessionID, to }`. The record cannot follow
  // that deletion by itself, so the event queues the boundary and the next pass
  // applies it. A host without an event bus leaves the record alone. The loop is
  // disposed with the plugin; a failed subscription never stops the plugin from
  // loading.
  if (ctx.event !== undefined) {
    const abort = new AbortController()
    const events = ctx.event
    const task = (async () => {
      for await (const event of events.subscribe({ signal: abort.signal })) {
        const target = revertTarget(event)
        if (target === undefined) continue
        // The bus is host-wide; records are stamped with the directory that wrote
        // them, so an event from another project is not ours to touch. Sessions
        // are globally unique, so an absent location is safe to accept.
        const directory = event.location?.directory
        if (typeof directory === "string" && !sameDirectory(directory, ctx.location.directory)) continue
        try {
          const queued = await store.mutate(target.sessionID, (record) =>
            queueRevert(record, target.to, Date.now()),
          )
          if (queued && config.debug) warn(`queued undo for ${target.sessionID}: revert to ${target.to}`)
        } catch (error) {
          warn("a committed revert could not be queued: " + messageOf(error))
        }
      }
    })().catch((error) => {
      if (!abort.signal.aborted) warn("the revert subscription stopped: " + messageOf(error))
    })
    registrations.push({
      dispose: async () => {
        abort.abort()
        await task
      },
    })
  }

  // Records outlive the sessions they belong to: the host deletes the row, not
  // the plugin's KV entry. The sweep is deliberately after registration and not
  // awaited, so a slow host lookup never delays the plugin loading.
  void sweepOrphanedSessions(ctx, warn)

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

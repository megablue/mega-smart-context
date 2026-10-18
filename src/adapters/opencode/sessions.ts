/**
 * Session lifecycle facts the host owns: whether a session still exists, and
 * what a failed lookup proves.
 *
 * The plugin's KV entries have no foreign key to the host's session table and
 * the host emits no deletion event, so the only cleanup point is startup. The
 * sweep deletes nothing unless `session.get` says the session is gone; any
 * other failure keeps the record.
 *
 * @module mega-smart-context/adapters/opencode/sessions
 */

import { pruneOrphans, type SessionLiveness } from "../../core/state.ts"
import { isPlainObject, messageOf } from "../../core/types.ts"
import type { PluginContext } from "./types.ts"

/**
 * A not-found answer is the only proof that a record is orphaned.
 *
 * The host throws a tagged `SessionNotFoundError` (`{ _tag, sessionID,
 * message }`) from the promise API; the message check covers a host that
 * reports the same failure as a plain `Error`.
 */
export function livenessFromError(error: unknown): SessionLiveness {
  const tag = isPlainObject(error) && typeof error._tag === "string" ? error._tag : ""
  const text =
    typeof error === "string"
      ? error
      : isPlainObject(error) && typeof error.message === "string"
        ? error.message
        : messageOf(error)
  if (tag === "SessionNotFoundError" || /session not found/i.test(text)) return "gone"
  return "unknown"
}

/** Ask the host whether the session is still there. */
export async function sessionLiveness(ctx: PluginContext, sessionID: string): Promise<SessionLiveness> {
  try {
    await ctx.session.get({ sessionID })
    return "alive"
  } catch (error) {
    return livenessFromError(error)
  }
}

/**
 * Best-effort startup sweep. It runs after the plugin is registered and never
 * throws into `setup`: a storage or host failure must not stop the plugin from
 * loading.
 */
export async function sweepOrphanedSessions(ctx: PluginContext, warn: (line: string) => void): Promise<void> {
  if (ctx.storage === undefined) return
  try {
    const report = await pruneOrphans({
      storage: ctx.storage,
      directory: ctx.location.directory,
      isAlive: (sessionID) => sessionLiveness(ctx, sessionID),
      warn,
    })
    if (report.removed > 0) warn("removed " + report.removed + " orphaned session record(s)")
  } catch (error) {
    warn("the startup sweep failed: " + messageOf(error))
  }
}

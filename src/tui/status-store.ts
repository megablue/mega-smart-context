/**
 * The sidebar's mirror: one pull per session, at most one in flight, bounded.
 *
 * Kept apart from the JSX on purpose. `sidebar.tsx` decides what the block looks
 * like; this file decides when a number is allowed to be asked for. That rule is
 * the part worth testing - a render path that pulls, or a pull that fans out, is
 * invisible in a screenshot and expensive in a long session - so it lives in a
 * plain module the smoke test can drive without a host.
 *
 * @module mega-smart-context/tui/status-store
 */

import { snapshotStale, type StatusSnapshot } from "../core/status.ts"
import type { SidebarStore, StatusClient } from "./context.ts"

/**
 * How many sessions one TUI keeps in the mirror.
 *
 * A session that left the window is only ever one pull away from coming back;
 * what must not happen is a TUI left open for days growing a record per session
 * it ever showed.
 */
export const MAX_SIDEBAR_SESSIONS = 32

/** The ids a write must drop, oldest pull first, to stay inside the bound. */
export function sessionsToDrop(sessions: Record<string, StatusSnapshot>, max = MAX_SIDEBAR_SESSIONS): string[] {
  const ids = Object.keys(sessions)
  if (ids.length <= max) return []
  ids.sort((left, right) => sessions[left].at - sessions[right].at)
  return ids.slice(0, ids.length - max)
}

export interface RefreshOptions {
  /** The typed RPC client, or nothing when this host has no bridge. */
  readonly rpc: () => StatusClient | undefined
  /** The live store, read fresh on every call so the TTL sees the newest pull. */
  readonly store: () => SidebarStore
  readonly mutate: (mutation: (draft: SidebarStore) => void) => Promise<void> | void
  readonly now?: () => number
  readonly maxSessions?: number
}

/**
 * Build the one function the sidebar is allowed to call.
 *
 * It answers immediately (the pull continues in the background) and it is
 * idempotent inside a window: the same session asked twice does nothing the
 * second time unless `force` says a pass just ran. A failed pull keeps the last
 * numbers rather than blanking the block.
 */
export function sidebarRefreshOf(options: RefreshOptions): (sessionID: string, force?: boolean) => Promise<void> {
  const now = options.now ?? Date.now
  const inFlight = new Set<string>()

  return async (sessionID: string, force = false): Promise<void> => {
    if (sessionID.length === 0 || inFlight.has(sessionID)) return
    if (!force && !snapshotStale(options.store().sessions[sessionID], now())) return
    const rpc = options.rpc()
    if (rpc === undefined) return
    inFlight.add(sessionID)
    try {
      const reply = await rpc.stats({ sessionID })
      const at = now()
      await options.mutate((draft) => {
        draft.sessions[sessionID] = { reply, at }
        for (const stale of sessionsToDrop(draft.sessions, options.maxSessions)) delete draft.sessions[stale]
      })
    } catch {
      // The block keeps its last numbers; the next pass forces a retry anyway.
    } finally {
      inFlight.delete(sessionID)
    }
  }
}

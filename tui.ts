/**
 * The TUI half of the plugin: a status dialog, the sidebar block, and one daily
 * check for a newer published version, reported as a toast in the terminal.
 *
 * Why a second entrypoint at all: the server plugin's context has no toast, no
 * client and no notification channel, so it cannot put anything in front of the
 * user on its own. The TUI context can, and this file uses exactly that slice -
 * `options`, `client`, `ui`, `keymap`, `storage`, `data.on`, `theme`. Nothing
 * here touches a request: no payload, no policy, no tokens.
 *
 * The file itself renders no JSX and imports no TUI peer, so a host without the
 * slot API keeps the dialog. The sidebar lives in `src/tui/sidebar.tsx`, is
 * imported dynamically, and its failure to load is caught here.
 *
 * The host resolves `<plugin-root>/tui` before anything else for the TUI side
 * (and `package.json` exports `./tui` for a by-name install), the same way it
 * resolves `server` for the server side. `define` is the identity function, so
 * a bare object is a complete definition; skipping the import keeps `tui.ts`
 * itself free of the TUI peers.
 *
 * @module mega-smart-context/tui
 */

import { readPluginVersion } from "./src/adapters/opencode/version.ts"
import { resolveLayeredConfig } from "./src/adapters/opencode/config.ts"
import { DEFAULT_CONFIG, type ResolvedConfig } from "./src/core/config.ts"
import {
  PURGE_ACTION,
  RESUME_ACTION,
  STATUS_RPC,
  statusRows,
  turnLabel,
  type StatusRow,
  type StatsReply,
} from "./src/core/status.ts"
import { sidebarRefreshOf } from "./src/tui/status-store.ts"
import type {
  KeymapCommand,
  KeymapLayer,
  SelectOption,
  SidebarStore,
  StatusClient,
  ToastOptions,
  ToastVariant,
  TuiContext,
} from "./src/tui/context.ts"
import { messageOf } from "./src/core/types.ts"
import {
  EMPTY_UPDATE_STATE,
  UPDATE_MANIFEST_URL,
  announceVersion,
  dueForCheck,
  parseManifestVersion,
  updateMessage,
  type UpdateState,
} from "./src/core/update.ts"
import { RESUMED_TEXT } from "./src/core/view.ts"

export const id = "mega-smart-context"

/** Key of the durable store, namespaced by the host per plugin. */
const STORE_KEY = "update"

/** The network may hang; a toast is never worth waiting long for. */
const FETCH_TIMEOUT_MS = 4_000

/** Long enough to read, short enough not to sit over the prompt. */
const TOAST_DURATION_MS = 10_000

const TOAST_TITLE = "mega-smart-context update"

/** The dialog and result toasts are about the plugin, not only an update. */
const STATUS_TITLE = "mega-smart-context"

/** A result is read, not studied; the dialog is still open behind it. */
const RESULT_TOAST_MS = 6_000

/** The keymap id is also the config key a user can bind. */
const STATUS_COMMAND = "mega-smart-context.status"

/** The ephemeral store the sidebar renders from; one pull per session, at most. */
const SIDEBAR_STORE_KEY = "sidebar"

/**
 * Whether the sidebar half is drawing. The dialog reports it, because "the block
 * did not appear" is otherwise indistinguishable from "the host never asked".
 */
type SidebarState = "disabled" | "unavailable" | "active"

let sidebarState: SidebarState = "disabled"

/**
 * The three config layers, or the shipped defaults when they do not resolve.
 *
 * A strict merge is what makes `updateCheck:false` in
 * `~/.config/opencode/mega-smart-context.json` bind this half too; a broken
 * file falls back here instead of throwing inside the TUI, where the server
 * plugin's refusal to start is the message that matters.
 */
function configFor(options: unknown): ResolvedConfig {
  try {
    return resolveLayeredConfig(options)
  } catch {
    return DEFAULT_CONFIG
  }
}

/** The session the dialog is about: whatever session route the user is looking at. */
function sessionIDOf(context: TuiContext): string | undefined {
  try {
    const route = context.ui.router.current()
    return route.type === "session" && typeof route.sessionID === "string" ? route.sessionID : undefined
  } catch {
    return undefined
  }
}

/**
 * The typed RPC client, or nothing when this host predates plugin RPC.
 *
 * Building it at command time (not at setup) keeps a host without the domain on
 * every other surface: the update check does not depend on it, and the command
 * reports the gap instead of the plugin failing to load.
 */
function rpcOf(context: TuiContext): StatusClient | undefined {
  try {
    return context.client.rpc(STATUS_RPC)
  } catch {
    return undefined
  }
}

async function alert(context: TuiContext, title: string, message: string): Promise<void> {
  try {
    await context.ui.dialog.alert({ title, message })
  } catch {
    // The TUI is shutting down; a second failed channel is not worth a throw.
  }
}

function resultToast(context: TuiContext, message: string, variant: ToastVariant): void {
  try {
    context.ui.toast.show({
      title: STATUS_TITLE,
      message,
      variant,
      duration: RESULT_TOAST_MS,
    })
  } catch {
    // A toast that cannot be drawn must not take the dialog with it.
  }
}

/** Resume: a synthetic cue, the same channel `/context resume` uses. */
async function resume(context: TuiContext, sessionID: string): Promise<void> {
  try {
    await context.client.session.synthetic({ sessionID, text: RESUMED_TEXT, resume: true })
    resultToast(context, "resumed: one turn with no user message", "info")
  } catch (error) {
    resultToast(context, "resume failed: " + messageOf(error), "error")
  }
}

/** The purge list: pending first, then the archive, each row naming the turn id. */
function purgeOptions(reply: StatsReply): SelectOption<string>[] {
  const row = (place: "pending" | "archive", turn: StatsReply["pending"][number]): SelectOption<string> => ({
    title: turnLabel(turn.gist),
    value: turn.id,
    description: `${place} · ${turn.id}${turn.raw ? " · gist + raw" : " · gist only"}`,
  })
  return [
    ...reply.pending.map((turn) => row("pending", turn)),
    ...reply.archive.map((turn) => row("archive", turn)),
  ]
}

async function openPurge(
  context: TuiContext,
  rpc: StatusClient,
  sessionID: string,
  reply?: StatsReply,
  after?: () => void,
): Promise<void> {
  // Re-read before listing: a pass between opening the dialog and choosing this
  // row could have archived (or purged) a turn, and a stale id would only fail.
  let fresh: StatsReply | undefined = reply
  try {
    fresh = await rpc.stats({ sessionID })
  } catch {
    // The caller's reply is still a truthful list of what the dialog showed.
  }
  if (fresh === undefined) {
    resultToast(context, "the server half did not answer", "error")
    return
  }
  const options = purgeOptions(fresh)
  if (options.length === 0) {
    resultToast(context, "nothing pending or archived", "info")
    return
  }
  let turn: string | undefined
  try {
    turn = await context.ui.dialog.select<string>({
      title: "Purge which turn?",
      placeholder: "type to filter by id or gist",
      options,
    })
  } catch {
    return
  }
  if (turn === undefined) return
  let confirmed: boolean | undefined
  try {
    confirmed = await context.ui.dialog.confirm({
      title: "Purge a turn",
      message: `Remove ${turn} from the record? The transcript is not touched.`,
      label: { confirm: "Purge", cancel: "Keep" },
    })
  } catch {
    return
  }
  if (confirmed !== true) return
  try {
    const result = await rpc.purge({ sessionID, turn })
    resultToast(context, result.text, result.ok ? "info" : "warning")
  } catch (error) {
    resultToast(context, "purge failed: " + messageOf(error), "error")
  }
  // Whether or not the turn was there, the mirror is now one pass behind.
  after?.()
}

/** The dialog's own answer to "did the sidebar block appear?". */
function sidebarRow(): StatusRow {
  if (sidebarState === "active") {
    return {
      title: "sidebar: drawn in the session sidebar",
      value: "",
      description: "a mirror of the last pull; click status, resume or purge there",
      disabled: true,
    }
  }
  return {
    title: sidebarState === "disabled" ? "sidebar: disabled by config" : "sidebar: unavailable in this TUI",
    value: "",
    description:
      sidebarState === "disabled"
        ? "set sidebar:true to show the block"
        : "the slot API or the JSX runtime is missing; the dialog still works",
    disabled: true,
  }
}

/**
 * Open the status dialog: the numbers first (disabled rows, so Enter lands on an
 * action), then Resume and Purge.
 *
 * A pull, not a push: the RPC runs when the command or the sidebar's action row
 * runs, never from render. `after` is how the sidebar learns that the numbers it
 * is showing changed underneath it.
 */
async function openStatus(context: TuiContext, target?: string, after?: () => void): Promise<void> {
  const sessionID = target ?? sessionIDOf(context)
  if (sessionID === undefined) {
    await alert(context, STATUS_TITLE, "Open a session first: the dialog reads that session's record.")
    return
  }
  const rpc = rpcOf(context)
  if (rpc === undefined) {
    await alert(context, STATUS_TITLE, "This host has no plugin RPC bridge, so the dialog cannot read the record.")
    return
  }
  let reply: StatsReply
  try {
    reply = await rpc.stats({ sessionID })
  } catch (error) {
    await alert(context, STATUS_TITLE, "The server half did not answer: " + messageOf(error))
    return
  }
  const rows = statusRows(reply)
  // Above the actions, so it reads as part of the numbers and never steals the
  // selection from Resume.
  const firstAction = rows.findIndex((row) => row.value !== "")
  rows.splice(firstAction < 0 ? rows.length : firstAction, 0, sidebarRow())
  const title = reply.version === undefined ? STATUS_TITLE : `${STATUS_TITLE} v${reply.version}`
  let choice: string | undefined
  try {
    choice = await context.ui.dialog.select<string>({ title, options: rows })
  } catch {
    return
  }
  if (choice === RESUME_ACTION) await resume(context, sessionID)
  else if (choice === PURGE_ACTION) await openPurge(context, rpc, sessionID, reply, after)
}

/**
 * Resume from a click, which is not a dialog choice: ask first, because the cue
 * spends a model turn and a stray click must not.
 */
async function confirmResume(context: TuiContext, sessionID: string): Promise<void> {
  let confirmed: boolean | undefined
  try {
    confirmed = await context.ui.dialog.confirm({
      title: "Resume",
      message: "Send the plugin's resume cue? It starts one turn with no user message.",
      label: { confirm: "Resume", cancel: "Cancel" },
    })
  } catch {
    return
  }
  if (confirmed === true) await resume(context, sessionID)
}

/** The palette command. No default binding: the id is the config key to bind. */
function statusCommand(context: TuiContext): KeymapCommand {
  return {
    id: STATUS_COMMAND,
    title: "Context status",
    description: "memory, working window and archive; resume or purge",
    group: "mega-smart-context",
    palette: true,
    run: () => openStatus(context),
  }
}

async function check(
  context: TuiContext,
  state: UpdateState,
  update: (mutation: (draft: UpdateState) => void) => Promise<void>,
): Promise<void> {
  const now = Date.now()
  if (!dueForCheck(state.checkedAt, now)) return
  const installed = readPluginVersion()
  let latest: string | undefined
  try {
    // No `cache: "no-store"`: the host's fetch typing has no RequestInit.cache.
    // GitHub serves raw files with a five-minute max-age, which a daily check
    // cannot notice.
    const response = await fetch(UPDATE_MANIFEST_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.ok) latest = parseManifestVersion(await response.text())
  } catch {
    // A dead network is not news: the attempt is stamped below and retried
    // tomorrow rather than on every idle turn.
  }
  const announce = announceVersion(installed, latest, state.notified)
  try {
    await update((draft) => {
      draft.checkedAt = now
      if (latest !== undefined) draft.latest = latest
      if (announce !== undefined) draft.notified = announce
    })
  } catch {
    // Losing the record only means one extra check next time.
  }
  // `announceVersion` only answers when both sides are known, so this also
  // narrows `installed` for the message.
  if (announce === undefined || installed === undefined) return
  try {
    context.ui.toast.show({
      title: TOAST_TITLE,
      message: updateMessage(installed, announce),
      variant: "info",
      duration: TOAST_DURATION_MS,
    })
  } catch {
    // A toast that cannot be drawn must not take the TUI with it.
  }
}

/**
 * The session an `session.idle` event is about, or nothing when the event shape
 * is not the one the host documents.
 */
function idleSessionID(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined
  const data = (event as { data?: unknown }).data
  if (typeof data !== "object" || data === null) return undefined
  const sessionID = (data as { sessionID?: unknown }).sessionID
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined
}

/**
 * Start the sidebar half: one ephemeral store, one pull at a time, and the slot
 * claim itself.
 *
 * Every step is optional on purpose. A host without `storage.memory` or `ui.slot`
 * simply has no sidebar; a host whose TUI cannot load this file's JSX (a missing
 * `@opentui/solid` runtime, say) keeps the status dialog, because the import is
 * tried *here* and its failure is caught, not raised from `setup`.
 */
async function startSidebar(context: TuiContext): Promise<() => void> {
  const noop = (): void => {}
  sidebarState = "unavailable"
  if (typeof context.storage.memory !== "function" || typeof context.ui.slot !== "function") return noop

  let slots: typeof import("./src/tui/sidebar.tsx")
  try {
    slots = await import("./src/tui/sidebar.tsx")
  } catch {
    return noop
  }

  let held: readonly [
    SidebarStore,
    (mutation: (draft: SidebarStore) => void) => void,
  ]
  try {
    held = context.storage.memory<SidebarStore>(SIDEBAR_STORE_KEY, { initial: { sessions: {} } })
  } catch {
    return noop
  }
  const [store, mutate] = held

  const refresh = sidebarRefreshOf({
    rpc: () => rpcOf(context),
    store: () => store,
    mutate,
  })

  let release: () => void
  try {
    release = slots.registerSidebar({
      context,
      snapshot: (sessionID) => store.sessions[sessionID],
      refresh,
      actions: {
        status: (sessionID) => {
          void openStatus(context, sessionID, () => refresh(sessionID, true))
        },
        resume: (sessionID) => {
          void confirmResume(context, sessionID)
        },
        purge: (sessionID) => {
          const rpc = rpcOf(context)
          if (rpc === undefined) {
            resultToast(context, "this host has no plugin RPC bridge", "error")
            return
          }
          void openPurge(context, rpc, sessionID, undefined, () => refresh(sessionID, true))
        },
      },
    })
  } catch {
    return noop
  }
  sidebarState = "active"

  // A pass just ran, so the numbers are stale by definition - but only the
  // session that went idle is re-read.
  let off: () => void
  try {
    off = context.data.on("session.idle", (event) => {
      const sessionID = idleSessionID(event)
      if (sessionID !== undefined) refresh(sessionID, true)
    })
  } catch {
    return release
  }

  return () => {
    try {
      off()
    } catch {
      // A listener that cannot be removed is already gone with the host.
    }
    try {
      release()
    } catch {
      // Same for the slot.
    }
  }
}

export async function setup(context: TuiContext): Promise<() => void> {
  const config = configFor(context.options)
  if (!config.enabled) return () => {}

  const stops: Array<() => void> = []

  // Before the config early returns: the dialog is not part of the daily version
  // check, and neither is the sidebar.
  try {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [statusCommand(context)],
    }))
  } catch {
    // A host without a keymap still gets the update check.
  }

  if (config.sidebar) stops.push(await startSidebar(context))
  else sidebarState = "disabled"

  if (config.updateCheck) {
    const [state, update] = context.storage.store<UpdateState>(STORE_KEY, {
      initial: { ...EMPTY_UPDATE_STATE },
    })
    // One check in flight at a time: a burst of idle events must not fan out
    // into parallel requests for the same answer.
    let running = false
    const run = (): void => {
      if (running) return
      running = true
      void check(context, state, update).finally(() => {
        running = false
      })
    }

    run()
    stops.push(context.data.on("session.idle", run))
  }

  return () => {
    for (const stop of stops) {
      try {
        stop()
      } catch {
        // Teardown must not throw into the host.
      }
    }
  }
}

export default { id, setup }

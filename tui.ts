/**
 * The TUI half of the plugin: a status dialog and one daily check for a newer
 * published version, reported as a toast in the terminal.
 *
 * Why a second entrypoint at all: the server plugin's context has no toast, no
 * client and no notification channel, so it cannot put anything in front of the
 * user on its own. The TUI context can, and this file uses exactly that slice -
 * `options`, `client`, `ui`, `keymap`, `storage.store`, `data.on`. Nothing here
 * touches a request: no payload, no policy, no tokens.
 *
 * The dialog is phase 0 of the sidebar plan: no JSX, no `@opentui/solid`, just
 * the host's own `dialog.select` over a portable RPC reply. The sidebar slots
 * render JSX and therefore need the peers; this file deliberately does not.
 *
 * The host resolves `<plugin-root>/tui` before anything else for the TUI side
 * (and `package.json` exports `./tui` for a by-name install), the same way it
 * resolves `server` for the server side. `define` is the identity function, so
 * a bare object is a complete definition; skipping the import keeps the TUI
 * peers (`@opentui/*`, `solid-js`) off this package's typecheck.
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
  type PurgeReply,
  type PurgeRequest,
  type StatsReply,
  type StatsRequest,
} from "./src/core/status.ts"
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

type ToastVariant = "info" | "success" | "warning" | "error"

interface ToastOptions {
  readonly title?: string
  readonly message: string
  readonly variant?: ToastVariant
  readonly duration?: number
}

/** The dialog's select shape, minus the host's generic JSX renderer. */
interface SelectOption<Value> {
  readonly title: string
  readonly value: Value
  readonly description?: string
  readonly disabled?: boolean
}

/** A keymap command, restated without `@opentui/core`'s `KeyEvent`. */
interface KeymapCommand {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly group?: string
  readonly palette?: true
  readonly bind?: false | string
  readonly run: (input?: string, event?: unknown) => void | false | Promise<void>
}

interface KeymapLayer {
  readonly mode?: string
  readonly commands?: readonly KeymapCommand[]
}

/** The RPC client the server half's `STATUS_RPC` hands back. */
interface StatusClient {
  readonly stats: (input: StatsRequest) => Promise<StatsReply>
  readonly purge: (input: PurgeRequest) => Promise<PurgeReply>
}

/**
 * The slice of the TUI context this plugin uses, declared locally.
 *
 * The host's own `Context` type would drag `solid-js`, `@opentui/core` and
 * `@opencode/client` into the typecheck as peers; the runtime contract is small
 * and stable, so it is restated here rather than depended on.
 */
interface TuiContext {
  readonly options: Readonly<Record<string, unknown>>
  readonly storage: {
    store<Value extends object>(
      key: string,
      options: { readonly initial: Value },
    ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
  }
  /**
   * The host client. `rpc` turns a portable definition into a method client over
   * the host's `/api/rpc/<id>/<method>` route; `session.synthetic` is the resume
   * channel (no user message, no turn).
   */
  readonly client: {
    rpc(definition: unknown): StatusClient
    readonly session: {
      synthetic(input: { readonly sessionID: string; readonly text: string; readonly resume?: boolean }): Promise<unknown>
    }
  }
  readonly keymap: {
    layer(factory: () => KeymapLayer): void
  }
  readonly ui: {
    readonly toast: { show(options: ToastOptions): void }
    readonly dialog: {
      alert(options: { readonly title: string; readonly message: string }): Promise<void>
      confirm(options: {
        readonly title: string
        readonly message: string
        readonly label?: { readonly confirm?: string; readonly cancel?: string }
      }): Promise<boolean | undefined>
      select<Value>(options: {
        readonly title: string
        readonly placeholder?: string
        readonly options: readonly SelectOption<Value>[]
      }): Promise<Value | undefined>
    }
    readonly router: {
      current(): { readonly type: string; readonly sessionID?: string }
    }
  }
  readonly data: {
    on(type: "session.idle", handler: (event: unknown) => void): () => void
  }
}

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

async function openPurge(context: TuiContext, rpc: StatusClient, reply: StatsReply, sessionID: string): Promise<void> {
  // Re-read before listing: a pass between opening the dialog and choosing this
  // row could have archived (or purged) a turn, and a stale id would only fail.
  let fresh = reply
  try {
    fresh = await rpc.stats({ sessionID })
  } catch {
    // The original reply is still a truthful list of what the dialog showed.
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
}

/**
 * Open the status dialog: the numbers first (disabled rows, so Enter lands on an
 * action), then Resume and Purge.
 *
 * A pull, not a push: the RPC runs when the command runs, never from render, and
 * the dialog is the only surface phase 0 adds. The sidebar phases would add a
 * store and a listener; this does not.
 */
async function openStatus(context: TuiContext): Promise<void> {
  const sessionID = sessionIDOf(context)
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
  const title = reply.version === undefined ? STATUS_TITLE : `${STATUS_TITLE} v${reply.version}`
  let choice: string | undefined
  try {
    choice = await context.ui.dialog.select<string>({ title, options: statusRows(reply) })
  } catch {
    return
  }
  if (choice === RESUME_ACTION) await resume(context, sessionID)
  else if (choice === PURGE_ACTION) await openPurge(context, rpc, reply, sessionID)
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

export async function setup(context: TuiContext): Promise<() => void> {
  const config = configFor(context.options)
  if (!config.enabled) return () => {}

  // Before the update check's early return: the dialog is not part of the daily
  // version check, and `updateCheck:false` must not remove it.
  try {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [statusCommand(context)],
    }))
  } catch {
    // A host without a keymap still gets the update check.
  }

  if (!config.updateCheck) return () => {}

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
  const off = context.data.on("session.idle", run)
  return () => {
    off()
  }
}

export default { id, setup }

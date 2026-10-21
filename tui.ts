/**
 * The TUI half of the plugin: one daily check for a newer published version,
 * reported as a toast in the terminal.
 *
 * Why a second entrypoint at all: the server plugin's context has no toast, no
 * client and no notification channel, so it cannot put anything in front of the
 * user on its own. The TUI context can, and this file uses exactly that slice -
 * `app`, `options`, `ui.toast.show`, `storage.store`, `data.on`. Nothing here
 * touches a request: no payload, no policy, no tokens.
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
  EMPTY_UPDATE_STATE,
  UPDATE_MANIFEST_URL,
  announceVersion,
  dueForCheck,
  parseManifestVersion,
  updateMessage,
  type UpdateState,
} from "./src/core/update.ts"

export const id = "mega-smart-context"

/** Key of the durable store, namespaced by the host per plugin. */
const STORE_KEY = "update"

/** The network may hang; a toast is never worth waiting long for. */
const FETCH_TIMEOUT_MS = 4_000

/** Long enough to read, short enough not to sit over the prompt. */
const TOAST_DURATION_MS = 10_000

const TOAST_TITLE = "mega-smart-context update"

type ToastVariant = "info" | "success" | "warning" | "error"

interface ToastOptions {
  readonly title?: string
  readonly message: string
  readonly variant?: ToastVariant
  readonly duration?: number
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
  readonly ui: {
    readonly toast: { show(options: ToastOptions): void }
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
  if (!config.enabled || !config.updateCheck) return () => {}

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

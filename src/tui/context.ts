/**
 * The context slice both TUI modules share, declared locally.
 *
 * The host's own `Context` type would drag `solid-js`, `@opentui/core` and
 * `@opencode/client` into the typecheck as peers, and the server half must stay
 * importable without any of them. The runtime contract this plugin uses is small
 * and stable, so it is restated here: `tui.ts` and `src/tui/sidebar.tsx` agree on
 * one declaration instead of drifting apart.
 *
 * Everything here is a *TUI* concept. Nothing in this file reaches a request: no
 * payload, no policy, no tokens.
 *
 * @module mega-smart-context/tui/context
 */

import type { StatusSnapshot, StatsReply } from "../core/status.ts"

export type ToastVariant = "info" | "success" | "warning" | "error"

export interface ToastOptions {
  readonly title?: string
  readonly message: string
  readonly variant?: ToastVariant
  readonly duration?: number
}

/** One row of a `dialog.select`, minus the host's generic JSX renderer. */
export interface SelectOption<Value> {
  readonly title: string
  readonly value: Value
  readonly description?: string
  readonly disabled?: boolean
}

/** A keymap command, restated without `@opentui/core`'s `KeyEvent`. */
export interface KeymapCommand {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly group?: string
  readonly palette?: true
  readonly bind?: false | string
  readonly run: (input?: string, event?: unknown) => void | false | Promise<void>
}

export interface KeymapLayer {
  readonly mode?: string
  readonly commands?: readonly KeymapCommand[]
}

/** The RPC client the server half's `STATUS_RPC` hands back. */
export interface StatusClient {
  readonly stats: (input: { readonly sessionID: string }) => Promise<StatsReply>
  readonly purge: (input: { readonly sessionID: string; readonly turn: string }) => Promise<{ ok: boolean; text: string }>
  readonly notice: (input: { readonly sessionID: string; readonly id: string }) => Promise<{ ok: boolean; text: string }>
}

/** The colours the sidebar paints with; the host owns the actual theme. */
export interface TuiTheme {
  readonly text: {
    readonly base: string
    readonly muted: string
    readonly feedback: {
      readonly error: { readonly base: string }
      readonly warning: { readonly base: string }
    }
  }
}

/** The durable and the ephemeral client-side stores. */
export interface TuiStorage {
  store<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
  memory<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => void]
}

/**
 * The slice of the TUI context this plugin reads.
 *
 * `storage.memory`, `theme` and `ui.slot` are the three phase-1 additions; the
 * rest is what the status dialog and the update toast already used.
 */
export interface TuiContext {
  readonly options: Readonly<Record<string, unknown>>
  readonly storage: TuiStorage
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
  readonly theme: TuiTheme
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
    /** Opens this plugin's session panel; absent on a host without the panel API. */
    readonly panel?: {
      open(name: string, options?: { readonly presentation?: "panel" | "fullscreen" }): boolean
      close(): void
    }
    /** Claims a place in the host's slot tree; returns the release. */
    readonly slot: (claim: unknown) => () => void
  }
  readonly data: {
    on(type: "session.idle", handler: (event: unknown) => void): () => void
  }
}

/** The TUI-side mirror of one session's last reply, shared by the sidebar and the panel. */
export interface SidebarStore {
  sessions: Record<string, StatusSnapshot>
}

/** What the sidebar module needs from its host: the store, a pull, and actions. */
export interface SidebarHost {
  readonly context: TuiContext
  readonly snapshot: (sessionID: string) => StatusSnapshot | undefined
  /** Pull now, unless a fresh snapshot is already held (or one pull is running). */
  readonly refresh: (sessionID: string, force?: boolean) => void
  readonly actions: {
    readonly status: (sessionID: string) => void
    readonly resume: (sessionID: string) => void
    readonly purge: (sessionID: string) => void
  }
}

/** What the panel module needs: the same mirror, plus actions on a named row. */
export interface PanelHost {
  readonly context: TuiContext
  readonly snapshot: (sessionID: string) => StatusSnapshot | undefined
  readonly refresh: (sessionID: string, force?: boolean) => void
  readonly actions: {
    readonly purge: (sessionID: string, turn: string) => void
    readonly retire: (sessionID: string, id: string) => void
    readonly resume: (sessionID: string) => void
    readonly status: (sessionID: string) => void
    readonly close: () => void
  }
}

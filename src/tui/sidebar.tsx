/** @jsxImportSource @opentui/solid */
/**
 * The sidebar block: the numbers of the last pull, drawn inside
 * `sidebar.content`, plus three clickable words that reach the same actions the
 * palette command offers.
 *
 * This is the only file in the plugin that renders JSX, and it is the only one
 * that needs the TUI peers (`@opentui/solid` for the transform, `solid-js` for
 * the primitives). Both are provided by the host at runtime - the pragma above
 * is what makes Bun resolve them for a plugin file that has no `node_modules` of
 * its own - and both are only a *dev* dependency of this package.
 *
 * Everything that decides what the block says lives in `core/status.ts` and is
 * pure: this file maps spans to colours and wires the click targets. It renders
 * from the store `tui.ts` fills; it never calls the RPC itself, because a pull
 * from a render path would turn a repaint into a request.
 *
 * @module mega-smart-context/tui/sidebar
 */

import type { JSX } from "@opentui/solid"
import { For, Show, createEffect, createMemo, on } from "solid-js"
import { sidebarLines, type SidebarLine, type SidebarTone, type StatsReply } from "../core/status.ts"
import type { SidebarHost, TuiContext } from "./context.ts"

/** The one input the host passes to a `sidebar.content` claim. */
interface SidebarClaimInput {
  readonly sessionID: string
}

/**
 * A slot claim, restated without the host's conditional type: one placement key
 * plus a render function. The host throws on a malformed claim, and `tui.ts`
 * treats a throwing registration as "no sidebar".
 */
interface SidebarClaim {
  readonly prepend?: string
  readonly append?: string
  readonly before?: string
  readonly after?: string
  readonly replace?: string
  readonly render: (input: SidebarClaimInput) => JSX.Element
}

/** One theme colour per tone. A host theme that does not resolve paints nothing. */
function toneColor(context: TuiContext, tone: SidebarTone): string | undefined {
  try {
    const text = context.theme.text
    if (tone === "alert") return text.feedback.warning.base
    if (tone === "muted") return text.muted
    return text.base
  } catch {
    return undefined
  }
}

function Line(props: { host: SidebarHost; line: SidebarLine }): JSX.Element {
  return (
    <box flexDirection="row">
      <For each={props.line.spans}>
        {(span) => <text fg={toneColor(props.host.context, span.tone)}>{span.text}</text>}
      </For>
    </box>
  )
}

function Sidebar(props: { host: SidebarHost; sessionID: string }): JSX.Element {
  const snapshot = createMemo(() => props.host.snapshot(props.sessionID))
  const reply = createMemo(() => snapshot()?.reply)
  const muted = (): string | undefined => toneColor(props.host.context, "muted")

  // The one place a session's numbers are asked for. It runs when the claim
  // appears and when the host hands it another session; `refresh` holds the
  // once-per-window rule, so a remount cannot become a request loop.
  createEffect(on(() => props.sessionID, (sessionID) => props.host.refresh(sessionID)))

  return (
    <box flexDirection="column">
      <Show
        when={reply()}
        fallback={<text fg={muted()}>context: waiting for the first pass</text>}
      >
        {(held: () => StatsReply) => (
          <For each={sidebarLines(held())}>
            {(line) => <Line host={props.host} line={line} />}
          </For>
        )}
      </Show>
      <box flexDirection="row" gap={1}>
        <text fg={muted()} onMouseDown={() => props.host.actions.status(props.sessionID)}>
          [status]
        </text>
        <text fg={muted()} onMouseDown={() => props.host.actions.resume(props.sessionID)}>
          [resume]
        </text>
        <text fg={muted()} onMouseDown={() => props.host.actions.purge(props.sessionID)}>
          [purge]
        </text>
      </box>
    </box>
  )
}

/**
 * Claim `sidebar.content` and return the release.
 *
 * `append` makes the block the last item inside the sidebar's scrollable list,
 * so it sits after every section the host and other plugins put there. That is
 * deliberately not `sidebar.footer`: the footer is a fixed strip at the bottom
 * of the panel, outside the list, and the numbers belong in the list.
 */
export function registerSidebar(host: SidebarHost): () => void {
  const claim: SidebarClaim = {
    append: "sidebar.content",
    render: (input) => <Sidebar host={host} sessionID={input.sessionID} />,
  }
  return host.context.ui.slot(claim)
}

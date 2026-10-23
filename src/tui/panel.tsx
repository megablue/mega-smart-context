/** @jsxImportSource @opentui/solid */
/**
 * The session panel: the whole record, drawn in `session.panel`.
 *
 * The panel is the sidebar's opposite on purpose. The sidebar is a glance - two
 * budgets and two counts - while this is the report a user opens when something
 * looks wrong: the budgets, the goal, the pass sparkline, every pending and
 * archived turn with a purge action, the pinned notices with their retire action,
 * and the undo state.
 *
 * Like the sidebar it renders the store `tui.ts` fills and never pulls from
 * render. The one pull it starts is in `createEffect`, and `refresh` holds the
 * in-flight and TTL rules. What it says is decided by `panelSections` in
 * `core/status.ts`, which is pure and testable; this file maps spans to colours
 * and actions to handlers.
 *
 * The claim is `append: "session.panel"` and it renders only when the host hands
 * it our own panel name - the same shape the host's own plugins use, because
 * every plugin's panel claim sees every open panel.
 *
 * @module mega-smart-context/tui/panel
 */

import type { JSX } from "@opentui/solid"
import { For, Show, createEffect, createMemo, on } from "solid-js"
import {
  PANEL_NAME,
  panelSections,
  type PanelAction,
  type PanelRow,
  type PanelSection,
  type StatsReply,
} from "../core/status.ts"
import type { PanelHost } from "./context.ts"
import { toneColor } from "./theme.ts"

/** The input the host passes to every `session.panel` claim. */
interface PanelClaimInput {
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly presentation: "panel" | "fullscreen"
  readonly focused: boolean
  readonly focus: () => void
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

/** A slot claim without the host's conditional type; `tui.ts` catches a throw. */
interface PanelClaim {
  readonly append?: "session.panel"
  readonly render: (input: PanelClaimInput) => JSX.Element
}

function run(host: PanelHost, sessionID: string, action: PanelAction): void {
  if (action.kind === "purge") host.actions.purge(sessionID, action.id)
  else if (action.kind === "retire") host.actions.retire(sessionID, action.id)
  else host.actions.resume(sessionID)
}

function Row(props: { host: PanelHost; sessionID: string; row: PanelRow }): JSX.Element {
  const muted = (): string | undefined => toneColor(props.host.context, "muted")
  return (
    <box flexDirection="row" gap={1}>
      <For each={props.row.spans}>
        {(span) => <text fg={toneColor(props.host.context, span.tone)}>{span.text}</text>}
      </For>
      <Show when={props.row.action}>
        {(action: () => PanelAction) => (
          <text fg={muted()} onMouseDown={() => run(props.host, props.sessionID, action())}>
            [{action().kind}]
          </text>
        )}
      </Show>
    </box>
  )
}

function Section(props: { host: PanelHost; sessionID: string; section: PanelSection }): JSX.Element {
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={toneColor(props.host.context, "title")}>{props.section.title}</text>
      <For each={props.section.rows}>
        {(row) => <Row host={props.host} sessionID={props.sessionID} row={row} />}
      </For>
    </box>
  )
}

function Panel(props: { host: PanelHost; input: PanelClaimInput }): JSX.Element {
  const snapshot = createMemo(() => props.host.snapshot(props.input.sessionID))
  const reply = createMemo(() => snapshot()?.reply)
  const muted = (): string | undefined => toneColor(props.host.context, "muted")

  // The one pull this surface starts. Only when the host opens *our* panel: every
  // plugin's claim sees every open panel, so an unguarded effect would pull once
  // for another plugin's panel too. `refresh` is idempotent inside its window, so
  // the panel and the sidebar sharing a session do not double-fetch.
  createEffect(
    on(
      () => [props.input.name, props.input.sessionID] as const,
      ([name, sessionID]) => {
        if (name === PANEL_NAME) props.host.refresh(sessionID)
      },
    ),
  )

  return (
    <Show when={props.input.name === PANEL_NAME}>
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={toneColor(props.host.context, "title")}>mega-smart-context</text>
          <Show when={reply()?.version}>
            {(version: () => string) => <text fg={muted()}>v{version()}</text>}
          </Show>
          <text fg={muted()}>· the record, not the transcript</text>
        </box>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={1}>
          <Show when={reply()} fallback={<text fg={muted()}>waiting for the first pull…</text>}>
            {(held: () => StatsReply) => (
              <For each={panelSections(held())}>
                {(section) => <Section host={props.host} sessionID={props.input.sessionID} section={section} />}
              </For>
            )}
          </Show>
        </scrollbox>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={muted()} onMouseDown={() => props.host.refresh(props.input.sessionID, true)}>
            [refresh]
          </text>
          <text fg={muted()} onMouseDown={() => props.host.actions.resume(props.input.sessionID)}>
            [resume]
          </text>
          <text fg={muted()} onMouseDown={() => props.host.actions.status(props.input.sessionID)}>
            [dialog]
          </text>
          <text fg={muted()} onMouseDown={() => props.host.actions.close()}>
            [close]
          </text>
        </box>
      </box>
    </Show>
  )
}

/** Claim `session.panel`; every open panel sees the claim, only ours renders. */
export function registerPanel(host: PanelHost): () => void {
  const claim: PanelClaim = {
    append: "session.panel",
    render: (input) => <Panel host={host} input={input} />,
  }
  return host.context.ui.slot(claim)
}

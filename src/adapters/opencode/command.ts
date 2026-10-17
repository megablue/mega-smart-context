/**
 * `/context`, as an OpenCode command definition.
 *
 * The command registry only executes; it does not print. The adapter therefore
 * maps the core's `reply` callback to `ctx.session.prompt`, which is how a
 * command puts text in front of the user on this host.
 *
 * @module mega-smart-context/adapters/opencode/command
 */

import { runContextCommand } from "../../core/command.ts"
import type { ResolvedConfig } from "../../core/config.ts"
import type { SessionStore } from "../../core/state.ts"
import type { CommandDefinition, CommandInvocation } from "./types.ts"

export function createContextCommand(options: {
  readonly store: SessionStore
  readonly config: ResolvedConfig
  readonly reply: (sessionID: string, text: string) => Promise<void>
}): CommandDefinition {
  return {
    name: "context",
    description: "Show or manage the model-owned context",
    execute: async (invocation: CommandInvocation): Promise<void> => {
      const sessionID = String(invocation.sessionID ?? "")
      const text = typeof invocation.prompt?.text === "string" ? invocation.prompt.text : ""
      const args = text.replace(/^\/context\b/, "").trim()
      await runContextCommand(sessionID, args, options)
    },
  }
}

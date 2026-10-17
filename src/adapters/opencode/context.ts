/**
 * The OpenCode-shaped half of the transform: three host-shaped decisions and
 * nothing else.
 *
 * 1. The policy is pushed into `event.system`, deduped by exact text so a
 *    provider prefix cache stays warm.
 * 2. The payload is replaced in `event.messages`; the durable transcript is
 *    never touched.
 * 3. The tool is put on the wire in `event.tools` — the registry is not the
 *    request, and a tool reachable only through `tool.transform` is a tool the
 *    model can never call by name.
 *
 * Child detection lives here because `parentID` is a host fact. The core only
 * receives the resulting boolean through `config.subagents`.
 *
 * @module mega-smart-context/adapters/opencode/context
 */

import { readFile } from "node:fs/promises"
import { resolve, sep } from "node:path"

import type { ResolvedConfig } from "../../core/config.ts"
import { buildPayload, type ContextReport } from "../../core/context.ts"
import { extractSection, normalizePage } from "../../core/refs.ts"
import type { SessionStore } from "../../core/state.ts"
import type { FeatureMapPort } from "../../core/types.ts"
import type { PluginContext, SessionContextEvent } from "./types.ts"
import { TOOL_DESCRIPTION, TOOL_INPUT, TOOL_NAME } from "./tool.ts"

export interface TransformDeps {
  readonly store: SessionStore
  readonly config: ResolvedConfig
  readonly featureMap: FeatureMapPort
  readonly childCache: Map<string, boolean>
  readonly warn: (line: string) => void
}

/**
 * Is this session a child agent's own conversation?
 *
 * `parentID` is present on a subagent's session and absent on a top-level one.
 * The answer is cached because the check costs a host call and parentage never
 * changes. A host that will not answer is treated as one without child
 * sessions, which is the conservative direction: the transform runs.
 */
export async function isChildSession(
  ctx: PluginContext,
  sessionID: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const known = cache.get(sessionID)
  if (known !== undefined) return known
  let child = false
  try {
    const info = await ctx.session.get({ sessionID })
    child = typeof info?.parentID === "string" && info.parentID.length > 0
  } catch {
    child = false
  }
  cache.set(sessionID, child)
  return child
}

/** The session's directory when the host reports one, else the plugin's own. */
export async function directoryOf(ctx: PluginContext, sessionID: string): Promise<string> {
  try {
    const info = await ctx.session.get({ sessionID })
    if (typeof info?.directory === "string" && info.directory.length > 0) return info.directory
  } catch {
    // Fall through to the plugin location.
  }
  return ctx.location.directory
}

/**
 * Read `docs/features/<page>.md` under a session directory and return one
 * section. Any failure is "not found": a reference that cannot be expanded is
 * still a valid pointer, and a broken page must not break the turn.
 */
export function createFsFeatureMap(): FeatureMapPort {
  return {
    async readSection(root, page, section) {
      const normalized = normalizePage(page)
      if (normalized === undefined) return undefined
      const features = resolve(root, "docs", "features")
      const file = resolve(features, normalized)
      if (file !== features && !file.startsWith(features + sep)) return undefined
      let text: string
      try {
        text = await readFile(file, "utf8")
      } catch {
        return undefined
      }
      return extractSection(text, section)
    },
  }
}

export async function runContextTransform(
  ctx: PluginContext,
  event: SessionContextEvent,
  deps: TransformDeps,
): Promise<ContextReport | undefined> {
  const sessionID = typeof event.sessionID === "string" ? event.sessionID : String(event.sessionID ?? "")
  if (sessionID.length === 0) return undefined
  if (!deps.config.subagents && (await isChildSession(ctx, sessionID, deps.childCache))) return undefined

  const plan = await buildPayload(
    {
      sessionID,
      system: event.system,
      messages: event.messages,
      model: event.model,
    },
    { store: deps.store, config: deps.config, warn: deps.warn },
  )

  event.system.splice(0, event.system.length, ...plan.system)
  event.messages.splice(0, event.messages.length, ...plan.messages)
  if (event.tools !== undefined && event.tools !== null) {
    event.tools[TOOL_NAME] = { description: TOOL_DESCRIPTION, input: TOOL_INPUT }
  }

  return plan.report
}

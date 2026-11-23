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
import { buildPayload, modelContextOf, type ContextReport } from "../../core/context.ts"
import type { ProjectSessionDeps } from "../../core/project-session.ts"
import { extractHtmlSection, extractSection, pageCandidates } from "../../core/refs.ts"
import type { SessionStore } from "../../core/state.ts"
import type { FeatureMapPort } from "../../core/types.ts"
import type { PluginContext, SessionContextEvent } from "./types.ts"
import { TOOL_DESCRIPTION, TOOL_INPUT, TOOL_NAME } from "./tool.ts"
import type { ProjectResolver } from "./project.ts"

export interface TransformDeps {
  readonly store: SessionStore
  readonly config: ResolvedConfig
  readonly featureMap: FeatureMapPort
  readonly childCache: Map<string, boolean>
  /** Resolved model windows, keyed `providerID/modelID`, shared across passes. */
  readonly modelWindows?: Map<string, number>
  readonly warn: (line: string) => void
  /**
   * The project-facts resolver, when the host can supply one.
   *
   * A resolver failure is a warning, not a failed turn: the pass continues with
   * no project block and learns nothing this time.
   */
  readonly project?: ProjectResolver
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
 * Read a page under `docs/features/` and return one section. Candidates are
 * tried in order — `.html` before `.md` for a bare page name — and the first
 * one that both exists and holds the section wins, so a map mid-conversion and
 * a map that has dropped its Markdown both resolve. Any failure is "not
 * found": a reference that cannot be expanded is still a valid pointer, and a
 * broken page must not break the turn.
 */
export function createFsFeatureMap(): FeatureMapPort {
  return {
    async readSection(root, page, section) {
      const features = resolve(root, "docs", "features")
      for (const candidate of pageCandidates(page)) {
        const file = resolve(features, candidate)
        if (file !== features && !file.startsWith(features + sep)) continue
        let text: string
        try {
          text = await readFile(file, "utf8")
        } catch {
          continue
        }
        const found = candidate.toLowerCase().endsWith(".html")
          ? extractHtmlSection(text, section)
          : extractSection(text, section)
        if (found !== undefined) return found
      }
      return undefined
    },
  }
}

/** The `{ id, providerID }` reference a context event hands over. */
function modelRefOf(model: unknown): { providerID: string; id: string } | undefined {
  if (typeof model !== "object" || model === null) return undefined
  const value = model as Record<string, any>
  const providerID = typeof value.providerID === "string" ? value.providerID : undefined
  const id =
    typeof value.id === "string"
      ? value.id
      : typeof value.modelID === "string"
        ? value.modelID
        : undefined
  return providerID === undefined || id === undefined ? undefined : { providerID, id }
}

/**
 * Resolve the model's real context window.
 *
 * The context event carries a ModelRef, not the full model record; the host's
 * own model list is the only source of `limit.context`. One call per
 * provider/model is enough, and the cache is shared across passes.
 */
export async function modelWindowOf(
  ctx: { readonly model?: { list?(input?: unknown): Promise<any> } },
  model: unknown,
  cache: Map<string, number>,
): Promise<number | undefined> {
  const direct = modelContextOf(model)
  if (direct !== undefined) return direct
  const ref = modelRefOf(model)
  if (ref === undefined) return undefined
  const key = ref.providerID + "/" + ref.id
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  try {
    const output = await ctx.model?.list?.({})
    const data = Array.isArray(output) ? output : Array.isArray(output?.data) ? output.data : []
    for (const entry of data) {
      const info = entry?.info ?? entry
      if (info?.providerID !== ref.providerID) continue
      if (info?.id !== ref.id && info?.modelID !== ref.id) continue
      const limit = info?.limit?.context
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
        cache.set(key, limit)
        return limit
      }
    }
  } catch {
    // Unknown is safe: the extension refuses instead of guessing.
  }
  return undefined
}

export async function runContextTransform(
  ctx: PluginContext,
  event: SessionContextEvent,
  deps: TransformDeps,
): Promise<ContextReport | undefined> {
  const sessionID = typeof event.sessionID === "string" ? event.sessionID : String(event.sessionID ?? "")
  if (sessionID.length === 0) return undefined
  if (!deps.config.subagents && (await isChildSession(ctx, sessionID, deps.childCache))) return undefined

  // Resolve the project key once per pass. The store and the key are shared by
  // the render and the fold, so a single lookup is also a single source of
  // truth for "which project is this session editing".
  let project: ProjectSessionDeps | undefined
  if (deps.project !== undefined) {
    try {
      project = { store: deps.project.store, key: await deps.project.keyFor(sessionID), warn: deps.warn }
    } catch (error) {
      deps.warn(
        "project key resolution failed for " + sessionID + ": " + (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  const modelContext = await modelWindowOf(ctx, event.model, deps.modelWindows ?? new Map())

  const plan = await buildPayload(
    {
      sessionID,
      system: event.system,
      messages: event.messages,
      model: event.model,
      modelContext,
      tools:
        event.tools === undefined || event.tools === null
          ? undefined
          : Object.keys(event.tools)
              .filter((name) => name !== TOOL_NAME)
              .sort(),
    },
    { store: deps.store, config: deps.config, warn: deps.warn, project },
  )

  event.system.splice(0, event.system.length, ...plan.system)
  event.messages.splice(0, event.messages.length, ...plan.messages)
  if (event.tools !== undefined && event.tools !== null) {
    event.tools[TOOL_NAME] = { description: TOOL_DESCRIPTION, input: TOOL_INPUT }
  }

  return plan.report
}

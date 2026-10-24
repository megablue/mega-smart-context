/**
 * `smart_context`, as the OpenCode registry wants it: the definition envelope
 * around the host-free action logic.
 *
 * Two measured details earn this file its keep:
 *
 * - A registered tool is not an offered tool. The host's request carries the
 *   registry's `codemode: false` entries, so a tool registered without one is
 *   reachable through `execute` but never by name. The `context` hook also puts
 *   this definition into `event.tools` for the same reason.
 * - A result that declares `output` without an output schema comes back to the
 *   model as `Tool result declared output without an output schema` and the call
 *   is lost. This tool returns text content only, so it declares no output.
 *
 * @module mega-smart-context/adapters/opencode/tool
 */

import type { ResolvedConfig } from "../../core/config.ts"
import { runMemoryTool, type MemoryToolRequest } from "../../core/memory-tool.ts"
import type { SessionStore } from "../../core/state.ts"
import type { FeatureMapPort } from "../../core/types.ts"
import type { ToolCallContext, ToolDefinition, ToolResult } from "./types.ts"

export const TOOL_NAME = "smart_context"

export const TOOL_DESCRIPTION = `Manage the session's memory, the document you see instead of replayed history.
Actions:
- read { key? } — print one key, or the whole memory document.
- patch { patch: { goal?, plan?, facts?, files?, decisions?, open?, refs?, notes? } } — merge a patch. Maps merge key by key, lists replace, null resets a key (or deletes one map entry). Unknown keys are dropped; a write over the memory cap is rejected, not trimmed.
- stats — memory, working-window and archive usage.
- ref { page, section, gist } — store a feature-map pointer and report the gist vs section cost.
- archive { turn, gist, keepRaw? } — move a pending turn into the cold archive. Without keepRaw:true the raw messages are discarded and expand can only return the gist.
- purge { turn? | query? } — delete a pending or archived turn, or matching entries.
- recall { query, lost:true, from? } — search the archive. Every term must match, so a phrase with gaps still works. Requires lost:true: use it only when a fact you need is missing. Matches come with a short snippet and its char offset. A subagent may add from:"parent" to search the session that spawned it, so a delegated archive lookup never pulls the raw turns into its caller's window.
- expand { turn, mode?, offset?, limit?, from? } — read an archived or pending turn. A turn evicted from the window but not archived yet is read from the eviction queue, and the reply says so; add keepRaw:true to archive to make that raw durable. It comes back as one honest page sized under the compression limit, ending with "(chars 8000–11980 of 171432; continue with offset:11980)". mode:"outline" lists each part with its offset and size, which is how you find the two pages that matter instead of reading forty. from:"parent" reads the spawning session's archive and names the reply budget your caller can keep.
- notice { remove? } — list the pinned host notices (a mode switch or an output-limit nudge), or retire a superseded one by id. The newest is the live instruction and is refused.`

export const TOOL_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["read", "patch", "stats", "ref", "archive", "purge", "recall", "expand", "notice"],
      description: "What to do. See the tool description for each action.",
    },
    patch: {
      type: "object",
      additionalProperties: true,
      description: "For action:patch. Keys: goal, plan, facts, files, decisions, open, refs, notes.",
    },
    key: { type: "string", description: "For action:read — one memory key." },
    page: { type: "string", description: "For action:ref — a feature-map page (e.g. context-handoff.md)." },
    section: { type: "string", description: "For action:ref — a heading or a fragment of one." },
    gist: { type: "string", description: "For action:ref/archive — your one-line summary." },
    turn: { type: "string", description: "For action:archive/purge/expand — a turn id." },
    remove: {
      type: "string",
      description: 'For action:notice — the id of a superseded notice to drop. The newest is refused.',
    },
    query: { type: "string", description: "For action:recall/purge — a search string. recall matches every term; purge matches the exact phrase." },
    lost: { type: "boolean", description: "For action:recall — set true only when a needed fact is missing." },
    keepRaw: { type: "boolean", description: "For action:archive - keep the raw messages for expand; without it the raw is discarded." },
    limit: { type: "number", description: "For action:recall — maximum matches (default 5). For action:expand — characters on this page (200..20000, default the page setting)." },
    offset: {
      type: "number",
      description: "For action:expand — where the page starts, in characters. Negative counts from the end. Use the offset the footer reports to continue.",
    },
    mode: {
      type: "string",
      enum: ["page", "outline"],
      description: 'For action:expand — "page" (default) reads the turn in pages; "outline" lists each part with its offset and size.',
    },
    from: {
      type: "string",
      enum: ["parent"],
      description: 'For action:recall/expand — read the spawning session\'s archive instead of this session\'s.',
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const

export function createSmartContextTool(options: {
  readonly store: SessionStore
  readonly config: ResolvedConfig
  readonly featureMap?: FeatureMapPort
  readonly root: string
  readonly parentOf?: (sessionID: string) => Promise<string | undefined>
}): ToolDefinition {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    input: TOOL_INPUT as any,
    // The difference between a callable tool and a decoration.
    options: { codemode: false },
    execute: async (args: any, context: ToolCallContext): Promise<ToolResult> => {
      const sessionID = typeof context.sessionID === "string" ? context.sessionID : String(context.sessionID ?? "")
      const raw = (args ?? {}) as Record<string, unknown>
      const request: MemoryToolRequest = {
        sessionID,
        action: raw.action,
        patch: raw.patch,
        key: raw.key,
        page: raw.page,
        section: raw.section,
        gist: raw.gist,
        turn: raw.turn,
        remove: raw.remove,
        query: raw.query,
        lost: raw.lost,
        keepRaw: raw.keepRaw,
        limit: raw.limit,
        offset: raw.offset,
        mode: raw.mode,
        from: raw.from,
      }
      const outcome = await runMemoryTool(request, options)
      return { content: [{ type: "text", text: outcome.text }] }
    },
  }
}

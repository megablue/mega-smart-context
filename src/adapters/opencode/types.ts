/**
 * The host mirrors: the shapes OpenCode hands a plugin, declared locally so the
 * plugin has no runtime dependency on the host's package.
 *
 * Every field that comes from the host is loose on purpose. The host's ids are
 * branded strings and its message parts carry provider extras; a narrower type
 * would be rejected at the seam. The plugin's own values are strict in
 * `src/core/`.
 *
 * @module mega-smart-context/adapters/opencode/types
 */

import type { Message, StoragePort, SystemPart } from "../../core/types.ts"

export type StorageDomain = StoragePort

export interface Registration {
  dispose(): Promise<void>
}

export interface SessionDomain {
  hook(name: string, callback: (event: any) => Promise<unknown> | unknown): Promise<Registration>
  get(input: { sessionID: string }): Promise<{
    readonly parentID?: unknown
    readonly directory?: unknown
    readonly [key: string]: any
  }>
  context(input: { sessionID: string }): Promise<ReadonlyArray<any>>
  prompt(input: { sessionID: string; text: string; delivery?: unknown }): Promise<unknown>
  compact(input: { sessionID: string; delivery?: unknown }): Promise<unknown>
}

export interface ToolCallContext {
  readonly sessionID: any
  readonly agent: any
  readonly messageID: any
  readonly id: any
  readonly signal: AbortSignal
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>
  output?: any
}

export interface ToolDefinition {
  name: string
  description?: string
  input: any
  /**
   * Declared only when the execute result carries `output`. A result that
   * declares output without a schema is rejected by the host, and the call is
   * lost; this plugin returns text content only.
   */
  output?: any
  options?: { codemode?: boolean; pinned?: boolean; permission?: string }
  execute(input: any, context: ToolCallContext): Promise<ToolResult>
}

export interface ToolEditor {
  add(tool: ToolDefinition): void
}

export interface ToolDomain {
  transform(callback: (editor: ToolEditor) => void): Promise<Registration>
  list(): Promise<ReadonlyArray<{ readonly name: string }>>
}

export interface CommandInvocation {
  readonly sessionID: any
  readonly prompt: { readonly text?: string; readonly [key: string]: any }
  readonly delivery?: unknown
}

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  execute(invocation: CommandInvocation): Promise<void>
}

export interface CommandEditor {
  add(definition: CommandDefinition): void
}

export interface CommandDomain {
  transform(callback: (editor: CommandEditor) => void): Promise<Registration>
}

export interface ModelDomain {
  transform(callback: (editor: any) => void): Promise<Registration>
}

/** Everything `setup` is handed. */
export interface PluginContext {
  readonly location: { readonly directory: string; readonly [key: string]: any }
  readonly options: Readonly<Record<string, any>>
  readonly session: SessionDomain
  readonly tool: ToolDomain
  readonly command: CommandDomain
  readonly model?: ModelDomain
  /** Plugin-scoped durable KV. Optional: a host without one degrades to memory. */
  readonly storage?: StorageDomain
}

/** The `context` hook's event: the assembled request, mutable before dispatch. */
export interface SessionContextEvent {
  readonly sessionID: any
  readonly model: any
  readonly agent: any
  system: SystemPart[]
  messages: Message[]
  tools: Record<string, { description: string; input: any }>
  readonly [key: string]: any
}

/** The `compaction` hook's event: set `result` to own the checkpoint. */
export interface CompactionEvent {
  readonly sessionID: any
  readonly model: any
  readonly agent: any
  readonly system: SystemPart[]
  readonly messages: Message[]
  readonly tools: Record<string, any>
  result?: { summary: string; readonly [key: string]: any }
  readonly [key: string]: any
}

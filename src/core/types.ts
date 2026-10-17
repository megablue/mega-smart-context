/**
 * The vocabulary the core reasons about, and the ports a host adapter implements.
 *
 * Nothing here imports OpenCode. A message is a role and a list of parts; a store
 * is four async methods; a feature map is one read. A second agentic host reuses
 * this file unchanged and brings its own mirror.
 *
 * Values that come from the host are typed loosely on purpose: the host's ids are
 * branded strings and its message parts carry provider extras no narrower type
 * would accept. The values this plugin owns — memory, records, config — are strict.
 *
 * @module mega-smart-context/types
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface TextPart {
  readonly type: "text"
  text: string
  readonly [key: string]: any
}

export interface ReasoningPart {
  readonly type: "reasoning"
  text: string
  readonly [key: string]: any
}

/** A call the model made. Paired with its result by `id`. */
export interface ToolCallPart {
  readonly type: "tool-call"
  readonly id: string
  readonly name: string
  input: any
  readonly [key: string]: any
}

export interface ToolResultValue {
  readonly type: string
  value: any
}

export interface ToolResultPart {
  readonly type: "tool-result"
  readonly id: string
  readonly name: string
  result: ToolResultValue
  readonly [key: string]: any
}

export type ContentPart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | { readonly type: string; readonly [key: string]: any }

export interface Message {
  readonly id?: string
  readonly role: string
  content: ContentPart[]
  readonly metadata?: Record<string, unknown>
  readonly [key: string]: any
}

export interface SystemPart {
  readonly type: "text"
  text: string
  readonly [key: string]: any
}

// ---------------------------------------------------------------------------
// Host ports
// ---------------------------------------------------------------------------

/** The plugin-scoped durable KV, as `ctx.storage` hands it over. */
export interface StoragePort {
  get(key: string): Promise<any>
  set(key: string, value: any): Promise<void>
  remove(key: string): Promise<void>
  scan(options: {
    prefix: string
    after?: string
    limit?: number
  }): Promise<{ entries: ReadonlyArray<{ key: string; value: any }>; next?: string }>
}

/**
 * Resolve one section of one feature-map page.
 *
 * The core does not know where `docs/features/` lives; the adapter resolves the
 * page against the session's directory and returns the section text, or
 * `undefined` when the page or the section is absent. Keeping this behind a port
 * is what lets a non-OpenCode host share `refs.ts` unchanged.
 */
export interface FeatureMapPort {
  readSection(root: string, page: string, section: string): Promise<string | undefined>
}

// ---------------------------------------------------------------------------
// The model-owned memory
// ---------------------------------------------------------------------------

export interface PlanStep {
  step: number
  status: "todo" | "active" | "done" | "blocked"
  text: string
}

/** A feature-map pointer plus the model's own one-line gist. */
export interface RefEntry {
  page: string
  section: string
  gist: string
  tokens: number
}

/**
 * The document the model writes. Every key always exists, so the renderer never
 * has to branch on absence; `null` in a patch resets a key to its empty value.
 */
export interface Memory {
  goal: string
  plan: PlanStep[]
  facts: Record<string, string>
  files: Record<string, string>
  decisions: Record<string, string>
  open: string[]
  refs: RefEntry[]
  notes: string
}

// ---------------------------------------------------------------------------
// Durable per-session state
// ---------------------------------------------------------------------------

/** A turn that left the working window and is waiting for archive-or-purge. */
export interface PendingTurn {
  id: string
  gist: string
  chars: number
  messages: Message[]
  createdAt: number
  /** How many new user turns have started since this turn was evicted. */
  age: number
}

/** A turn the model chose to keep, as a gist and optionally the raw messages. */
export interface ArchivedTurn {
  id: string
  gist: string
  chars: number
  createdAt: number
  messages?: Message[]
}

/** The last context pass's measurements, so `/context` can show them later. */
export interface LastReport {
  memoryTokens: number
  workingTokens: number
  totalTokens: number
  workingTurns: number
  droppedTurns: number
  overBudget: boolean
  modelContext?: number
}

export interface SessionRecord {
  version: 1
  memory: Memory
  /** Turn ids that were in the working window on the previous pass. */
  seenTurns: string[]
  pending: PendingTurn[]
  archive: ArchivedTurn[]
  lastReport?: LastReport
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

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

/**
 * A host-injected notice, kept verbatim and pinned.
 *
 * The host admits a mode switch as a synthetic *user* message carrying a
 * `<system-reminder>` block, and an output-limit nudge the same way, not as a
 * system part. Counting either as a turn inflates the working window and ages a
 * pending turn on something the model never said. The plugin strips it from the
 * window instead and stores the text here, so the standing instruction survives
 * every pass and the model can retire a superseded one.
 */
export interface Notice {
  /**
   * The id of the *newest* host message this text arrived under.
   *
   * The host emits one row per mode switch but re-emits the same two texts, and
   * a window holds every past row, so the id is refreshed on each pass to the
   * last occurrence in the transcript — that is what tells a genuinely new
   * emission from a stale copy still sitting in the window.
   */
  id: string
  /** The notice text, verbatim up to a head-keep bound, with a truncation marker. */
  text: string
  /** When the plugin first recorded this text (`Date.now()`); never moves. */
  at: number
}

/**
 * A notice the model retired, kept so the pass cannot re-add it.
 *
 * Retiring an id is not enough on its own: the window holds every past row of
 * the same text, so a stale occurrence would re-add it under an older id. The
 * text is stored beside the id, and the retirement holds only while the text's
 * newest occurrence is still that generation. A genuinely new emission of the
 * same text arrives under a new id, which clears the retirement and lets the
 * live instruction back in.
 */
export interface RetiredNotice {
  /** The occurrence id the text was retired at. */
  id: string
  /** The retired text, so a stale window copy cannot resurrect it. */
  text: string
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * One pending turn as it stood at the start of a journaled turn.
 *
 * The raw messages are deliberately absent: a pending turn that is still pending
 * already holds them, and one the pass auto-archived still has them in the
 * archive. The undo restores from whichever list can still supply them, which
 * keeps this snapshot a few hundred bytes instead of a second copy of the turn.
 */
export interface PendingSnapshot {
  readonly id: string
  readonly gist: string
  readonly chars: number
  readonly createdAt: number
  readonly age: number
}

/** A notice the model retired during a turn, with where it sat in `notices`. */
export interface NoticeSnapshot {
  readonly notice: Notice
  readonly index: number
}

/** A turn the model purged during a turn, kept whole so the undo can put it back. */
export interface PurgedSnapshot {
  readonly list: "pending" | "archive"
  readonly index: number
  readonly entry: PendingTurn | ArchivedTurn
}

/**
 * One turn's inverse journal.
 *
 * The journal is what makes the memory reversible: the record only ever holds the
 * current document, so an undo can only restore a value that was captured before
 * the write. One entry exists per turn, created by that turn's first pass with
 * the pending state as it stood *before* the pass mutated anything; the memory
 * and notice fields fill lazily, and only the *first* previous value per key is
 * kept (a key written twice in one turn still rolls back to the turn's start).
 *
 * Bounded by `MAX_UNDO_TURNS` and `MAX_UNDO_CHARS`; the oldest whole entry goes
 * first, because a partial entry would restore a mix of two turns.
 */
export interface UndoEntry {
  /** The user turn this entry belongs to; `""` when no pass had run yet. */
  turn: string
  /** When the entry was created (`Date.now()`). */
  at: number
  /** `pending` as it stood at the turn's first pass, before anything was evicted. */
  pending?: PendingSnapshot[]
  /** Top-level memory key -> its value before the turn's first write to that key. */
  memory?: Record<string, unknown>
  /** Notices the model retired this turn, oldest first. */
  notices?: NoticeSnapshot[]
  /** Pending and archived turns the model purged this turn (raw included). */
  purged?: PurgedSnapshot[]
}

/**
 * A committed host revert waiting for the next pass to apply it.
 *
 * The event only names the boundary; the rollback itself runs inside the pass so
 * it sees the record under the same ordering as every other mutation.
 */
export interface RevertMark {
  /** The boundary message id; the host deleted this row and everything after it. */
  to: string
  /** When the plugin heard about it (`Date.now()`). */
  at: number
}

/** What the last applied undo changed, for `/context` and the debug line. */
export interface LastUndo {
  /** The boundary the host reverted to. */
  turn: string
  /** When the rollback was applied (`Date.now()`). */
  at: number
  /** How many distinct memory keys were restored. */
  memory: number
  /** How many journal entries were unwound. */
  turns: number
  /** How many pending/archive entries were dropped because they belonged to the span. */
  dropped: number
  /** Pending turns the undo could not restore because their raw messages were gone. */
  lost: number
  /**
   * The turn that was current when the undo applied. The memory-block line is
   * shown for that turn only; a later turn clears it.
   */
  seen?: string
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
  /**
   * Tokens in the request's own system parts that this plugin did not write.
   *
   * The host assembles its instruction set (`core/instructions` and the rest) into
   * `event.system`, which the plugin sees but counts in no budget. This is that
   * size, display only — it never moves a cap. Optional: a record measured before
   * the field existed, or a context where `event.system` carries no such part, has
   * none.
   */
  hostSystemTokens?: number
  /** How many host system parts `hostSystemTokens` covers. */
  hostSystemParts?: number
}

/**
 * One context pass's measurements, including the disabled-plugin baseline.
 *
 * `lastReport` is a single snapshot, overwritten on every pass. A `PassSample`
 * is that snapshot plus the counterfactual: what the whole durable transcript
 * would have cost with the plugin disabled, recorded at the one moment both
 * sides are exact. The samples make the answer a curve, not a point.
 *
 * The transcript side is a *character* count (`messagesChars`), not tokens: a
 * disabled plugin sends the transcript verbatim, so its size is measured exactly
 * rather than through the estimate the other fields use. Divide by
 * `charsPerToken` to compare it with `totalTokens`.
 */
export interface PassSample {
  /** When the pass ran (`Date.now()`). */
  at: number
  /** The current turn's id, when the window kept one. */
  turn?: string
  /** `messagesChars(input.messages)` — characters a disabled plugin would send. */
  transcriptTokens: number
  /** The POLICY part we add, in estimated tokens. */
  policyTokens: number
  /** The pinned-notices part we add, in estimated tokens. `0` when there is none. */
  noticeTokens?: number
  /**
   * The request's own system parts that this plugin did not write, in estimated
   * tokens, and how many parts that is. Display only: no budget uses it.
   */
  hostSystemTokens?: number
  hostSystemParts?: number
  memoryTokens: number
  workingTokens: number
  /** memory + working + policy, in estimated tokens. */
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
  /** One sample per context pass, oldest first, bounded by `MAX_HISTORY`. */
  history?: PassSample[]
  /**
   * Host-injected notices, oldest first, deduped by exact text.
   *
   * A mode reminder or the output-limit nudge. Pinned into the request's system
   * parts rather than the working window, so a mode switch cannot evict a turn or
   * churn the provider prefix. Order is recency: a text the host re-emits moves to
   * the end, so the last entry is the live instruction the rail refuses to remove.
   * Bounded by `MAX_NOTICES`, oldest dropped first. Optional: a record written
   * before the field existed has none.
   */
  notices?: Notice[]
  /**
   * Notices the model retired but whose text is still in the host's window.
   *
   * Kept so the next pass does not re-add a stale occurrence of the same text.
   * Bounded by `MAX_RETIRED`; an entry clears itself when the text is emitted
   * again under a new id. Optional: absent until the first retirement.
   */
  retired?: RetiredNotice[]
  /**
   * A committed host revert waiting for the next pass, or absent.
   *
   * Only `session.revert.committed` writes it; a staged-then-cleared `/redo`
   * never does, so a cancelled undo leaves the record untouched.
   */
  revert?: RevertMark
  /** One inverse entry per recent turn, oldest first, bounded. */
  undo?: UndoEntry[]
  /** What the last applied undo changed. Cleared on the next user turn. */
  lastUndo?: LastUndo
  /**
   * The plugin instance's directory when this record was last written.
   *
   * The KV is shared by every project the host has opened, so the startup
   * sweep needs this to tell "mine" from "another project's". Records written
   * before the field existed have none; they are still swept, because a
   * not-found answer from the host is proof the session is gone regardless of
   * where it lived.
   */
  directory?: string
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

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
 * One user instruction captured verbatim from a turn.
 *
 * A directive is not model-written memory: the runtime copies the sentence that
 * carried it so a "remember" or "don't" survives the window and a compaction.
 * The model may clear it once the rule is folded into `decisions`.
 */
export interface Directive {
  /** Stable key: the turn id plus the sentence index. */
  id: string
  /** The user turn that carried the sentence. */
  turn: string
  /** The user's sentence, verbatim and bounded by the capture cap. */
  text: string
  /** When it was captured. */
  at: number
}

/**
 * The document the model writes. Every key always exists, so the renderer never
 * has to branch on absence; `null` in a patch resets a key to its empty value.
 */
export interface Memory {
  goal: string
  /** User instructions the runtime captured verbatim; cleared once folded. */
  directives: Directive[]
  plan: PlanStep[]
  facts: Record<string, string>
  files: Record<string, string>
  decisions: Record<string, string>
  open: string[]
  refs: RefEntry[]
  notes: string
}

/**
 * One accepted memory patch, attached to the turn that wrote it.
 *
 * The patch is the delta the model asked for, with unknown keys and invalid
 * entries already removed. A map value is partial: it names only the entries
 * that changed, and `null` inside it means the entry was deleted. A list or a
 * string carries its full new value. `record.memory` remains the merged
 * document; this is the append-only record the request renders.
 */
export interface MemoryUpdate {
  /** The turn that wrote the patch; empty when the tool ran outside a turn. */
  turn: string
  /** When the patch was accepted (`Date.now()`). */
  at: number
  /** The accepted delta, keyed by `Memory` key. */
  patch: Record<string, unknown>
}

/**
 * A pending append-only compaction, set by the tool or by the pool.
 *
 * `requested` folds on the next pass: the model asked, so it has already
 * written what it wanted to keep. `due` is a commit window, not an order to
 * fold at once — the mark records the turn it was raised in, every pass of that
 * same turn keeps the window open (the real context window has room the
 * estimated pool does not), and the fold runs on the first pass whose current
 * turn is newer: the next prompt.
 */
export interface CompactMark {
  mode: "requested" | "due"
  at: number
  /**
   * The current turn when a `due` mark was raised. Absent on `requested` marks
   * and on records written before the field existed; a `due` mark without it
   * folds on the next over-cap pass, as it always did.
   */
  turn?: string
}

/**
 * A working-window extension granted for this era.
 *
 * The model asks for it when the pool is near its cap and the current unit is
 * not safe to cut. The grant stores absolute caps rather than a multiplier, so
 * a later config or profile change cannot silently move the ceiling. Absent
 * until the model asks; cleared by the fold that ends the era.
 */
export interface WindowExtension {
  at: number
  /** The turn that asked for the extension. */
  turn: string
  /** The model's one-line reason, shown back in the state note. */
  reason: string
  /** The pool cap before the grant, in estimated tokens. */
  fromCap: number
  /** The pool cap the grant bought, in estimated tokens, clamped by the model window. */
  toCap: number
  /** `toCap / fromCap`, rounded, for display. */
  factor: number
}

/** A host compaction the plugin observed, and the turns it preserved first. */
export interface HostCompact {
  at: number
  /** Turns archived by this compaction. */
  turns: number
  /** The archive size after it, for the note. */
  archived: number
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
 * An original tool result shortened in the outbound request.
 *
 * The request carries a marker with this entry's id instead of the full value;
 * `smart_context action:"raw"` pages the original back on demand. `chars` is the
 * original length, so a page can say what it is missing even when `text` was
 * capped for storage.
 */
export interface RawResult {
  id: string
  tool: string
  chars: number
  text: string
  createdAt: number
  /** True when `text` holds a prefix because the original exceeded the store cap. */
  truncated?: boolean
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
  /**
   * When the plugin first saw the newest occurrence of this text.
   *
   * It moves only when a new host message carries the text, so the heading dates
   * the live emission rather than the first one, and a re-run over the same
   * transcript still lands on the same bytes.
   */
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

/**
 * The model a pass ran with, in the host's own terms.
 *
 * `providerID` is optional because a host that names only the model still gets
 * a usable stamp: a bare id is a valid `modelProfiles` key.
 */
export interface ModelStamp {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/**
 * A manual profile choice for one session.
 *
 * Absent means auto: the model mapping and then the default profile decide.
 * `profile` pins a named bundle and `base` pins the plain config; neither is
 * cleared by a model change, only by choosing auto.
 */
export interface ProfilePin {
  readonly mode: "profile" | "base"
  /** The profile name; present only with `mode:"profile"`. */
  readonly name?: string
  readonly at: number
}

/** One normalized call+error pair the loop guard has seen repeat in a turn. */
export interface LoopGuardRepeat {
  /** How many completed calls carried this exact call fingerprint and error signature. */
  count: number
  /** The normalized error signature, bounded and human-readable. */
  signature: string
  /** The call in one short label, e.g. `bash npm test` or `edit src/a.ts`. */
  label: string
}

/**
 * The loop guard's compact state for the newest prompt-turn.
 *
 * It is a fold of completed tool calls, not a transcript: counters, two bounded
 * maps and one stored redirect. On a new user turn the counters reset and a
 * green turn's call count is folded into `samples`, the session-local envelope
 * history. `normalizeLoopGuard` in `loopguard.ts` clamps everything read back
 * from storage.
 */
export interface LoopGuardState {
  version: 1
  /** The id of the newest user turn this state belongs to. */
  turn: string
  /** Completed tool calls folded in this turn. */
  calls: number
  /** Completed calls whose result was a failure. */
  failures: number
  /** Edit-like calls (edit/write/create/apply_patch/...) plus shell edits into source files. */
  edits: number
  /** Verification calls (test/build/typecheck/lint/check) in this turn. */
  verifications: number
  /** 1-based call index of the latest edit and the latest verification. */
  lastEditCall: number
  lastVerifyCall: number
  /** The edit count in place when the latest verification ran. */
  editsAtVerify: number
  /** Whether the latest verification call succeeded. */
  lastVerifyOk: boolean
  /** Failures whose normalized error signature had been seen before in this turn. */
  repeated: number
  /** The latest repeated signature and call label, for the redirect's wording. */
  repeatedSignature?: string
  repeatedLabel?: string
  /** Read-like calls (read/view/grep/glob/...). */
  reads: number
  /** New-file writes (write/create), whether or not the target existed. */
  newFiles: number
  /** Error signature -> occurrence count, bounded by MAX_LOOP_GUARD_SIGNATURES. */
  errorSigs: Record<string, number>
  /** Call fingerprint + signature -> repeat entry, bounded by MAX_LOOP_GUARD_SIGNATURES. */
  repeatKeys: Record<string, LoopGuardRepeat>
  /** Whether this turn already received its one redirect. */
  redirected: boolean
  /** Why the redirect fired, when it did. */
  redirectReason?: "repeat" | "failures" | "edits" | "envelope"
  /** The call count when the redirect fired. */
  redirectAt?: number
  /** The rendered redirect, kept so two passes over the same turn are byte-identical. */
  redirectText?: string
  /** Completed call counts of earlier green turns, oldest first, bounded. */
  samples: number[]
}

/**
 * The project-facts block snapshotted for one session.
 *
 * The first pass renders the project record once and keeps these bytes; every
 * later pass reuses `rendered`, so a fact learned mid-session reaches the next
 * session rather than changing a prefix the provider has already cached.
 */
export interface ProjectFactsSnapshot {
  version: 1
  /** The normalized project root the snapshot was rendered for. */
  key: string
  /** The fact ids included in `rendered`, for injection accounting. */
  ids: string[]
  /** The exact system block, empty when no fact was injectable. */
  rendered: string
  /** Estimated tokens of `rendered`, header included. */
  tokens: number
  /** Render time, ms since epoch. */
  at: number
}

export interface ToolUsageCursor {
  /** The completed turn whose calls were folded into project tool usage. */
  turn: string
  /** Fold time, ms since epoch. */
  at: number
}

export interface SessionRecord {
  version: 1
  memory: Memory

  /**
   * The mode the host's agent names, written every pass from `event.agent`.
   *
   * The tail note reads this before it falls back to a pinned notice: the mode
   * belongs to the request, not to a transcript message that can age out of the
   * window. Absent when the session runs on an agent that is neither Plan nor
   * Build.
   */
  mode?: "plan" | "build"
  /**
   * The checkpoint the append-only layout renders first.
   *
   * `memory` is always the merged document, so `read`, `stats` and undo keep
   * working without replaying the log. `base` is the same document as of the
   * last compaction; together with `updates` it is what the request carries.
   * Absent on a snapshot-layout record, and on an append record before its
   * first migration (the pass then sets it to `memory`).
   */
  base?: Memory
  /**
   * Accepted patches since `base`, oldest first.
   *
   * One entry per turn is the common case: repeated patches in the same turn
   * coalesce. The request renders each entry after its turn; compaction folds
   * them into `base` and clears the list.
   */
  updates?: MemoryUpdate[]
  /**
   * The first turn kept in the append-only working window.
   *
   * The window grows from this turn to the newest one until compaction. It is
   * seeded from the first pass's ordinary window, so enabling the layout
   * mid-session does not replay a history the plugin never managed.
   */
  windowStart?: string
  /** The project-facts block rendered on the first pass of this session. */
  projectFacts?: ProjectFactsSnapshot
  /** The newest completed turn whose observations were folded into the project. */
  factsFolded?: string
  /** The newest completed turn folded into project tool usage. */
  toolsFolded?: ToolUsageCursor
  /** Tool names offered at the last pass, sorted and bounded; status/usage only. */
  offeredTools?: string[]
  /** A compaction the next pass must perform, or a `due` note waiting for that pass. */
  compact?: CompactMark
  /** A working-window extension for this era, granted by the model. */
  ext?: WindowExtension
  /** The host's latest checkpoint, when the plugin preserved the turns it replaced. */
  hostCompact?: HostCompact
  /** Directives evicted by the cap; rendered so the loss is visible. */
  directivesDropped?: number
  /** Cleared directives, keyed by turn and sentence, so capture does not re-add them. */
  directivesDismissed?: string[]
  /**
   * Turn ids whose bytes are rebuilt: reasoning dropped, successful write/edit
   * results replaced with a short confirmation, long shell output tail-cut.
   *
   * Stored as ids rather than bytes, so every pass re-derives the same result
   * from the raw transcript. Set at a fold when `rebuildOnCompaction` is on; the
   * current turn is never in the set.
   */
  rebuilt?: string[]
  /** Characters the last fold's rebuild removed, for the measurement. */
  rebuildSaved?: number
  /** Turn ids that were in the working window on the previous pass. */
  seenTurns: string[]
  pending: PendingTurn[]
  archive: ArchivedTurn[]
  /**
   * Originals for tool results shortened in the request, keyed by marker id.
   *
   * Bounded by `mergeRaw`; absent until the first erosion, so a record written
   * before the field existed stays valid.
   */
  raw?: Record<string, RawResult>
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
   * A manual profile choice for this session, or absent for auto.
   *
   * Neither kind of pin expires on its own: only choosing auto clears it, so a
   * model change cannot silently undo the user's pick.
   */
  profile?: ProfilePin
  /**
   * The model the last pass ran with.
   *
   * The tool, `/context` and the status RPC have no request event, so they
   * re-derive an automatic profile from this stamp. A pass that names no model
   * leaves the previous stamp alone rather than guessing.
   */
  lastModel?: ModelStamp
  /**
   * The loop guard's compact state for the newest prompt-turn.
   *
   * Absent until the first pass with a completed tool call, and left in place
   * when the guard is disabled so re-enabling it folds the turn from the raw
   * transcript rather than starting a second nudge. Bounded and normalized by
   * `normalizeLoopGuard`.
   */
  guard?: LoopGuardState
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

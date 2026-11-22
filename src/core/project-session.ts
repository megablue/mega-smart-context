/**
 * The projector between a session record and the durable project record.
 *
 * The two directions are deliberately separate operations:
 *
 * - `ensureProjectFacts` renders the project's injectable facts once per
 *   session and snapshots the exact bytes on the session record. Every later
 *   pass reuses the snapshot, so a fact learned mid-session reaches the next
 *   session rather than changing a prefix the provider has already cached.
 * - `foldProjectFacts` learns from completed turns only. The live turn is never
 *   folded: its tool results are what the model is waiting for, and a turn whose
 *   result has not arrived is an intention, not evidence.
 *
 * Both functions are no-ops when the feature is off or the host supplied no
 * project resolver, and both treat project-storage failures as diagnostics: a
 * learned fact must never break a turn.
 *
 * @module mega-smart-context/project-session
 */

import type { ResolvedConfig } from "./config.ts"
import { markInjected, renderFacts } from "./facts.ts"
import { extractObservations, foldObservations } from "./facts-learn.ts"
import type { ProjectKey, ProjectStore } from "./project.ts"
import type { Message, SessionRecord } from "./types.ts"
import { turnSpans } from "./view.ts"

export interface ProjectSessionDeps {
  readonly store: ProjectStore
  readonly key: ProjectKey
  readonly now?: () => number
  readonly warn?: (line: string) => void
}

/**
 * Return the session's project-facts block, rendering and snapshotting it on the
 * first pass.
 *
 * The snapshot is written even when the block is empty: "this session has
 * already looked" is the condition that keeps a project render off every pass,
 * and the next session has a fresh record to render into.
 */
export async function ensureProjectFacts(
  record: SessionRecord,
  deps: ProjectSessionDeps | undefined,
  config: ResolvedConfig,
): Promise<string> {
  if (!config.projectFacts || deps === undefined) return ""
  if (record.projectFacts !== undefined) return record.projectFacts.rendered

  const now = deps.now ?? (() => Date.now())
  let rendered: ReturnType<typeof renderFacts>
  try {
    const project = await deps.store.load(deps.key, { fresh: true })
    rendered = renderFacts(project, {
      maxFacts: config.projectFactsMaxFacts,
      maxTokens: config.projectFactsMaxTokens,
    })
  } catch (error) {
    deps.warn?.("project facts could not be rendered: " + messageOf(error))
    return ""
  }

  if (rendered.ids.length > 0) {
    try {
      await deps.store.mutate(deps.key, (project) => {
        markInjected(project, rendered.ids)
      })
    } catch (error) {
      // Injection accounting is diagnostics, not context: the block still ships.
      deps.warn?.("project facts could not be marked injected: " + messageOf(error))
    }
  }

  record.projectFacts = {
    version: 1,
    key: deps.key.key,
    ids: [...rendered.ids],
    rendered: rendered.text,
    tokens: rendered.tokens,
    at: now(),
  }
  return rendered.text
}

/**
 * Fold the newest completed turn's observed tool outcomes into the project.
 *
 * The newest turn is the live one and is skipped. Only one previous turn is
 * folded per pass and there is no backfill: a turn that left the window before
 * it could be folded is history, not evidence this pass can use.
 */
export async function foldProjectFacts(
  record: SessionRecord,
  messages: ReadonlyArray<Message>,
  deps: ProjectSessionDeps | undefined,
  sessionID: string,
  config: ResolvedConfig,
): Promise<void> {
  if (!config.projectFacts || deps === undefined) return

  const spans = turnSpans(messages)
  if (spans.length < 2) return
  const span = spans[spans.length - 2]
  if (span === undefined || record.factsFolded === span.id) return

  const slice = messages.slice(span.startIdx, span.endIdx + 1)
  const observations = extractObservations(slice, { sessionID, turnID: span.id })
  const now = deps.now ?? (() => Date.now())
  try {
    await deps.store.mutate(deps.key, (project) =>
      foldObservations(project, observations, {
        sessionID,
        turnID: span.id,
        now: now(),
      }),
    )
  } catch (error) {
    // Leave the mark unset so the next pass can retry; the turn is still there.
    deps.warn?.("project facts could not be folded: " + messageOf(error))
    return
  }
  record.factsFolded = span.id
}

/** The message from an unknown thrown value, without depending on its type. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

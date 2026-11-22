/**
 * The host's compaction seam, owned with the same memory document the model
 * already maintains.
 *
 * When the host asks for a checkpoint summary, returning `renderMemory()` means
 * the summary and the model's working record cannot disagree: there is one
 * document, and it is the one the model wrote. An empty document is not a
 * summary, so the plugin declines and lets the host summarize — returning an
 * empty block would erase the checkpoint in the name of owning it.
 *
 * Owning the summary is not enough on its own: the host also replaces the
 * transcript with that summary, so any turn still in the working window would
 * disappear without ever reaching the archive. Before the summary is returned,
 * every turn in `event.messages` that the cold store does not already know is
 * archived with its raw messages, because the transcript the model just saw is
 * the only copy that will exist after the host discards it.
 *
 * A host compaction ends the working-window era: the window start, the pending
 * fold, the extension, the rebuild marks and `seenTurns` all describe a
 * transcript that is about to be replaced, so keeping any of them would make the
 * next pass try to evict or archive turns that no longer exist. `hostCompact`
 * records what the seam did, for the state note and for diagnosis.
 *
 * @module mega-smart-context/compaction
 */

import { charsOfMessages, mechanicalGist, trimArchive, turnMessages } from "./archive.ts"
import type { ResolvedConfig } from "./config.ts"
import { renderMemory } from "./prompts.ts"
import { isMemoryEmpty } from "./schema.ts"
import type { SessionStore } from "./state.ts"
import type { ArchivedTurn, Message, SystemPart } from "./types.ts"
import { turnSpans } from "./view.ts"

export interface CompactionEventLike {
  readonly sessionID?: unknown
  readonly system?: SystemPart[]
  readonly messages?: Message[]
  result?: { summary: string; readonly [key: string]: any }
  [key: string]: any
}

export interface CompactionDeps {
  readonly store: SessionStore
  readonly config: ResolvedConfig
}

export interface CompactionOutcome {
  /** Whether the plugin replaced the host's summary with the memory document. */
  readonly owned: boolean
  /** How many turns this compaction appended to the archive. */
  readonly archived: number
}

export async function runCompaction(
  event: CompactionEventLike,
  deps: CompactionDeps,
): Promise<CompactionOutcome | undefined> {
  const sessionID = typeof event.sessionID === "string" ? event.sessionID : String(event.sessionID ?? "")
  if (sessionID.length === 0) return undefined

  const messages = event.messages ?? []
  const now = Date.now()

  const outcome = await deps.store.mutate(sessionID, (record) => {
    const known = new Set<string>([
      ...record.archive.map((entry) => entry.id),
      ...record.pending.map((entry) => entry.id),
    ])

    let appended = 0
    for (const span of turnSpans(messages)) {
      if (known.has(span.id)) continue
      const raw = turnMessages(messages, span)
      const entry: ArchivedTurn = {
        id: span.id,
        gist: mechanicalGist(span, deps.config.charsPerToken),
        chars: charsOfMessages(raw),
        createdAt: now,
        messages: raw,
      }
      record.archive.push(entry)
      known.add(span.id)
      appended += 1
    }
    trimArchive(record, deps.config.archiveMaxTurns, deps.config.archiveMaxChars)

    // The host is replacing the transcript this era was built from.
    delete record.windowStart
    delete record.compact
    delete record.ext
    delete record.rebuilt
    delete record.rebuildSaved
    record.seenTurns = []
    record.hostCompact = { at: now, turns: appended, archived: record.archive.length }

    return {
      appended,
      summary: isMemoryEmpty(record.memory) ? undefined : renderMemory(record),
    }
  })

  if (outcome.summary === undefined) return { owned: false, archived: outcome.appended }
  event.result = { summary: outcome.summary }
  return { owned: true, archived: outcome.appended }
}

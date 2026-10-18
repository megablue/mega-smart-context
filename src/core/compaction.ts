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
 * @module mega-smart-context/compaction
 */

import type { ResolvedConfig } from "./config.ts"
import { renderMemory } from "./prompts.ts"
import { isMemoryEmpty } from "./schema.ts"
import type { SessionStore } from "./state.ts"
import type { Message, SystemPart } from "./types.ts"

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
  readonly owned: boolean
}

export async function runCompaction(
  event: CompactionEventLike,
  deps: CompactionDeps,
): Promise<CompactionOutcome | undefined> {
  const sessionID = typeof event.sessionID === "string" ? event.sessionID : String(event.sessionID ?? "")
  if (sessionID.length === 0) return undefined
  const record = await deps.store.load(sessionID)
  if (isMemoryEmpty(record.memory)) return undefined
  event.result = { summary: renderMemory(record) }
  return { owned: true }
}

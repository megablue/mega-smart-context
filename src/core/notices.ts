/**
 * Retiring a pinned host notice, shared by every surface that can do it.
 *
 * The model retires through `smart_context action:"notice"`, and the user can do
 * the same from the TUI's panel over the status RPC. Both must apply exactly the
 * same rule - the newest notice is the live instruction and is refused - so the
 * rule lives here instead of in either caller.
 *
 * @module mega-smart-context/notices
 */

import { retireNotice } from "./state.ts"
import type { SessionRecord } from "./types.ts"
import { captureNotice } from "./undo.ts"

export interface RetireOutcome {
  readonly ok: boolean
  readonly text: string
}

/**
 * Retire the notice with this id.
 *
 * The journal capture happens before the removal, so `/undo` can pin it back. A
 * refusal changes nothing: not the journal, not the notices, not the retired
 * list.
 */
export function retirePinned(record: SessionRecord, id: string, now: number): RetireOutcome {
  const notices = record.notices ?? []
  if (id === notices[notices.length - 1]?.id) {
    return {
      ok: false,
      text:
        `${id} is the newest notice, the live instruction, and cannot be removed. ` +
        "A newer notice retires it; until then it stays pinned.",
    }
  }
  const entry = notices.find((notice) => notice.id === id)
  if (entry === undefined) {
    const ids = notices.map((notice) => notice.id).join(", ") || "none"
    return { ok: false, text: `no pinned notice ${JSON.stringify(id)}. Pinned: ${ids}` }
  }
  captureNotice(record, entry, notices.findIndex((candidate) => candidate.id === id), now)
  record.notices = notices.filter((notice) => notice.id !== id)
  record.retired = retireNotice(record.retired ?? [], entry)
  return {
    ok: true,
    text:
      `removed pinned notice ${id}\n` +
      "It stays retired while its text is still in the window; the host emitting it again under a new id returns it.",
  }
}

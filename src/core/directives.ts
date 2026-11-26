/**
 * Mechanical capture of user instructions.
 *
 * A directive is the user's sentence, copied verbatim: no paraphrase, no merge.
 * The matcher keeps precision over recall - the model can clear a wrong entry,
 * but it cannot recover a sentence the runtime never kept.
 *
 * @module mega-smart-context/directives
 */

import type { Directive, Message, SessionRecord } from "./types.ts"
import { isRealUser, textOf } from "./view.ts"

/** How many instructions one session keeps; the oldest is dropped past this. */
export const MAX_DIRECTIVES = 16

/** The per-entry character cap. A sentence, not a paragraph. */
export const MAX_DIRECTIVE_CHARS = 240

/** How many cleared directives stay suppressed. */
export const MAX_DIRECTIVES_DISMISSED = 64

/** The key that identifies one turn's copy of a sentence. */
export function directiveKey(turn: string, text: string): string {
  return `${turn}|${normalized(text)}`
}

/**
 * The explicit instruction markers. Deliberately narrow: "use", "avoid" and a
 * bare "no" occur in ordinary prose, and every false directive costs attention
 * on every pass it survives.
 */
const MARKER = /\b(?:remember|do not forget|don't forget|from now on|never|always|do not|don't|must|make sure)\b/i

const HOST_BLOCK = /<(?:system-update|system-reminder|smart-context)[^>]*>[\s\S]*?<\/(?:system-update|system-reminder|smart-context)>/gi
const FENCED = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g
const SPLIT = /(?<=[.!?;])\s+|\n+/

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase()
}

/** The sentences in one user message that state a standing instruction. */
export function directivesIn(text: string): string[] {
  const clean = text.replace(HOST_BLOCK, " ").replace(FENCED, " ").replace(INLINE_CODE, " ")
  const out: string[] = []
  for (const raw of clean.split(SPLIT)) {
    const sentence = raw.replace(/\s+/g, " ").trim()
    if (sentence.length < 6) continue
    if (sentence.endsWith("?")) continue
    if (!MARKER.test(sentence)) continue
    out.push(sentence.slice(0, MAX_DIRECTIVE_CHARS))
  }
  return out
}

/**
 * Add the directives carried by these messages. Idempotent: the normalized
 * sentence is the key, so the several passes of one turn add nothing twice.
 *
 * The cap keeps the newest entries. A drop is counted on the record so the
 * renderer can name the loss instead of hiding it.
 *
 * @returns how many entries were added.
 */
export function captureDirectives(
  record: SessionRecord,
  messages: ReadonlyArray<Message>,
  now: number,
): number {
  const memory = record.memory
  if (!Array.isArray(memory.directives)) memory.directives = []
  const seen = new Set(memory.directives.map((entry) => normalized(entry.text)))
  const dismissed = new Set(record.directivesDismissed ?? [])
  let added = 0
  for (const message of messages) {
    if (!isRealUser(message)) continue
    const turn = message.id ?? ""
    directivesIn(textOf(message)).forEach((text, index) => {
      const key = normalized(text)
      if (seen.has(key) || dismissed.has(directiveKey(turn, text))) return
      seen.add(key)
      memory.directives.push({ id: `${turn}:${index}`, turn, text, at: now })
      added += 1
    })
  }
  if (memory.directives.length > MAX_DIRECTIVES) {
    const dropped = memory.directives.length - MAX_DIRECTIVES
    const evicted = memory.directives.slice(0, dropped)
    memory.directives = memory.directives.slice(dropped)
    record.directivesDropped = (record.directivesDropped ?? 0) + dropped
    // A capped entry must not be re-captured on the next pass; the turn plus
    // sentence is the dismissal key, so a later turn may still raise it again.
    const dismissed = new Set(record.directivesDismissed ?? [])
    for (const entry of evicted) dismissed.add(directiveKey(entry.turn, entry.text))
    record.directivesDismissed = [...dismissed].slice(-MAX_DIRECTIVES_DISMISSED)
  }
  return added
}

/** Every directive's normalized text, for a caller that checks coverage. */
export function directiveKeys(directives: ReadonlyArray<Directive>): Set<string> {
  return new Set(directives.map((entry) => normalized(entry.text)))
}

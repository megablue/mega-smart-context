/**
 * Raw tool-result store and the stable marker id.
 *
 * A result too large to replay is shortened in the request, but its original
 * stays in the session record under a content-addressed id. The marker in the
 * shortened result carries that id, and `smart_context action:"raw"` pages the
 * original back. Nothing here touches the context layout: the store is bounded,
 * per session, and only read by the tool.
 *
 * @module mega-smart-context/raw
 */

import type { RawResult } from "./types.ts"
import { isPlainObject } from "./types.ts"

/** How long an original stays retrievable. */
export const RAW_TTL_MS = 86_400_000

/** How many originals one session keeps. */
export const RAW_MAX_ENTRIES = 64

/** How many characters all originals in one session may hold. */
export const RAW_MAX_CHARS = 1_000_000

/** The per-entry storage cap; `chars` still reports the original length. */
export const RAW_MAX_ENTRY_CHARS = 1_000_000

/** The part of a raw result the view computes; the store adds `createdAt`. */
export interface RawDraft {
  readonly id: string
  readonly tool: string
  readonly chars: number
  readonly text: string
}

/**
 * A stable id for (tool, original text).
 *
 * FNV-1a over the UTF-16 code units. It is deliberately not a security hash:
 * the id names one entry in this session's store, not a public content address.
 * Twelve hex characters keep the marker short while making a collision within
 * one session's bounded store vanishingly unlikely.
 */
export function rawId(tool: string, text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const input = tool + "\u0000" + text
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return "r_" + hash.toString(16).padStart(16, "0").slice(0, 12)
}

function normalizeEntry(value: unknown): RawResult | undefined {
  if (!isPlainObject(value)) return undefined
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined
  const tool = typeof value.tool === "string" ? value.tool : undefined
  const text = typeof value.text === "string" ? value.text : undefined
  const chars =
    typeof value.chars === "number" && Number.isFinite(value.chars)
      ? Math.max(0, Math.trunc(value.chars))
      : undefined
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : undefined
  if (id === undefined || tool === undefined || text === undefined || chars === undefined || createdAt === undefined) {
    return undefined
  }
  return { id, tool, chars, text, createdAt, ...(value.truncated === true ? { truncated: true } : {}) }
}

/** Coerce a stored map; a malformed entry is dropped, not trusted. */
export function normalizeRaw(value: unknown): Record<string, RawResult> | undefined {
  if (!isPlainObject(value)) return undefined
  const out: Record<string, RawResult> = {}
  for (const key of Object.keys(value)) {
    const entry = normalizeEntry(value[key])
    if (entry !== undefined && entry.id === key) out[key] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Merge this pass's drafts and trim the store.
 *
 * Newest wins; entries past `RAW_TTL_MS` are dropped, then the oldest entries
 * are shed until the count and character caps hold. The newest entry is always
 * kept, even when it alone exceeds the character cap, because the marker the
 * model just saw must resolve.
 */
export function mergeRaw(
  current: Record<string, RawResult> | undefined,
  drafts: Iterable<RawDraft>,
  now: number,
): Record<string, RawResult> {
  const next: Record<string, RawResult> = { ...(current ?? {}) }
  for (const draft of drafts) {
    const text = draft.text.length > RAW_MAX_ENTRY_CHARS ? draft.text.slice(0, RAW_MAX_ENTRY_CHARS) : draft.text
    next[draft.id] = {
      id: draft.id,
      tool: draft.tool,
      chars: draft.chars,
      text,
      createdAt: now,
      ...(text.length < draft.text.length ? { truncated: true } : {}),
    }
  }
  const fresh = Object.values(next)
    .filter((entry) => now - entry.createdAt <= RAW_TTL_MS)
    .sort((left, right) => right.createdAt - left.createdAt)
  const kept: RawResult[] = []
  let chars = 0
  for (const entry of fresh) {
    if (kept.length >= RAW_MAX_ENTRIES) break
    if (kept.length > 0 && chars + entry.text.length > RAW_MAX_CHARS) continue
    kept.push(entry)
    chars += entry.text.length
  }
  return Object.fromEntries(kept.map((entry) => [entry.id, entry]))
}

/** One page of an original, with the offset the next call should use. */
export interface RawPage {
  readonly text: string
  readonly offset: number
  readonly next?: number
}

export function rawPage(entry: RawResult, options: { offset?: number; limit: number }): RawPage {
  const offset = Math.max(0, Math.min(entry.text.length, Math.trunc(options.offset ?? 0)))
  const limit = Math.max(200, Math.trunc(options.limit))
  const end = Math.min(entry.text.length, offset + limit)
  return {
    text: entry.text.slice(offset, end),
    offset,
    ...(end < entry.text.length ? { next: end } : {}),
  }
}

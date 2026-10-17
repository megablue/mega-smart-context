/**
 * Token estimation and budget arithmetic.
 *
 * The host hands a plugin no token meter. Every number this plugin prints or
 * enforces is therefore an estimate at `charsPerToken` (4 by default), and every
 * surface says "estimated" rather than pretending to a precision it does not
 * have. A real tokenizer would still be model-specific: Claude, GPT and Gemini
 * disagree about the same text. A conservative divisor plus visible headroom is
 * more honest than a wrong exact number.
 *
 * @module mega-smart-context/measure
 */

import type { ContentPart, Memory, Message, SystemPart } from "./types.ts"

/** Characters in a value, whether the host handed a string or a structure. */
export function charsOf(value: unknown): number {
  if (typeof value === "string") return value.length
  if (value === undefined || value === null) return 0
  try {
    return JSON.stringify(value).length
  } catch {
    return String(value).length
  }
}

/** Estimated tokens for a character count. Never negative, never fractional. */
export function estimateTokens(chars: number, charsPerToken: number): number {
  const divisor = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : 4
  return Math.max(0, Math.ceil(chars / divisor))
}

/** Characters one content part contributes to the request. */
export function partChars(part: ContentPart): number {
  if (part.type === "text" || part.type === "reasoning") {
    return typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text.length
      : 0
  }
  if (part.type === "tool-call") {
    const call = part as { name?: unknown; input?: unknown }
    return charsOf(call.name) + charsOf(call.input)
  }
  if (part.type === "tool-result") {
    const result = part as { name?: unknown; result?: { value?: unknown } }
    return charsOf(result.name) + charsOf(result.result?.value)
  }
  return charsOf(part)
}

/** Characters one message contributes, over every part. */
export function messageChars(message: Message): number {
  let total = 0
  for (const part of message.content ?? []) total += partChars(part)
  return total
}

export function messagesChars(messages: ReadonlyArray<Message>): number {
  let total = 0
  for (const message of messages) total += messageChars(message)
  return total
}

export function systemChars(system: ReadonlyArray<SystemPart>): number {
  let total = 0
  for (const part of system) total += charsOf(part.text)
  return total
}

/** The memory document's approximate size, used for the write-time cap check. */
export function memoryChars(memory: Memory): number {
  return charsOf(memory)
}

/** `12345` -> `12.3k`, `999` -> `999`. One decimal, because the numbers are estimates. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 100_000) return (tokens / 1000).toFixed(1).replace(/\.0$/, "") + "k"
  return Math.round(tokens / 1000) + "k"
}

/** Clamp a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Feature-map references: a pointer plus a gist, and the comparison that decides
 * whether the pointer is actually cheaper than the prose it replaces.
 *
 * The rule the model is given is "whichever takes fewer words". This module
 * makes that concrete: given the gist and the section text, it reports both
 * token costs, so the model can store the pointer when the section is longer
 * than the gist and inline the section when it is not. The pointer itself is
 * cheap (`page#section`); the gist is the model's own one-liner.
 *
 * @module mega-smart-context/refs
 */

import { estimateTokens } from "./measure.ts"

/** Resolve a page argument to a path under `docs/features/`. */
export function normalizePage(page: string): string | undefined {
  const cleaned = page.trim().replace(/\\/g, "/")
  if (cleaned.length === 0) return undefined
  if (cleaned.includes("..")) return undefined
  const withoutRoot = cleaned.startsWith("docs/features/") ? cleaned.slice("docs/features/".length) : cleaned
  if (withoutRoot.length === 0) return undefined
  return withoutRoot.endsWith(".md") ? withoutRoot : withoutRoot + ".md"
}

function headingOf(line: string): { level: number; text: string } | undefined {
  const match = /^(#{1,6})\s+(.*)$/.exec(line)
  if (match === null) return undefined
  return { level: match[1].length, text: match[2].trim() }
}

/**
 * Extract one section from a feature page.
 *
 * A section is matched by exact heading first, then by case-insensitive
 * substring, so `how-why` and `How & why` both resolve. The returned text
 * includes the heading and stops at the next heading of the same or a higher
 * level. `undefined` means the page or the section is absent — never an empty
 * string, which would read as a real zero-cost section.
 */
export function extractSection(markdown: string, section: string): string | undefined {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  const wanted = section.trim().toLowerCase()
  if (wanted.length === 0) return undefined

  let found = -1
  let level = 0
  for (let index = 0; index < lines.length; index += 1) {
    const heading = headingOf(lines[index])
    if (heading === undefined) continue
    if (heading.text.toLowerCase() === wanted) {
      found = index
      level = heading.level
      break
    }
    if (found < 0 && heading.text.toLowerCase().includes(wanted)) {
      found = index
      level = heading.level
    }
  }
  if (found < 0) return undefined

  const body: string[] = [lines[found]]
  for (let index = found + 1; index < lines.length; index += 1) {
    const heading = headingOf(lines[index])
    if (heading !== undefined && heading.level <= level) break
    body.push(lines[index])
  }
  return body.join("\n").trim()
}

export interface RefVerdict {
  readonly gistTokens: number
  readonly sectionTokens: number
  readonly useRef: boolean
  readonly saving: number
  readonly found: boolean
}

/** Compare a gist with the section it points at. */
export function refVerdict(gist: string, sectionText: string | undefined, charsPerToken: number): RefVerdict {
  const gistTokens = estimateTokens(gist.trim().length, charsPerToken)
  if (sectionText === undefined) {
    return { gistTokens, sectionTokens: 0, useRef: true, saving: 0, found: false }
  }
  const sectionTokens = estimateTokens(sectionText.length, charsPerToken)
  return {
    gistTokens,
    sectionTokens,
    useRef: sectionTokens > gistTokens,
    saving: Math.max(0, sectionTokens - gistTokens),
    found: true,
  }
}

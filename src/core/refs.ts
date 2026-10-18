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

/**
 * Resolve a page argument to candidate paths under `docs/features/`, best first.
 *
 * A page may be written with or without an extension. Without one, `.html` is
 * tried before `.md`, because a map that carries both formats is read from the
 * HTML page. With one, the named file is tried first and its sibling format
 * second, so `refs.md` still resolves once the Markdown sources are gone.
 * An empty path, one containing `..` or one with an unknown extension yields
 * no candidate at all.
 */
export function pageCandidates(page: string): string[] {
  const cleaned = page.trim().replace(/\\/g, "/")
  if (cleaned.length === 0) return []
  if (cleaned.includes("..")) return []
  const withoutRoot = cleaned.startsWith("docs/features/") ? cleaned.slice("docs/features/".length) : cleaned
  if (withoutRoot.length === 0) return []
  const lower = withoutRoot.toLowerCase()
  if (lower.endsWith(".html")) return [withoutRoot, withoutRoot.slice(0, -".html".length) + ".md"]
  if (lower.endsWith(".md")) return [withoutRoot, withoutRoot.slice(0, -".md".length) + ".html"]
  if (/\.[a-z0-9]+$/i.test(lower)) return [withoutRoot]
  return [withoutRoot + ".html", withoutRoot + ".md"]
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "")
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/**
 * Turn a feature-map HTML page into Markdown-shaped text: headings come back as
 * `#`-prefixed lines with their level, list items and block boundaries become
 * newlines, and entities are decoded. This is what lets the same section
 * extraction run over either format, and it keeps the cost comparison honest —
 * markup the model never reads is not counted as section text.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, inner: string) => {
      return `\n${"#".repeat(Number(level))} ${stripTags(inner)}\n`
    })
    .replace(/<pre\b[^>]*>/gi, "\n```\n")
    .replace(/<\/pre>/gi, "\n```\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|ul|ol|li|tr|table|blockquote|h[1-6]|section|div)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
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

/** Extract a section from one of the generated feature-map HTML pages. */
export function extractHtmlSection(html: string, section: string): string | undefined {
  return extractSection(htmlToText(html), section)
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

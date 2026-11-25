import { readFile } from "node:fs/promises"
import { join } from "node:path"

export type CommandClass = "quick" | "service" | "job"

export interface ServiceRule {
  match: string
  ready?: string
  port?: number
  readyTimeoutMs?: number
}

export interface RunManifest {
  services?: ServiceRule[]
  jobs?: string[]
}

export interface Classified {
  kind: CommandClass
  rule?: ServiceRule
}

const SERVICE_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev\b/i,
  /\bvite\b/i,
  /\bnext\s+dev\b/i,
  /\bnuxt\s+dev\b/i,
  /\bng\s+serve\b/i,
  /\buvicorn\b/i,
  /\bflask\s+run\b/i,
  /\bpython(?:3)?\s+-m\s+http\.server\b/i,
  /\bdev-preview(?:\.ps1)?\b/i,
  /\bdotnet\s+run\b/i,
  /\bphp\s+artisan\s+serve\b/i,
  /\brails\s+(?:server|s)\b/i,
]

const JOB_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|deploy|release|lint|typecheck|e2e)\b/i,
  /\b(?:jest|vitest|playwright|cypress|puppeteer|tsc)\b/i,
  /\bgh\s+run\s+(?:watch|view|list)\b/i,
  /\bgit\s+clone\b/i,
  /\bdocker\s+(?:build|compose)\b/i,
  /\b(?:deploy|release)\b/i,
]

export function classify(command: string, manifest: RunManifest | undefined): Classified {
  const text = command.trim()
  const service = manifest?.services?.find((rule) => {
    try { return new RegExp(rule.match, "i").test(text) } catch { return text.toLowerCase().includes(rule.match.toLowerCase()) }
  })
  if (service !== undefined) return { kind: "service", rule: service }
  if (manifest?.jobs?.some((entry) => text.toLowerCase().includes(entry.toLowerCase()))) return { kind: "job" }
  if (SERVICE_PATTERNS.some((pattern) => pattern.test(text))) return { kind: "service" }
  if (JOB_PATTERNS.some((pattern) => pattern.test(text))) return { kind: "job" }
  return { kind: "quick" }
}

export async function readManifest(directory: string): Promise<RunManifest | undefined> {
  try {
    const text = await readFile(join(directory, ".opencode", "run.json"), "utf8")
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === "object") return parsed as RunManifest
  } catch {
    // No manifest is not an error.
  }
  return undefined
}

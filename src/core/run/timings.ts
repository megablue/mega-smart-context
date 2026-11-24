import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

interface Entry {
  samples: number[]
  updated: number
}

interface FileShape {
  projects: Record<string, Record<string, Entry>>
}

const MAX_SAMPLES = 20

export class TimingStore {
  private data: FileShape = { projects: {} }
  private readonly file: string
  private loaded = false
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(file?: string) {
    this.file = file ?? join(homedir(), ".config", "opencode", "mega-run", "timings.json")
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as FileShape
      if (parsed !== null && typeof parsed === "object" && parsed.projects !== undefined) this.data = parsed
    } catch {
      // First run.
    }
  }

  static signature(command: string): string {
    return command
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "#")
      .replace(/:\d{2,5}\b/g, ":PORT")
      .replace(/\b\d{4,}\b/g, "#")
      .replace(/\b[a-f0-9]{7,}\b/gi, "#")
      .slice(0, 160)
  }

  static project(directory: string): string {
    return directory.replace(/\\/g, "/").toLowerCase()
  }

  p90(project: string, signature: string): number | undefined {
    const samples = this.data.projects[project]?.[signature]?.samples
    if (samples === undefined || samples.length === 0) return undefined
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
  }

  deadline(project: string, signature: string, hint: number | undefined): number {
    const p90 = this.p90(project, signature)
    let base = Math.max((p90 ?? 120_000) * 1.5, 30_000)
    if (hint !== undefined && Number.isFinite(hint) && hint > base) base = hint
    return Math.min(base, 30 * 60_000)
  }

  async record(project: string, signature: string, ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) return
    if (this.data.projects[project] === undefined) this.data.projects[project] = {}
    const bucket = this.data.projects[project]
    if (bucket[signature] === undefined) bucket[signature] = { samples: [], updated: 0 }
    const entry = bucket[signature]
    entry.samples = [...entry.samples, Math.round(ms)].slice(-MAX_SAMPLES)
    entry.updated = Date.now()
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true })
        const tmp = this.file + ".tmp"
        await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8")
        await rename(tmp, this.file)
      } catch {
        // A timing table is an optimization; a failed write never breaks a call.
      }
    })
    await this.writeChain
  }
}

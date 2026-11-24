import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface NpmScript {
  readonly name: string
  readonly command: string
  readonly packageJson: string
  readonly packageName?: string
  readonly packageVersion?: string
}

const NPM_RUN = /^npm\s+(?:run|run-script)\s+([\w:.-]+)\s*$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPackageJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The npm wrapper adds a start-up window before the script runs; the host can
 * reload the plugin inside it and dispose the run shell. Resolve the script so
 * the caller can start it directly. Pre/post scripts and extra arguments keep
 * the npm path, because npm owns that lifecycle.
 */
export function resolveNpmScript(directory: string, command: string): NpmScript | undefined {
  const match = NPM_RUN.exec(command.trim())
  if (match === null) return undefined
  const name = match[1]
  if (name === undefined) return undefined
  const packageJson = join(directory, "package.json")
  const pkg = readPackageJson(packageJson)
  if (pkg === undefined) return undefined
  const scripts = pkg.scripts
  if (!isRecord(scripts)) return undefined
  const script = scripts[name]
  if (typeof script !== "string" || script.trim().length === 0) return undefined
  if (typeof scripts["pre" + name] === "string" || typeof scripts["post" + name] === "string") return undefined
  return {
    name,
    command: script,
    packageJson,
    packageName: typeof pkg.name === "string" ? pkg.name : undefined,
    packageVersion: typeof pkg.version === "string" ? pkg.version : undefined,
  }
}

function quote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

export function npmScriptCommand(script: NpmScript): string {
  const directory = dirname(script.packageJson)
  const bin = join(directory, "node_modules", ".bin")
  const entries: Array<[string, string]> = [
    ["npm_lifecycle_event", script.name],
    ["npm_lifecycle_script", script.command],
    ["npm_package_json", script.packageJson],
    ["INIT_CWD", directory],
    ["PATH", bin],
  ]
  if (script.packageName !== undefined) entries.push(["npm_package_name", script.packageName])
  if (script.packageVersion !== undefined) entries.push(["npm_package_version", script.packageVersion])

  const save = entries
    .map(([key]) => `$__msc_old_${key} = [Environment]::GetEnvironmentVariable(${quote(key)}, 'Process')`)
    .join("; ")
  const set = entries
    .map(([key, value]) => key === "PATH"
      ? `$env:PATH = ${quote(value)} + ';' + $env:PATH`
      : `$env:${key} = ${quote(value)}`)
    .join("; ")
  const restore = entries
    .map(([key]) => `[Environment]::SetEnvironmentVariable(${quote(key)}, $__msc_old_${key}, 'Process')`)
    .join("; ")

  return `${save}; ${set}; try { ${script.command} } finally { ${restore} }`
}

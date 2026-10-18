/**
 * Install, inspect or remove this plugin in an OpenCode discovery directory.
 *
 * The host discovers a plugin by finding `<root>/server(.ts|.js)` inside its
 * plugin directories. Project scope is `<project>/.opencode/plugin/<name>`;
 * user scope is `~/.config/opencode/plugins/<name>`. Nothing else is required:
 * no config entry for an auto-discovered directory, no build step, and no
 * dependency install - the host loads the TypeScript source directly.
 *
 * The install is a **copy**, not a junction. The host re-reads the discovery
 * directory on each pass, so a link buys nothing, and a copy can be compared
 * against the repository: a stale install is diagnosable drift instead of a
 * plugin that quietly runs old code, and it cannot break because the working
 * tree moved. A re-synced copy at a path the host already loaded is picked up
 * at the next load; a first install may wait for a restart, because discovery
 * of a brand-new directory mid-run is not guaranteed.
 *
 * Modes:
 *
 * - (no flag)   install into the user scope
 * - `--project` install into this repository's project scope
 * - `--remove`  remove from the selected scope (add `--project` for project)
 * - `--status`  report both scopes and their drift; change nothing
 * - `--help`    the help text
 *
 * The install is idempotent on bytes: an in-sync copy is left alone; a drifted
 * copy is replaced with a fresh copy of exactly the shipped set. `node_modules`
 * is never copied; `package.json` is always included because `"type": "module"`
 * is what makes the host load `.ts` as ESM.
 *
 * @module mega-smart-context/install
 */

import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** The entry the loader resolves first. */
const ENTRY = "server.ts"

export interface InstallResult {
  readonly scope: "user" | "project"
  readonly path: string
  readonly target: string
  readonly action: "installed" | "updated" | "replaced" | "removed" | "missing" | "current"
  readonly changed: number
}

export interface Drift {
  readonly missing: string[]
  readonly changed: string[]
  readonly extra: string[]
}

/** The package root: the parent of this script's directory. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..")
}

/** The package name, read from the manifest rather than written down again. */
export function packageName(root: string): string {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error(`${root}/package.json has no name`)
  }
  return manifest.name
}

/** The user-scope discovery directory this host reads on Windows. */
export function userPluginDir(): string {
  return join(homedir(), ".config", "opencode", "plugins")
}

/** The project-scope discovery directory for this repository. */
export function projectPluginDir(root: string): string {
  return join(root, ".opencode", "plugin")
}

/** Every directory the host reads for plugins, in the order it would see them. */
export function discoveryDirs(root: string): Array<{ scope: "user" | "project"; dir: string }> {
  return [
    { scope: "project", dir: projectPluginDir(root) },
    { scope: "user", dir: userPluginDir() },
  ]
}

/** Is this path a symlink or junction rather than a real directory? */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * What a discovery directory has to contain: the manifest's `files[]` plus
 * `package.json` itself. Every entry is checked against the working tree, so a
 * manifest that lists a missing file fails here rather than producing a copy
 * that is silently incomplete.
 */
export function shippableFiles(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: unknown }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${root}/package.json lists no files to ship; fill in its files[] array`)
  }
  const entries = manifest.files.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  )
  if (!entries.includes("package.json")) entries.push("package.json")
  for (const entry of entries) {
    if (!existsSync(join(root, entry))) {
      throw new Error(`package.json files[] lists ${entry}, but ${root} has no ${entry}`)
    }
  }
  return entries
}

/** Every leaf file under a directory, as forward-slashed relative paths. */
function fileTree(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : prefix + "/" + entry.name
      if (entry.isDirectory()) walk(join(current, entry.name), relative)
      else out.push(relative)
    }
  }
  walk(dir, "")
  return out
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function countFiles(dir: string): number {
  return fileTree(dir).filter((relative) => !relative.startsWith("node_modules/")).length
}

/**
 * Compare an installed copy against the repository it came from.
 *
 * Drift is three named lists: shipped files the copy is missing, files whose
 * bytes differ, and files the copy has that the repository does not ship. This
 * is the diagnostic a junction could never give: a link always agreed with the
 * live tree.
 */
export function driftReport(path: string, root: string): Drift {
  const shipped = shippableFiles(root)
  const missing: string[] = []
  const changed: string[] = []
  const compareEntry = (relative: string): void => {
    const from = join(root, relative)
    const to = join(path, relative)
    if (!existsSync(to)) {
      missing.push(relative)
      return
    }
    if (statSync(from).isDirectory()) {
      for (const leaf of fileTree(from)) compareEntry(relative + "/" + leaf)
      return
    }
    if (hashFile(from) !== hashFile(to)) changed.push(relative)
  }
  for (const entry of shipped) compareEntry(entry)
  const extra = fileTree(path).filter(
    (relative) =>
      !shipped.some((entry) => relative === entry || relative.startsWith(entry + "/")) &&
      !relative.startsWith("node_modules/"),
  )
  return { missing, changed, extra }
}

function copyManifest(path: string, root: string): number {
  mkdirSync(path, { recursive: true })
  for (const entry of shippableFiles(root)) {
    const from = join(root, entry)
    const to = join(path, entry)
    if (statSync(from).isDirectory()) mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
  }
  return countFiles(path)
}

/**
 * Remove a discovery entry without ever following a link into the repository:
 * `rmSync` with `recursive` on a junction would delete the target's contents.
 */
function removePath(path: string): void {
  if (isLink(path)) {
    rmSync(path)
    return
  }
  rmSync(path, { recursive: true, force: true })
}

export function installInto(dir: string, root: string, scope: "user" | "project"): InstallResult {
  const name = packageName(root)
  const path = join(dir, name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  let action: "installed" | "updated" | "replaced" = "installed"
  if (isLink(path)) {
    removePath(path)
    action = "replaced"
  } else if (existsSync(path)) {
    const drift = driftReport(path, root)
    if (drift.missing.length === 0 && drift.changed.length === 0 && drift.extra.length === 0) {
      return { scope, path, target: root, action: "current", changed: 0 }
    }
    rmSync(path, { recursive: true, force: true })
    action = "updated"
  }

  if (!existsSync(join(root, ENTRY))) {
    throw new Error(`${root} has no ${ENTRY}; run from the package root`)
  }
  const changed = copyManifest(path, root)
  return { scope, path, target: root, action, changed }
}

export function uninstallFrom(dir: string, root: string, scope: "user" | "project"): InstallResult {
  const path = join(dir, packageName(root))
  if (!existsSync(path) && !isLink(path)) {
    return { scope, path, target: "", action: "missing", changed: 0 }
  }
  removePath(path)
  return { scope, path, target: "", action: "removed", changed: 0 }
}

function describeInstall(path: string, root: string): string {
  if (isLink(path)) return "a junction; install replaces it with a copy"
  if (!existsSync(path)) return "(not installed)"
  if (!statSync(path).isDirectory()) return "not a directory; install replaces it"
  const drift = driftReport(path, root)
  if (drift.missing.length === 0 && drift.changed.length === 0 && drift.extra.length === 0) {
    return `a copy of the shipped set, ${countFiles(path)} file(s), in sync with the repository`
  }
  const parts = [`${drift.missing.length} missing`, `${drift.changed.length} changed`, `${drift.extra.length} extra`]
  return `a copy that has drifted (${parts.join(", ")}); run install to sync`
}

/** What a status run reports, for a test to assert on without capturing stdout. */
export function statusLines(root: string): string[] {
  return discoveryDirs(root).map((entry) => {
    const path = join(entry.dir, packageName(root))
    return `${entry.scope}: ${existsSync(path) || isLink(path) ? "installed" : "absent"}`
  })
}

function printHelp(): void {
  process.stdout.write(
    [
      "Install mega-smart-context into an OpenCode plugin discovery directory.",
      "",
      "  (no arguments)   copy into the user scope (~/.config/opencode/plugins/)",
      "  --project        copy into this repository (.opencode/plugin/)",
      "  --remove         remove from the selected scope",
      "  --status         report both scopes and drift; change nothing",
      "  --help           this text",
      "",
      "The install is a copy of the shippable set (package.json files[] plus package.json).",
      "No build step and no node_modules: the host resolves <root>/server before <root>/index,",
      ".ts before .js, and loads the TypeScript source directly. A re-synced copy is",
      "picked up at the next load; a first install may need a restart.",
    ].join("\n") + "\n",
  )
}

export function parseArgs(argv: readonly string[]): { project: boolean; remove: boolean; status: boolean } {
  let project = false
  let remove = false
  let status = false
  for (const arg of argv) {
    if (arg === "--project") project = true
    else if (arg === "--remove" || arg === "--uninstall") remove = true
    else if (arg === "--status") status = true
    else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg} (see --help)`)
    }
  }
  return { project, remove, status }
}

export function run(argv: readonly string[], root: string): number {
  const { project, remove, status } = parseArgs(argv)
  const scope = project ? "project" : "user"
  const dir = scope === "project" ? projectPluginDir(root) : userPluginDir()
  const label = scope === "project" ? "project scope" : "user scope"

  try {
    if (status) {
      const rows = discoveryDirs(root).map((candidate) => {
        const path = join(candidate.dir, packageName(root))
        const here = existsSync(path) || isLink(path)
        const pad = candidate.scope === "project" ? "project" : "user   "
        return `  ${pad} ${candidate.dir}` + (here ? "\n    " + describeInstall(path, root) : "\n    (not installed)")
      })
      process.stdout.write(`${packageName(root)} discoverable from:\n` + rows.join("\n") + "\n")
      return 0
    }

    const result = remove ? uninstallFrom(dir, root, scope) : installInto(dir, root, scope)
    const verb =
      result.action === "installed"
        ? `installed into ${label} (${result.changed} file(s))`
        : result.action === "updated"
          ? `updated the copy in ${label} (${result.changed} file(s) synced)`
          : result.action === "replaced"
            ? `replaced a junction in ${label} with a copy (${result.changed} file(s))`
            : result.action === "removed"
              ? `removed from ${label}`
              : result.action === "current"
                ? `already installed in ${label}, in sync; nothing written`
                : `nothing to remove from ${label}`
    process.stdout.write(`${verb}\n  ${result.path}\n`)
    if (result.action === "installed") {
      process.stdout.write("Restart OpenCode for the host to discover it.\n")
    } else if (result.action === "updated" || result.action === "replaced") {
      process.stdout.write("The host picks the new code up at its next load; a restart only makes it immediate.\n")
    } else if (result.action === "removed") {
      process.stdout.write("The host stops loading it at its next load; a restart only makes it immediate.\n")
    }
    return 0
  } catch (error) {
    process.stderr.write(`install failed: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const main = process.argv[1]
const isMain = main !== undefined && pathToFileURL(resolve(main)).href === import.meta.url
if (isMain) {
  process.exitCode = run(process.argv.slice(2), packageRoot())
}

/**
 * Stamp, print or check the per-commit version.
 *
 * The number is `MAJOR.MINOR.(git rev-list --count HEAD - countBase)`: MAJOR and
 * MINOR are the released line, the patch is the commit count since the base in
 * `package.json`. Nothing here is a build step - the pre-commit hook runs the
 * same functions, so the manifest always carries the number the commit count
 * implies.
 *
 * Modes:
 *
 * - (no flag)     print the version of `HEAD`
 * - `--next`      count the commit about to be made (what a pre-commit hook sees)
 * - `--write`     write the patch into `package.json` and `package-lock.json`
 * - `--check`     exit 1 unless `package.json` already carries the derived number
 *
 * `--next` exists because a pre-commit hook runs before the commit exists: HEAD
 * is still the parent, so the hook must count the commit it is about to create.
 *
 * @module mega-smart-context/version.mjs
 */

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { deriveVersion, readVersionBase } from "../src/core/version.ts"

/** Commits reachable from HEAD. 0 when there is no history (an unborn HEAD). */
export function gitCommitCount(root) {
  try {
    const out = execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    const count = Number.parseInt(out.trim(), 10)
    return Number.isFinite(count) ? count : 0
  } catch {
    return 0
  }
}

export function readManifest(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
}

/** The version this tree's manifest should carry. `next` counts the commit about to be made. */
export function expectedVersion(root, { next = false } = {}) {
  const base = readVersionBase(readManifest(root))
  return deriveVersion(base, gitCommitCount(root) + (next ? 1 : 0))
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}

/**
 * Set `version` in `package.json` and in both of `package-lock.json`'s version
 * fields, so the lockfile never disagrees with the manifest.
 *
 * @returns the files it actually rewrote; an in-sync file is left untouched.
 */
export function writeVersion(root, version) {
  const changed = []

  const manifestPath = join(root, "package.json")
  const manifest = readManifest(root)
  if (manifest.version !== version) {
    manifest.version = version
    writeJson(manifestPath, manifest)
    changed.push("package.json")
  }

  const lockPath = join(root, "package-lock.json")
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"))
    let touched = false
    if (lock.version !== version) {
      lock.version = version
      touched = true
    }
    if (lock.packages?.[""] !== undefined && lock.packages[""].version !== version) {
      lock.packages[""].version = version
      touched = true
    }
    if (touched) {
      writeJson(lockPath, lock)
      changed.push("package-lock.json")
    }
  } catch {
    // A tree without a lockfile stamps only the manifest.
  }

  return changed
}

export function run(argv, root) {
  const flags = new Set(argv)
  const version = expectedVersion(root, { next: flags.has("--next") })

  if (flags.has("--write")) {
    const changed = writeVersion(root, version)
    process.stdout.write(`version ${version}${changed.length > 0 ? ` (wrote ${changed.join(", ")})` : " (already current)"}\n`)
    return 0
  }

  if (flags.has("--check")) {
    const actual = readManifest(root).version
    if (actual !== version) {
      process.stderr.write(`version: package.json is ${actual}, expected ${version} (run: node scripts/version.mjs --write)\n`)
      return 1
    }
    process.stdout.write(`version ${version} is current\n`)
    return 0
  }

  process.stdout.write(version + "\n")
  return 0
}

const main = process.argv[1]
if (main !== undefined && pathToFileURL(resolve(main)).href === import.meta.url) {
  process.exitCode = run(process.argv.slice(2), process.cwd())
}

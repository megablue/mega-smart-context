/**
 * The installer's pinning test.
 *
 * It copies the package into a temporary directory, asserts the copy is exact,
 * mutates one file to prove drift is detected, resyncs, and removes the copy.
 * Nothing touches the real user plugin directory.
 *
 * Run from the repo root: `npm run test:install`.
 */

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { driftReport, installInto, shippableFiles, uninstallFrom } from "./install.ts"

const root = resolve(process.argv[2] ?? ".")
const tempRoot = mkdtempSync(join(tmpdir(), "megasc-install-"))
let passed = 0

function ok(value, label) {
  assert.ok(value, label)
  passed += 1
}

try {
  const shipped = shippableFiles(root)
  ok(shipped.includes("server.ts"), "server.ts is shipped")
  ok(shipped.includes("package.json"), "package.json is shipped")
  ok(shipped.includes("src"), "the source tree is shipped")
  ok(shipped.includes("options.json"), "options.json is shipped")
  ok(shipped.includes("README.md"), "README.md is shipped")

  const plugins = join(tempRoot, "plugins")
  mkdirSync(plugins, { recursive: true })

  const first = installInto(plugins, root, "user")
  ok(first.action === "installed", "the first install copies")

  const target = join(plugins, "mega-smart-context")
  ok(existsSync(join(target, "server.ts")), "the entry is in the copy")
  ok(existsSync(join(target, "package.json")), "the manifest is in the copy")
  ok(existsSync(join(target, "src", "core", "context.ts")), "the core is in the copy")
  ok(!existsSync(join(target, "node_modules")), "node_modules is never copied")

  const clean = driftReport(target, root)
  ok(clean.missing.length === 0 && clean.changed.length === 0 && clean.extra.length === 0, "the copy is in sync")

  writeFileSync(join(target, "server.ts"), "\n// drift\n", { flag: "a" })
  const drifted = driftReport(target, root)
  ok(drifted.changed.includes("server.ts"), "drift is detected")

  const second = installInto(plugins, root, "user")
  ok(second.action === "updated", "a drifted copy is resynced")

  const repaired = driftReport(target, root)
  ok(repaired.missing.length === 0 && repaired.changed.length === 0 && repaired.extra.length === 0, "the resync is clean")

  const third = installInto(plugins, root, "user")
  ok(third.action === "current", "an in-sync copy is left alone")

  const removed = uninstallFrom(plugins, root, "user")
  ok(removed.action === "removed", "uninstall removes the copy")
  ok(!existsSync(target), "the copy is gone")
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log(`install smoke: ${passed} assertions passed`)

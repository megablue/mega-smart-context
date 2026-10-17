/**
 * The version this build carries, for `/context status`.
 *
 * It is read from the package's own `package.json` - the one shipped beside this
 * file - and not derived here: the installed copy has no git history, and the
 * host must not run git per request. The pre-commit hook keeps that field equal
 * to the derived number, so what `/context` prints is what the badge shows.
 *
 * @module mega-smart-context/adapters/opencode/version
 */

import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Three levels above `src/adapters/opencode/`, beside `options.json` and `server.ts`. */
export const PACKAGE_PATH = fileURLToPath(new URL("../../../package.json", import.meta.url))

/** The manifest's `version`, or `undefined` when the file is missing or unreadable. */
export function readPluginVersion(): string | undefined {
  if (!existsSync(PACKAGE_PATH)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as { version?: unknown }
    const version = manifest.version
    return typeof version === "string" && version.length > 0 ? version : undefined
  } catch {
    return undefined
  }
}

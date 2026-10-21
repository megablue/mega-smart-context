/**
 * Where *this* host keeps its user configuration, and the strict merge that
 * turns the three layers into one `ResolvedConfig`.
 *
 * The core owns the defaults and the validation; this file owns only the path
 * (`~/.config/opencode/mega-smart-context.json`, beside `opencode.json`) and the
 * first-run write. The environment overrides exist for tests, which must never
 * write to a real home, and for a user who keeps the file elsewhere.
 *
 * @module mega-smart-context/adapters/opencode/config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_CONFIG,
  NO_USER_CONFIG_ENV,
  USER_CONFIG_ENV,
  USER_CONFIG_FILENAME,
  resolveConfig,
  type ResolvedConfig,
} from "../../core/config.ts"
import { messageOf } from "../../core/types.ts"
import type { PluginContext } from "./types.ts"

export * from "../../core/config.ts"

/**
 * The package's own default layer, three levels above `src/adapters/opencode/`.
 * A copy installed into a discovery directory carries this file; the host does
 * not hand an auto-discovered plugin any options, so this is the layer that
 * makes the shipped defaults explicit and comparable.
 */
export const OPTIONS_PATH = fileURLToPath(new URL("../../../options.json", import.meta.url))

function readPackageOptions(): unknown {
  if (!existsSync(OPTIONS_PATH)) return undefined
  try {
    return JSON.parse(readFileSync(OPTIONS_PATH, "utf8"))
  } catch {
    throw new Error(`config: ${OPTIONS_PATH} is not valid JSON`)
  }
}

export function userConfigPath(): string {
  const override = process.env[USER_CONFIG_ENV]
  if (typeof override === "string" && override.length > 0) return override
  return join(homedir(), ".config", "opencode", USER_CONFIG_FILENAME)
}

/**
 * Write the defaults on first run, never again.
 *
 * A user who has never seen a config has nothing to edit; after the first write
 * the file is theirs, edits included, and is left alone.
 *
 * @returns whether the file was created.
 */
export function ensureUserConfig(file = userConfigPath()): boolean {
  if (existsSync(file)) return false
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8")
  return true
}

export function readUserConfig(file = userConfigPath()): unknown {
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, "utf8")
  if (text.trim().length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`config: ${file} is not valid JSON`)
  }
}

/**
 * Resolve the three layers for a given `options` layer.
 *
 * Split out from {@link resolveHostConfig} because the TUI half resolves the
 * same files in a different process and must honour the same
 * `mega-smart-context.json` - a switch that stopped one half but not the other
 * would be a trap. `warn` is optional there: a toast is not worth a console.
 */
export function resolveLayeredConfig(
  options: unknown,
  warn: (line: string) => void = () => {},
): ResolvedConfig {
  let user: unknown
  if (process.env[NO_USER_CONFIG_ENV] !== "1") {
    const file = userConfigPath()
    try {
      ensureUserConfig(file)
    } catch (error) {
      warn("could not write the user config: " + messageOf(error))
    }
    try {
      user = readUserConfig(file)
    } catch (error) {
      warn("user config unreadable: " + messageOf(error))
    }
  }
  return resolveConfig({ package: readPackageOptions(), options, user })
}

/**
 * Resolve the config for one host context.
 *
 * A write failure is reported and does not stop the plugin; an unknown key or a
 * wrong type throws, because a setting the user believes is in force but is not
 * is worse than a plugin that refuses to start.
 */
export function resolveHostConfig(ctx: PluginContext, warn: (line: string) => void): ResolvedConfig {
  return resolveLayeredConfig(ctx.options, warn)
}

/**
 * The update check's arithmetic: which version is newer, is a check due, and
 * should this version be announced. Pure and host-free, so it is smoke-tested
 * with no network and no clock.
 *
 * The check itself lives in `tui.ts`, at the plugin root: the server plugin's
 * context has no toast, so a notice about the plugin cannot come from the half
 * that builds the payload. Keeping the decision here means the network path
 * stays a thin wrapper over tested rules.
 *
 * @module mega-smart-context/update
 */

/**
 * The manifest on the default branch.
 *
 * The pre-commit hook keeps its `version` equal to the commit count, so a raw
 * file read is the newest number anyone has published - no release feed and no
 * API key.
 */
export const UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/megablue/mega-smart-context/main/package.json"

/** How often the check may reach the network, in milliseconds. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** The durable piece of TUI state: when we last looked, what we saw, what we said. */
export interface UpdateState {
  /** Wall-clock milliseconds of the last completed attempt (0 = never). */
  checkedAt: number
  /** The newest version seen so far, or "" before the first successful read. */
  latest: string
  /** The version already toasted, so one release nags once. */
  notified: string
}

/** The state a fresh store starts from. */
export const EMPTY_UPDATE_STATE: UpdateState = { checkedAt: 0, latest: "", notified: "" }

function segments(version: string): number[] {
  return String(version)
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) && value > 0 ? value : 0
    })
}

/**
 * Compare two `MAJOR.MINOR.PATCH` strings numerically, segment by segment.
 *
 * Numeric comparison is the point: `0.1.9` is older than `0.1.10`, which a
 * string compare gets backwards. A missing or unparsable segment counts as 0,
 * so a malformed manifest can never look newer than a real version.
 */
export function compareVersions(a: string, b: string): number {
  const left = segments(a)
  const right = segments(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const one = left[index] ?? 0
    const other = right[index] ?? 0
    if (one !== other) return one < other ? -1 : 1
  }
  return 0
}

/** True when `latest` is strictly newer than `installed`. */
export function updateAvailable(installed: string, latest: string): boolean {
  return compareVersions(latest, installed) > 0
}

/** True when no check has run, or the last one is at least {@link CHECK_INTERVAL_MS} old. */
export function dueForCheck(lastAttempt: number, now: number): boolean {
  if (!Number.isFinite(lastAttempt) || lastAttempt <= 0) return true
  return now - lastAttempt >= CHECK_INTERVAL_MS
}

/** The `version` field of a manifest body, or `undefined` when the text is not one. */
export function parseManifestVersion(body: string): string | undefined {
  try {
    const manifest = JSON.parse(body) as { version?: unknown }
    const version = manifest.version
    return typeof version === "string" && version.trim().length > 0 ? version.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * The version worth a toast, or `undefined` for silence.
 *
 * Three silences: nothing installed, nothing fetched, and "not newer". The
 * fourth is the repeat rule - a version already announced stays quiet until a
 * newer one appears, so skipping several releases still produces one toast.
 */
export function announceVersion(
  installed: string | undefined,
  latest: string | undefined,
  notified: string,
): string | undefined {
  if (installed === undefined || latest === undefined) return undefined
  if (!updateAvailable(installed, latest)) return undefined
  return latest === notified ? undefined : latest
}

/** The one-line toast body: what is available, what is loaded, how to update. */
export function updateMessage(installed: string, latest: string): string {
  return `${latest} is available (installed ${installed}) - git pull && npm run plugin:install`
}

/**
 * The per-commit version: `MAJOR.MINOR.PATCH`, where the patch counts commits
 * since the base recorded in `package.json`.
 *
 * Pure and host-free. `scripts/version.mjs` is the only caller that adds git and
 * the filesystem, so the arithmetic has one implementation and the hook, the
 * check and the test all read the same number. The host never runs git: an
 * installed copy instead carries the version the pre-commit hook already stamped
 * into its own `package.json`.
 *
 * @module mega-smart-context/version
 */

/** The manifest key that carries the base, so a private package keeps its own settings in one place. */
export const VERSION_KEY = "megaSmartContext"

/**
 * The major and minor digits of the released version, plus the commit count the
 * patch is measured from.
 */
export interface VersionBase {
  readonly major: number
  readonly minor: number
  /** `patch = commitCount - countBase`. */
  readonly countBase: number
}

function readInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`version: ${what} must be a non-negative integer`)
  }
  return value
}

/**
 * Read the base from a parsed `package.json`.
 *
 * `version` supplies MAJOR.MINOR only: its patch is whatever the last hook run
 * stamped and is deliberately ignored, so an unstamped tree still cannot move
 * the base. A missing base is an error rather than a default, because a silent
 * default would render a wrong version that looks right.
 */
export function readVersionBase(manifest: unknown): VersionBase {
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("version: package.json must be an object")
  }
  const record = manifest as Record<string, unknown>
  const version = record.version
  if (typeof version !== "string") throw new Error("version: package.json has no version string")
  const match = /^(\d+)\.(\d+)\./.exec(version)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`version: ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH`)
  }
  const field = record[VERSION_KEY]
  if (typeof field !== "object" || field === null) {
    throw new Error(`version: package.json has no ${VERSION_KEY} object (expected { countBase })`)
  }
  const countBase = readInt((field as Record<string, unknown>).countBase, `${VERSION_KEY}.countBase`)
  return { major: Number(match[1]), minor: Number(match[2]), countBase }
}

/**
 * `MAJOR.MINOR.PATCH` for a commit count.
 *
 * A count below the base yields patch 0 rather than a negative number: the base
 * is a lower bound, and a rebase that rewrote the counted history must not
 * produce an unpublishable version.
 */
export function deriveVersion(base: VersionBase, commitCount: number): string {
  const patch = Math.max(0, Math.trunc(commitCount) - base.countBase)
  return `${base.major}.${base.minor}.${patch}`
}

/**
 * The OpenCode-shaped project resolver: one ProjectStore per setup, one key per
 * session, one git-root lookup per directory.
 *
 * A worktree and its main checkout share a git root, so a fact learned in one is
 * offered in the other. The lookup runs `git rev-parse --show-toplevel` through
 * `execFileSync` (no shell, no quoting) and is cached for the life of the setup;
 * a repository that is not git, or a host with no git binary, falls back to the
 * session directory. A git call never throws into the turn.
 *
 * @module mega-smart-context/adapters/opencode/project
 */

import { execFileSync } from "node:child_process"

import {
  ProjectStore,
  projectKeyFor,
  type ProjectKey,
  type ProjectStoragePort,
} from "../../core/project.ts"
import { directoryOf } from "./context.ts"
import type { PluginContext } from "./types.ts"

export interface ProjectResolver {
  readonly store: ProjectStore
  keyFor(sessionID: string): Promise<ProjectKey>
}

/** The top of the working tree containing `directory`, or null when there is none. */
function gitRootOf(directory: string): string | null {
  try {
    const root = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    }).trim()
    return root.length > 0 ? root : null
  } catch {
    return null
  }
}

export function createProjectResolver(
  ctx: PluginContext,
  warn: (line: string) => void,
): ProjectResolver {
  const store = new ProjectStore(ctx.storage as ProjectStoragePort | undefined, { warn })
  const keys = new Map<string, ProjectKey>()
  const roots = new Map<string, string | null>()

  return {
    store,
    async keyFor(sessionID: string): Promise<ProjectKey> {
      const cached = keys.get(sessionID)
      if (cached !== undefined) return cached
      const directory = await directoryOf(ctx, sessionID)
      let root = roots.get(directory)
      if (root === undefined) {
        root = gitRootOf(directory)
        roots.set(directory, root)
      }
      const key = projectKeyFor({ directory, gitRoot: root })
      keys.set(sessionID, key)
      return key
    },
  }
}

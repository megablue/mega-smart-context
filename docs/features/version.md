# Version stamping - one number, derived from the commit count

Status: shipped (v0.1) - Read when: `scripts/version.mjs`, `countBase`, the version in `/context status`, the README badge, `npm run hooks`, the pre-commit stamp, "the version is wrong after a rebase", or "the version jumped after an amend".

## What it does

- Derives the version as `MAJOR.MINOR.PATCH`: MAJOR.MINOR is the released line held in `package.json`; PATCH is `git rev-list --count HEAD - countBase`.
- The pre-commit hook rewrites only the patch in `package.json` and `package-lock.json` and stages them, so the number lands in the commit that produced it.
- `/context status` prints the loaded build's own version, read from the `package.json` shipped beside it - the host never runs git.
- The README version badge reads `package.json` from the default branch, so it follows the same number with no extra step.
- There is no build step and no generated file: `package.json` is the one source and every reader derives from it.

User-visible behavior is in `docs/SPEC.md`.

## Map

- `src/core/version.ts` - `VERSION_KEY`, `VersionBase`, `readVersionBase`, `deriveVersion`. Pure and host-free; it does no IO.
- `scripts/version.mjs` - `gitCommitCount`, `readManifest`, `expectedVersion`, `writeVersion`, `run`; the `version` and `version:check` npm scripts.
- `.githooks/pre-commit` - writes and stages the number before the commit exists.
- `.githooks/commit-msg` - forwards to the machine-wide guard; see "The two hooks" below.
- `src/adapters/opencode/version.ts` - `PACKAGE_PATH`, `readPluginVersion`. Read once in `setup` (`src/adapters/opencode/index.ts`) and passed through `createContextCommand` into `renderStats` (`src/core/prompts.ts`).
- `package.json` - `version`, `megaSmartContext.countBase`, and the `version`, `version:check` and `hooks` scripts.

## How & why

### The number is a count, not a hand bump

`patch = commitCount - countBase`. MAJOR and MINOR are the released line: they change by hand, and `version` and `countBase` are raised together in the same commit so the patch restarts at 0 for the new line. `countBase` lives under the package's own `megaSmartContext` key so a private package keeps its settings together, and the `files[]`-shipped `package.json` carries the base into the installed copy without a second file.

`--next` counts the commit about to be made. A pre-commit hook runs while `HEAD` is still the parent, so without it the stamp would lag one commit. `--check` is the inverse gate: it compares the manifest against the plain `HEAD` count, so a run after a commit confirms the stamp matches the history.

### One writer, several readers

`src/core/version.ts` is pure and holds the only copy of the arithmetic; `scripts/version.mjs` adds git and the filesystem; the adapter only reads the stamped field. `readPluginVersion` is exists-guarded and returns `undefined` rather than throwing, because `/context` must print without a version rather than fail to load.

### The count survives a rebase by clamping

A commit count below `countBase` yields patch 0 rather than a negative number. Rewriting the counted history (rebase, squash, amending the base) therefore cannot produce an unpublishable version, but it does not restore the old number either: after a rewrite the number is the new count, which is what "commits since the base" means.

### An amend is stamped one patch ahead

The hook adds one because a commit is about to be created, and an amend does not create one: it replaces `HEAD`, so `git commit --amend` is stamped one patch above the count itself, and `npm run version:check` fails while that commit is the tip. The hook cannot tell the two apart - git leaves `GIT_REFLOG_ACTION` unset in `pre-commit` here (2.55), and the index, the message and the reflog all look the same at that point. It costs nothing to leave alone: the number self-corrects at the next commit, which stamps from its own count, and the sequence still rises. Make a new commit rather than an amend when the tip must pass `version:check`.

### The two hooks, and why one chains

`core.hooksPath` is machine-wide (`C:/Users/mega/.githooks`, the co-author guard) and is not cloned, so this repository needs its own path. `npm run hooks` sets `core.hooksPath=.githooks` in this repo only. That shadows the machine-wide directory, so `.githooks/commit-msg` does not check for a trailer itself - it forwards to `$(git config --global --get core.hooksPath)/commit-msg`. Copying the guard would make two copies that drift; forwarding keeps one.

The bump runs in `pre-commit`, not `commit-msg`: `commit-msg` receives the message and cannot stage the files the bump rewrites.

## Config keys / UI

| Key | Where | Meaning |
| --- | --- | --- |
| `version` | `package.json` | `MAJOR.MINOR.PATCH`; MAJOR.MINOR is the base, the patch is stamped |
| `megaSmartContext.countBase` | `package.json` | the commit count that carries patch 0; raise it with the minor |
| `--next` | `scripts/version.mjs` | count the commit about to be made |
| `--write` | `scripts/version.mjs` | rewrite the patch into the manifest and lockfile |
| `--check` | `scripts/version.mjs` | exit 1 unless the manifest already carries the derived number |

| Script | Effect |
| --- | --- |
| `npm run hooks` | `git config core.hooksPath .githooks` (once per clone) |
| `npm run version` | print the version of `HEAD` |
| `npm run version:check` | the gate step: manifest against the `HEAD` count |

## Tests that pin it

- "readVersionBase reads the major" / "reads the minor" / "reads the count base"
- "the patch counts from the base", "the patch grows with the commit count"
- "a count below the base clamps at zero", "a zero base counts every commit"
- "a missing base is rejected", "a non-numeric version is rejected", "a negative base is rejected"
- "/context status shows the build's version"
- `npm run version:check` (a gate step, not a smoke assertion)

## Related

- `installation.md` - what the install copies, and why the base ships inside `package.json`.
- `context-handoff.md` - `/context` arrives as a real turn.
- `AGENTS.md` Commands - `npm run hooks` and the gate.

# Installation - copy, drift, and the two discovery scopes

Status: shipped (v0.1) - Read when: `plugin:install`, `.opencode/plugin`, `~/.config/opencode/plugins`, `files[]`, drift, "a stale install", or the plugin is not discovered.

## What it does

- Copies the shippable set into an OpenCode plugin discovery directory.
- Project scope is `<repo>/.opencode/plugin/mega-smart-context`; user scope is `~/.config/opencode/plugins/mega-smart-context`.
- Is idempotent by content hash: an in-sync copy is left alone, a drifted copy is resynchronized.
- `--status` reports missing, changed and extra files; `--remove` removes the selected scope.
- Needs no build step, no `node_modules` and no config entry; restart OpenCode after a change.

The user-facing commands are in `README.md`; this page is the mechanism.

## Map

- `scripts/install.ts` - `packageRoot`, `packageName`, `shippableFiles`, `driftReport`, `installInto`, `uninstallFrom`, `run`, `parseArgs`, `projectPluginDir`, `userPluginDir`, `isLink`, `statusLines`.
- `scripts/install-smoke.mjs` - the copy/drift/remove assertions.
- `package.json` - the `plugin:*` and `test:install` scripts; `files[]` is the manifest.
- `.gitignore` - ignores `.opencode/plugin/` and `node_modules/`; the install copy is disposable.
- `README.md` - the user-facing install and configure commands.

## How & why

### Copy, not junction

The host imports the module graph once per process, so a link buys nothing: a code change needs a restart either way. A copy can be compared against the repository, so a stale install is diagnosable drift instead of a plugin that quietly runs old code, and a copy cannot break because the working tree moved.

A legacy junction is removed with `rmSync(path)` **without** `recursive`: recursing through a junction would delete the repository it points at. A real directory is removed recursively, which is safe because nothing the user owns lives inside the install.

### The manifest

`shippableFiles` reads `package.json`'s `files[]` and always adds `package.json` itself, because `"type": "module"` is what makes the host load `.ts` as ESM. Every entry is checked against the working tree, so a manifest that lists a missing file fails at install time rather than producing a copy that is silently incomplete. This is why `README.md` must exist while it is in `files[]`.

### Idempotence and drift

`driftReport` hashes every shipped file and returns three lists: `missing`, `changed`, `extra`. `installInto` returns:

- `current` when all three are empty (nothing written);
- `updated` when the copy drifted (the directory is deleted and recopied);
- `replaced` when a legacy junction was found;
- `installed` on a first run;
- `removed` / `missing` from `uninstallFrom`.

`--status` prints both scopes, so a project install and a user install can be seen together. The installed copy is disposable; the source tree is the truth.

### Scopes

| Scope | Path | Command |
| --- | --- | --- |
| user | `~/.config/opencode/plugins/mega-smart-context` | `npm run plugin:install` |
| project | `<repo>/.opencode/plugin/mega-smart-context` | `npm run plugin:install:project` |

The asymmetry is the host's: user is `plugins` (plural), project is `plugin` (singular). Restart OpenCode after installing or removing.

### No dependencies

The plugin imports the host only as types; the runtime has no `@opencode/plugin` import. The copy therefore needs no `node_modules`, and the host loads the TypeScript source directly. `node_modules` is excluded from the copy by the manifest, not by a build step.

### Do not run two context managers

Do not run this alongside `mega-skillstate` (or any other plugin that rewrites `context`). Both rewrite the same request and both may own `compaction`. Disable the other plugin first; see the README.

## Config keys / UI

| Script | Effect |
| --- | --- |
| `npm run plugin:install` | copy into the user scope |
| `npm run plugin:install:project` | copy into the project scope |
| `npm run plugin:status` | report both scopes and drift |
| `npm run plugin:uninstall` | remove the selected scope (add `--project` for project) |
| `npm run test:install` | the installer's pinning test |

There are no runtime config keys for the installer.

## Tests that pin it

- "the first install copies"
- "the entry is in the copy"
- "node_modules is never copied"
- "the copy is in sync"
- "drift is detected"
- "a drifted copy is resynced"
- "an in-sync copy is left alone"
- "uninstall removes the copy"

## Related

- `context-handoff.md` - what the installed plugin does.
- `AGENTS.md` Commands - the exact scripts and the gate.

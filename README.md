# mega-smart-context

An OpenCode 2.0 plugin that hands context management to the model. Instead of replaying the whole transcript, every request carries the memory document the model wrote, a short verbatim working window, and the current turn.

## Requirements

- OpenCode 2.0.
- Node 22 or newer. The host loads the TypeScript source directly; there is no build step and no runtime dependency.

## Install

Project scope (this repository only):

```sh
npm run plugin:install:project
```

User scope (every project on this machine):

```sh
npm run plugin:install
```

Check what is installed and whether it has drifted from the source tree:

```sh
npm run plugin:status
```

Remove the selected scope:

```sh
npm run plugin:uninstall
```

Restart OpenCode after installing or removing. The install is a copy of the shippable files; editing the source tree does not change an installed copy until you reinstall.

> **Do not run this alongside `mega-skillstate`** (or any other plugin that rewrites the context hook). Both rewrite the same request and both may own compaction. Disable the other plugin first.

> **Install one scope, not both.** OpenCode reads both discovery roots and keys a plugin by the path it was loaded from, so a user copy and a project copy are two instances of this plugin in a session in that repository: two window passes per request, two owners of compaction, two `/context` commands. Pick user scope to cover every project, or project scope to cover this repository alone. `npm run plugin:status` prints both, so a stray copy is visible there.

## Configure

On first run the plugin writes `~/.config/opencode/mega-smart-context.json` with every default and never overwrites it. Layers, most specific last:

1. built-in defaults,
2. the package `options.json`,
3. the host's plugin options,
4. the user file.

An unknown key or a wrong type is an error; the plugin refuses to load rather than silently keeping a default.

The settings a user normally touches:

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `memoryTokens` | `50000` | cap on the model-authored memory, estimated |
| `workingTokens` | `16000` | cap on the verbatim working window, estimated |
| `autoArchive` | `true` | archive unhandled evictions instead of dropping them |
| `evictionLead` | `1` | new user turns a pending turn is shown before archiving |
| `subagents` | `true` | manage child sessions independently |
| `refs` | `true` | allow feature-map references |
| `debug` | `false` | log pass decisions to stderr |

The source repository's `docs/SPEC.md` has the full table and the behavior.

## Use

- The model writes memory with the `smart_context` tool: `patch`, `read`, `stats`, `ref`, `archive`, `purge`, `recall`, `expand`.
- `/context` prints the current memory and archive. `/context now` archives pending turns.

Every request starts with a `<smart-context>` block. If `goal` is empty, the model is told to write the request there before the raw first message leaves the working window.

## Installer

`scripts/install.ts` copies the shippable set (`package.json`'s `files[]` plus `package.json`) into:

- user: `~/.config/opencode/plugins/mega-smart-context`
- project: `<repo>/.opencode/plugin/mega-smart-context`

It is idempotent by content hash: an in-sync copy is left alone; a drifted copy is resynchronized. `--status` reports missing, changed and extra files. It never copies `node_modules`.

## License

MIT.

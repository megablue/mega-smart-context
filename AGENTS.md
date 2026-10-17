# AGENTS.md

**Before you grep, glob or open a source file: read `HANDOFF.md`, then
`docs/features/README.md`, then only the feature page(s) for the area you are
about to change. The feature pages name the files, functions and tests you
would otherwise hunt for; the code comes after them, not before.**

mega-smart-context is a plugin for the OpenCode 2.0 CLI (TypeScript, ESM) that
hands context management to the model: every request is rebuilt from a
model-authored memory document, a short verbatim working window, and the
current turn, instead of replaying the append-only transcript.

Three kinds of document, and keeping them apart is the point:

- **`docs/SPEC.md` is product behavior** - what the product does and what a
  user sees, readable without knowing the code. Behavior belongs there even
  when the code is where the reason for it lives.
- **`docs/features/` is the feature map** - one page per feature with its
  files, mechanisms, traps and pinning tests. Read the page for the area you
  are about to change; keep it true in the same commit.
- **This file is process and hard rules** - the commands, the workflow and the
  constraints that apply across every feature.

Where a rule has a behavior half and a mechanism half, the behavior half is a
pointer to `docs/SPEC.md` and the mechanism half to its feature page rather
than a second copy: two copies of a default value is one more thing that can be
wrong.

## Read first

`HANDOFF.md` holds the current state; if it is missing, carry on with the
feature map and the code. Then `docs/features/README.md` - the feature map -
and only the feature doc(s) for what you are about to change.
`docs/SPEC.md` is user-visible behavior; this file is process and hard rules;
the feature docs are the map, the mechanism and the traps.

## Layout

- **The plugin package is this repo root** - `src/`, `scripts/`, `server.ts`,
  `options.json`, `package.json`, `tsconfig.json` and the package documents sit
  at the top level. Its documents are kept apart on purpose: `README.md` is for
  a user installing it, `docs/SPEC.md` is user-visible behavior with no code,
  and `AGENTS.md` is the process and hard rules for whoever edits it.
  - `server.ts` - the host entry. The loader resolves `<plugin-root>/server`
    before `<plugin-root>/index` (`.ts` before `.js`), so a directory install
    needs only this one re-export; it points at the adapter, not the core.
  - `src/core/` - the host-free core. **No host import lives in here.** The
    files, by area:
    - `types.ts` - the message vocabulary and the ports (`StoragePort`,
      `FeatureMapPort`), plus `Memory`, `SessionRecord`, `PendingTurn`,
      `ArchivedTurn`, `LastReport`.
    - `measure.ts` - character counting and the `chars / charsPerToken`
      estimate. Every budget is an estimate; no real tokenizer is used.
    - `schema.ts` - the eight memory keys and `applyPatch`: a `null` resets a
      key or deletes one map entry, an unknown key is dropped, maps merge key by
      key, lists replace wholesale.
    - `state.ts` - `SessionStore`: per-session LRU cache, durable storage, a
      per-session `mutate` lock, and an in-memory fallback when storage fails.
    - `view.ts` - `turnSpans`, `selectWorkingWindow`, `balanceCuts`,
      `erodeToolResults`, `stripReasoning`, `previewOf`, `renderTurn`. The turn
      arithmetic and the call/result safety live here.
    - `context.ts` - `buildPayload`: the one function that turns the record and
      the raw transcript into the outbound payload and report.
    - `archive.ts` - pending/archive entries, mechanical gists, recall, purge,
      archive caps.
    - `refs.ts` - feature-map page normalization, section extraction, and the
      gist-vs-section cost comparison.
    - `prompts.ts` - `POLICY`, `budgetOf`, `renderMemory`, `renderStats`.
    - `config.ts` - `ResolvedConfig`, `DEFAULT_CONFIG`, strict `parseLayer`,
      `resolveConfig`.
    - `memory-tool.ts` - `runMemoryTool`, the eight `smart_context` actions and
      the over-cap rejection.
    - `compaction.ts` - `runCompaction`, which returns the memory document or
      declines.
    - `command.ts` - `runContextCommand`, the `/context` actions.
  - `src/adapters/opencode/` - the OpenCode adapter, the half that knows about
    the host:
    - `index.ts` - `setup()` registers the `context` and `compaction` hooks, the
      `smart_context` tool, the `/context` command, and returns the disposer.
    - `context.ts` - `runContextTransform`, `isChildSession` (via `parentID`),
      `directoryOf`, and `createFsFeatureMap` (reads `docs/features/`).
    - `tool.ts` - `TOOL_NAME`, `TOOL_INPUT`, `TOOL_DESCRIPTION`,
      `createSmartContextTool`. The tool uses `options.codemode: false` and
      returns text content only.
    - `command.ts` - the `/context` definition; the reply is delivered through
      `ctx.session.prompt`.
    - `config.ts` - `userConfigPath`, `ensureUserConfig`, `readUserConfig`,
      `resolveHostConfig`.
    - `types.ts` - local mirrors of the host shapes, so the package has no
      runtime dependency on `@opencode/plugin`.
  - `scripts/smoke.mjs` - the plugin's pinning test.
  - `scripts/install.ts` - the copy-based installer (user/project scopes,
    `--status` drift, `--remove`, `--help`). `scripts/install-smoke.mjs` pins
    the copy, drift and removal behavior.
- `options.json` - the package's own default layer, the same keys as
  `ResolvedConfig`.
- `docs/features/` - the feature map (this workflow); its `README.md` is the
  index.
- `HANDOFF.md` - volatile session state; refreshed at handover, allowed to lag
  the tip (its header says the code wins).

## Commands

Everything runs from the repo root unless said otherwise.

- Install dependencies: `npm install`
- Typecheck (build gate, strict, no emit): `npm run typecheck` (`npx tsc --noEmit`)
- Smoke test (the plugin's pinning test): `npm run smoke` (`node scripts/smoke.mjs .`)
- Installer smoke: `npm run test:install` (`node scripts/install-smoke.mjs .`)
- Install into project scope (this repo only): `npm run plugin:install:project`
- Install into user scope (every project): `npm run plugin:install`
- Check or remove: `npm run plugin:status`, `npm run plugin:uninstall`
- Load the plugin in OpenCode: the host resolves `<plugin-root>/server`, so
  point a discovery directory at this package. Project scope:
  `.opencode/plugin/mega-smart-context`; user scope:
  `C:\Users\mega\.config\opencode\plugins\mega-smart-context`. No build step;
  the host loads the TypeScript source directly.
- User config: `~/.config/opencode/mega-smart-context.json`, created with every
  default on first run and never overwritten. `MEGA_SMART_CONTEXT_CONFIG`
  points at another file; `MEGA_SMART_CONTEXT_NO_USER_CONFIG=1` skips it.

The gate before a commit is every check, not just the tests:

    npm run typecheck; npm run smoke; npm run test:install   (from the repo root)

This shell is Windows PowerShell 5.1: no `&&` (a parser error), chain with `;`
and check `$LASTEXITCODE`. There is no separate formatter or linter yet;
`tsc --noEmit` under `strict: true` is the strict flag the smoke runs after. A
smoke run alone will import and execute a module that still fails strict
typecheck, so the typecheck is part of the gate rather than a nicety.

## Workflow

- **The features map is part of the change, not the cleanup.** Before staging a
  commit, update the feature doc(s) for whatever you changed
  (`docs/features/`), and add an index row if the doc is new. User-visible
  behavior also updates `docs/SPEC.md` in the same commit. A docs-only
  follow-up commit is the one that gets skipped. Pure refactors with no
  behavior, mechanism, config or test change need no doc edit - do not churn
  the map.
- **Read the map before the code, and keep the map worth reading.** A feature
  page is an anti-hunting payload: the file, type, function and test names for
  one area, and the traps that cost someone an afternoon. Opening the source
  first and writing the page afterwards spends the tokens twice. If a page is
  wrong, fix it in the same commit rather than working around it - a map
  nobody trusts is worse than no map.
- **Search the map in the same breath as the code.** A grep for a feature, a
  symbol or a behaviour runs over `docs/features/` too: the feature pages name
  the identifiers and the tests, so the page you need is usually one hop from
  the hit.
- **`HANDOFF.md` is refreshed at the end of a session, not per commit.** It
  carries what only the passing session knows - open threads, next steps, the
  last thing delivered - under an `As of` stamp. It is allowed to lag the tip:
  its header says the code wins. Refresh it before you hand the work over.
- **Measure, don't deduce it.** Reading the code and doing the arithmetic in
  your head is how geometry, layout and formatting bugs ship. Print the real
  numbers from the real thing - a headless run, a scratch script, the actual
  command - and assert both the good and the broken case, so each test carries
  its own failure mode.
- **Gate on the whole check set, not just the tests.** The linter catches the
  classes of defect the test run compiles straight past. Run the formatting,
  the lint with warnings denied, the tests and the build before you call
  something done.
- **Commit messages go through a file.** Write the message to a scratch file
  (this machine uses `%LOCALAPPDATA%\Temp\opencode\<project>-commit-msg.txt`)
  and run `git commit -F <path>`; a PowerShell here-string gets its terminator
  mangled by the shell tool.
- **No AI attribution in a commit message, ever, without being asked.** No
  `Co-Authored-By` trailer, no `Generated with` footer, nothing that reads as
  crediting a model or tool. These commits are the user's. This is enforced,
  not merely preferred: a machine-wide `commit-msg` hook
  (`core.hooksPath` = `C:/Users/mega/.githooks`) rejects the commit outright,
  and it blocks human co-authors too, so the only ways past it are `--no-verify`
  or `ALLOW_COAUTHOR=1`. **Use neither without the user asking in that
  conversation.** If the hook blocks something, report it and stop; do not
  reword the message to slip a trailer past the pattern.
- **Package after committing.** If the version is derived from the commit
  (a count since a base tag, a stamped build number), packaging first yields
  the previous commit's number. Raise the minor and the base together, in the
  same commit, and keep every reader of that number reading it from one place.
- **Do not commit before the user has looked at it.** Hand a visual change over
  as a build and wait for confirmation.

## Where the working knowledge lives

The per-feature working knowledge lives in `docs/features/`; its `README.md` is
the index. This file keeps the process rules and the hard rules that apply
across features; the feature pages keep the maps, mechanisms and traps.

## Hard rules

- **The context pass never mutates the durable transcript.** It only rewrites
  the outbound payload (`event.messages` / `event.system`), and re-derives it
  from the raw transcript on every request. *Reason:* mutating the transcript
  corrupts the very session the pass is managing. *Pinned by:* the smoke
  assertion "the durable transcript objects were not mutated".
- **Never split a tool call from its result, and always keep the current turn.**
  The working window cuts at turn starts; `balanceCuts` is the assertion that
  this is safe, and the current turn is included even when it alone exceeds the
  working budget. *Reason:* the host must pair every `tool-call` with its
  `tool-result`; a cut between them makes the model see two answers for one
  call, and dropping the current turn drops the results it just asked for.
  *Pinned by:* "no call/result pair is split in the payload" and "the window
  always keeps the current turn".
- **The runtime owns the schema, not the model.** The merge resets a key on
  `null`, deletes one map entry on a `null` value, drops keys the schema does
  not own, merges maps key by key and replaces lists wholesale. *Reason:* the
  failure modes are a model overwriting a key it did not mean to and deleting
  what it did not own; schema ownership in the deterministic runtime is what
  keeps a malformed patch from corrupting memory. *Pinned by:* "unknown patch
  keys are dropped" and "null deletes one map entry".
- **An over-cap memory write is rejected, never trimmed.** The tool returns the
  projected usage and writes nothing. *Reason:* a silent trim loses content the
  model believes it stored, and the model is the only one who knows what
  matters. *Pinned by:* "an over-cap memory write is rejected" and "the
  rejected write did not land".
- **`recall` requires `lost:true`.** Without it the tool returns an instruction,
  not results. *Reason:* an archive searched out of habit is a second working
  set, and the plugin exists to keep the working set small. *Pinned by:*
  "recall refuses without lost:true".
- **Every session has independent memory.** Parent and child are keyed by
  session id; there is no inheritance in either direction. `subagents:false`
  leaves a child session untouched. *Reason:* a child's task is its own, and a
  parent's memory is not the child's context. *Pinned by:* "the parent goal is
  unchanged by the child", "the child has its own goal", and "subagents:false
  leaves a child session alone".
- **Compaction returns the memory document when it is non-empty, and declines
  when it is empty.** *Reason:* one document, one summary; an empty summary
  would erase the checkpoint in the name of owning it. *Pinned by:*
  "compaction is owned when memory is non-empty" and "compaction returns the
  memory document".
- **A registered tool is not an offered tool.** `smart_context` must carry
  `options.codemode: false` and be injected into `event.tools`; it returns text
  content only, so it declares no output schema. *Reason:* measured against
  this host, a tool without `codemode:false` is reachable only through
  `execute`, and a result that declares `output` without a schema loses the
  call. *Pinned by:* "smart_context is on the wire, not only in the registry".
- **Two passes over the same conversation produce the same payload.** The
  pass is a pure function of the raw transcript and the record; no timestamps
  or pass counters are rendered. *Reason:* a retry must not change what the
  model sees, and a drifting payload breaks provider prefix caching. *Pinned
  by:* "two passes over the same conversation produce the same payload".
- **The install is a copy of the shippable set, never a junction.** `files[]`
  plus `package.json` is the manifest; an in-sync copy is left alone; a drifted
  copy is replaced; `node_modules` is never copied. *Reason:* the host imports
  the module graph once, so a link buys nothing, and a copy can be diffed, so a
  stale install is diagnosable. *Pinned by:* `npm run test:install`.
- **The user config file is the user's.** Defaults are written once on first
  run and never overwritten; an unknown key or a wrong type is reported and the
  plugin refuses to load rather than silently keeping a default. *Reason:* a
  setting the user believes is in force but is not is worse than a plugin that
  will not start. *Pinned by:* the `parseLayer` assertions and review.
- **Do not edit the installed plugins under
  `C:\Users\mega\.config\opencode\plugins\` from this repo** (`feature-map`,
  `mega-skillstate`). They are live dependencies of this host and the measured
  ground truth for the plugin API; changing them silently changes both.
  *Pinned by:* review only - treat it as a review gate.
- **The README is for users.** Implementation detail belongs in `docs/SPEC.md`
  for behavior and here for working knowledge, and the user must be consulted
  before technical detail is added to the README.

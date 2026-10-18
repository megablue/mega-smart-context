# Session handoff - mega-smart-context

Next: `docs/features/README.md` - the feature map. Read only the page for your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it disagrees with the code, the code is right. `AGENTS.md` is the process doc, `docs/features/` is the feature map and `docs/SPEC.md` is the behavior spec. This file is the volatile one - it exists so a new session knows *where things stand*, not *how they work*.

As of `main` (the analysis commit, v0.1.5) - 2026-10-18.

## State

- **v0.1 is implemented and the gate is green.** `npm run typecheck` passes; `npm run smoke` prints `smoke: 67 assertions passed`; `npm run test:install` prints `install smoke: 17 assertions passed`; `npm run version:check` passes.
- **The live run exposed one real bug, now fixed in the source and synced to the project copy.** A tool result whose `result.type` is `content` (a multi-part result, e.g. two text blocks) was eroded by writing a string into `result.value`. OpenCode's `SessionModelRequest.prepare` maps over that array (`l.value.map`), so every continuation of that turn failed with **"session failed: l.value.map is not a function"**. `erodeToolResults` now shrinks only the text parts and keeps the array; `json` results are left untouched. Pinned by three new smoke assertions. **The running host still has the old code until OpenCode restarts.**
- **The install routine is coded.** `scripts/install.ts` copies the shippable set into the user or project scope, reports drift, and removes a copy. `package.json` has `plugin:install`, `plugin:install:project`, `plugin:uninstall`, `plugin:status` and `test:install`. `README.md` is the user-facing install and configure guide.
- **The package `options.json` is now a real config layer.** `src/core/config.ts` resolves defaults -> package options -> host options -> user file. The adapter reads `options.json` from the package root (`OPTIONS_PATH`).
- **mega-skillstate is disabled, not removed.** `C:\Users\mega\.config\opencode\mega-skillstate.json` has `"enabled": false`; the user restarted OpenCode. Re-enable by setting it back to `true` and restarting.
- **Install scope is USER-only, by decision.** The user copy at `~/.config/opencode/plugins/mega-smart-context` is the live one; the project copy under `.opencode/plugin/` was removed so exactly one instance loads (the host loaded both until the 15:15 restart). A fresh clone installs either scope with the commands in `README.md` - one scope, never both.
- **The plugin has run live (v0.1, OpenCode 2.0.32), and the live verification is complete.** Confirmed: the `<smart-context>` block on every request, `smart_context` callable by name, per-session memory that survives a restart, a child session with its own empty memory (parent counts do not leak), `/context` delivery, and the `compaction` hook. The compaction probe (a seeded session, then a manual compact) produced a checkpoint whose summary was exactly the rendered memory block - `owned`, no host summarization. The live message shape also disproved the fake host in one place: a real tool result can be `{ result: { type: "content", value: [...] } }`, which the smoke only modelled as `type: "text"`.
- **The erosion fix is live.** OpenCode restarted at 22:11, after the 22:07 edit of `view.ts`; the installed copy is in sync (26 files) and the gate is green again (`typecheck`, `smoke: 49`, `install smoke: 17`).
- **The README gained its packaging furniture.** A header image (`docs/assets/header.svg`), a badge strip (license, version, topic, dependencies, PayPal), a `What it does` section, `Checks`, `Where the details live`, a support section, and a linked `LICENSE` file; `.github/FUNDING.yml` carries the PayPal link. User-facing only - no implementation detail, per the `AGENTS.md` rule.
- **The version is now derived per commit.** `src/core/version.ts` (pure) + `scripts/version.mjs` derive `MAJOR.MINOR.(git rev-list --count HEAD - countBase)`; `package.json` carries `megaSmartContext.countBase` (3) and the hook stamps the patch. `/context status` shows the loaded build's version, read from its own shipped `package.json`, and the README version badge follows the same field. The repo's `core.hooksPath=.githooks` was set for this clone; `.githooks/commit-msg` forwards to the machine-wide co-author guard. See `docs/features/version.md`.
- **The enabled-vs-disabled analyzer ships.** `record.history` keeps one `PassSample` per context pass (constant `MAX_HISTORY` 200, first sample kept, **not** part of the payload, no version bump); `PassSample.transcriptTokens` is the *character* size of the full input at pass time - what a disabled plugin would send. `npm run analyze` (`scripts/analyze.mjs`) reads the record back **read-only** from OpenCode's database and prints the per-pass curve, or `lastReport` plus an approximate baseline for a pre-history record. See `docs/features/analysis.md`.

## Open threads

- **Push the repository.** `main` has no remote yet; add one when the user is ready (the README badge URLs assume `github.com/megablue/mega-smart-context`).
- **Re-sync the install and restart.** The user-scope copy lags `main` after the packaging commit. Run `npm run plugin:install`, then restart OpenCode for `/context` to print the version.
- **Consider a dedicated missing-section ref test.** The smoke's `ref` uses `context-handoff.md` / `How & why`, which resolves. The `undefined` branch in `createFsFeatureMap` is reviewed, not asserted.
- **Consider a live test for a mixed-shape turn.** The erosion fix is live but has not yet been exercised by a real multi-part result over `maxResultChars` since the restart.

## Known gaps (volatile; the durable traps live in the feature pages)

- **The smoke is not the host.** It exercises the transform, the tool, the archive, subagents, compaction and the installer through a fake `ctx`. The live run found one shape mismatch the fake host hid (`content` tool results); assume other shapes can differ too.
- **`/context` delivers through `ctx.session.prompt`.** That creates a user message, which the next context pass treats as a real turn. It does not corrupt memory, but the command's report can become part of the conversation it is reporting on. There is no display-only channel: `ctx.session.synthetic` still starts a model turn (probed live), so `prompt` is the honest choice.
- **A child's archive survives until the store's LRU evicts it** (`MAX_SESSIONS` 64). There is no per-child cleanup on session end.
- **The archive caps are per session** (`archiveMaxTurns`, `archiveMaxChars`); there is no global storage budget.
- **The ref reader uses the session directory's `docs/features/`.** A worktree without that directory reports "section not found" but still stores the pointer.
- **The install is a copy.** Editing the source tree does not update an installed copy; run `plugin:install` again and restart. `plugin:status` reports the drift.
- Environment note: this shell is Windows PowerShell 5.1 - no `&&` (a parser error), chain with `;` and check `$LASTEXITCODE`. `Get-Content` can render UTF-8 punctuation as mojibake, so verify a written `.md` with a `node -e` UTF-8 read rather than trusting the console.

## Local-only state (not on the remote)

- **`node_modules/` is ignored; `package-lock.json` is tracked** (the pre-commit hook stamps its version fields too).
- Run `npm run hooks` once per clone: it sets `core.hooksPath=.githooks`, which is what makes the pre-commit stamp and the `commit-msg` forward fire. This clone has it set.
- The user-scope copy at `~/.config/opencode/plugins/mega-smart-context` must be re-synced (`npm run plugin:install`) after this change and OpenCode restarted; this tree ships 30 files (the analyzer adds `scripts/analyze.mjs` to the 29).
- `.opencode/plugin/` - empty; the project-scope copy was removed (the user scope is the install), and `.gitignore` covers it.
- `.git` is present (branch `main`); no remote and no tags yet.

# TokenEconomizer integration plan

Status: started on `feat/tokeneconomizer-integration` (0.2.0 line); pricing, loop guard, project facts and tool usage implemented
Work branch: `feat/tokeneconomizer-integration`
Scope: ideas from [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer) that fit mega-smart-context
Baseline: mega-smart-context `a956106` (0.1.61), main == origin/main

This is a working plan, not the project's HTML documentation. It records the upstream
revision the analysis was based on so a later review can tell whether TokenEconomizer has
moved, and it lists what to port, what to rewrite, and what to leave alone.

## 1. Upstream reference

| | |
| --- | --- |
| Repository | https://github.com/microsoft/TokenEconomizer |
| Branch | `main` |
| Commit | `1bfeccdcecf48333b22762ad1dd9e36c6dc065df` |
| Short | `1bfeccd` |
| Date | 2026-11-19 18:36:48 -0800 |
| Subject | Merge pull request #283 from microsoft/docs/supported-versions-nov19 |
| Describe | `v0.1.0-369-g1bfeccd` |
| Version | 0.1.0 (pyproject.toml and package.json) |
| Worktree | clean at the time of the review |

### Key files at that revision

Blob hashes are the exact content fingerprints; use them if the upstream history is rewritten.

| File | Blob |
| --- | --- |
| `tokeneconomizer/microskills/envfacts.py` | `fa125b7887965e440314b21b0e740ba7c83e75a2` |
| `tokeneconomizer/microskills/distiller.py` | `ae42cec35177041bfd06277365cec63f89f8dabe` |
| `tokeneconomizer/microskills/lifecycle.py` | `7bae14c03f648eb9d8adeaae87c93aa07a7d7527` |
| `tokeneconomizer/microskills/stage.py` | `1957890084595680994ff321cd923845e98adfe9` |
| `tokeneconomizer/loopguard/rules.py` | `a9c6801d28d834509c821de616baa1d86e093196` |
| `tokeneconomizer/loopguard/state.py` | `74c17d5073c9918f3fe0a337e476b069ac76ace0` |
| `tokeneconomizer/loopguard/turn.py` | `7475298531117f6e632599a30a9f6be901d0e78e` |
| `tokeneconomizer/toolprune/stage.py` | `202041f779318a79ab6902d8a3a28ed1f6ba569d` |
| `tokeneconomizer/toolprune/tools.py` | `9566f1714b7d4256c0912aec068d83358416c85d` |
| `tokeneconomizer/plugin/context.py` | `7308998c2a963fe624159b2172fbf1984ecdffe0` |
| `tokeneconomizer/plugin/fold.py` | `1e64ad640f9c7d7540488f76edb117c15c82476a` |
| `tokeneconomizer/plugin/config.py` | `369bac97d57f78a216434cfbb18739883c44babd` |
| `tokeneconomizer/plugin/repomap.py` | `9d4cbc3f1dfa718ac78fe3974c52ad4d90ceda35` |
| `tokeneconomizer/plugin/repomap_gen.py` | `53ea0ed33cb51d94a4d661677430cd41915eece7` |
| `tokeneconomizer/pricing.py` | `9e14a3df0732b159efc6b29417030bbf0b7ea0bd` |
| `tokeneconomizer/ledger.py` | `7e781e870391e55e7da486da4304cd1e41152fbc` |
| `plugin/opencode/tokeneconomizer.ts` | `c0d3dbb37e170cc640495481793fa37637323721` |
| `plugin/scripts/te-hook` | `6281f62cad17bbd88db2ed26d05571c2c8ca0db5` |
| `plugin/scripts/te_bootstrap.py` | `f32dcc4ed1e0f8eab3b56493af563466ee2acd8a` |

### How to detect upstream changes later

```powershell
git -C C:\Users\mega\projects\TokenEconomizer fetch origin
git -C C:\Users\mega\projects\TokenEconomizer log --oneline --decorate 1bfeccd..origin/main
git -C C:\Users\mega\projects\TokenEconomizer diff --stat 1bfeccd..origin/main -- tokeneconomizer/microskills tokeneconomizer/loopguard tokeneconomizer/toolprune tokeneconomizer/pricing.py tokeneconomizer/ledger.py tokeneconomizer/plugin plugin/opencode/tokeneconomizer.ts
git -C C:\Users\mega\projects\TokenEconomizer ls-tree -r origin/main -- tokeneconomizer/microskills tokeneconomizer/loopguard tokeneconomizer/toolprune tokeneconomizer/pricing.py plugin/opencode/tokeneconomizer.ts
```

Re-read the diff before porting anything. The mechanisms are tuned; do not re-tune their
constants without a measured reason.

## 2. Verdict

TokenEconomizer is a post-session, cross-session optimizer: it folds finished sessions into
per-repository facts, prunes tools for future sessions, and nudges a turn that is looping.
mega-smart-context is a live, in-request context owner: it owns the payload, the memory
checkpoint, the working window, compaction, the archive and the raw store.

The compatible ideas are the ones that add **knowledge and judgment outside the request
path**, not another payload rewriter. The three strongest are:

1. **Project-level learned facts** (microskills) - the biggest gap: smart-context has
   per-session memory and a per-session archive, but nothing learned across sessions in the
   same repository.
2. **Loop guard** - cheap, complementary, and cache-safe if it only changes the trailing note.
3. **Cache-aware cost accounting** - pure upside for `analyze` and status.

Do not install TokenEconomizer alongside smart-context: both rewrite the context payload and
both use the same OpenCode hooks. Port the ideas.

## 3. Invariants to preserve in smart-context

- One context owner: no second context-rewriting plugin.
- Append-only checkpoint: a patch appends a delta; only a fold moves the checkpoint.
- Cache safety: inside a turn only the trailing state note may churn. A learned-facts block
  must be byte-identical for the whole session.
- The model owns semantic memory. Learned facts are observations, not model-written content;
  they must be inspectable and forgettable.
- No model calls on the request path. The free envfacts layer only; the paid proposer and
  judge stay out until measured.
- No tool-schema changes mid-session.
- Local-only state; no new network calls.

## 4. Fit by mechanism

| Mechanism | Fit | Decision |
| --- | --- | --- |
| Microskills / envfacts | High | Port the free layer, lifecycle, render and injection |
| Loop guard | High | Port the heuristic state machine and envelope; skip the paid judge |
| Pricing / effective tokens | High | Port into `scripts/analyze.mjs` and status history |
| Tool pruning | Medium | Report-only usage evidence first; no automatic deny-list writes |
| Repo map | Low-medium | Defer; feature-map refs and host search/LSP cover most of it |
| Paid fact proposer / judge | Low | Skip by default |
| History import / multi-agent trace parsers | Low | Skip; OpenCode is the only host |

## 5. Phase 1 - high value, low risk

### 5.1 Project-level learned facts (in progress in 0.2.0)

Goal: a project-scoped store of short, evidence-backed environment facts, injected at
session start as a small stable system block and removable by the user.

What to port from upstream:

- The free envfacts families in `microskills/envfacts.py`:
  - `form_repair`: command A fails here, command B works (e.g. `npm test` vs
    `npm test -- --run`).
  - `absent_tool`: the command is missing and no alternative worked.
  - `boundary`: outbound connections to host H are refused.
  - `arg_repair`: test labels/options syntax.
  - `env_value`: an environment variable the project needs.
  - `empty_probe`: no git remote/history beyond the checked-out commit.
- The lifecycle in `microskills/lifecycle.py`:
  - `K_PROMOTE = 3` confirmations (on different edited files when drift applies).
  - `GAMMA = 0.8` recency decay; `LAMBDA = 5.0` contradiction weight.
  - `FIRE_GATE = 0.40` and `FIRE_MIN_N = 4` before a fact is injected.
  - `HARD_KILL = true` for high-stakes facts.
- The render cap: `MAX_FACTS = 4`, `MAX_TOKENS = 150`, four characters per token, header
  plus one bullet per fact.
- The lint in `envfacts.py` that refuses completion/verification advice ("skip", "no need",
  "done", "verify", "stop").

Design:

- New `src/core/project.ts`:
  - `ProjectKey`: git root when available, else the canonical directory; case-normalized
    on Windows; hashed before use as a storage key.
  - `ProjectRecord`: `{ version, directory, facts: Record<string, Fact>, toolUsage, envelope }`.
  - `Fact`: `{ id, family, claim, params, lifecycle, firstSeen, lastSeen, injected }`.
  - `ProjectStore`: same optimistic-concurrency pattern as `SessionStore`, storage key
    `project/<hash>`.
- New `src/core/facts.ts`:
  - the lifecycle state machine, claim rendering, lint, and forget/unforget.
  - a render function capped at 4 facts / 150 tokens.
- New `src/core/facts-learn.ts`:
  - extract observations from tool calls and results in `event.messages`.
  - shell tools first (`shell`, `bash`, `cmd`, `powershell`): normalized command template,
    exit/error signature, missing-command detection, post-failure success.
  - no assistant text, no model output, no arbitrary file content.
  - redact home paths, tokens, URLs with credentials, and long values.
- Learning timing:
  - collect a bounded `record.observations` array during the pass;
  - fold observations into the project store when a new user turn starts (the previous turn
    is complete) or on `session.idle` / `session.deleted` via `ctx.event.subscribe()`;
  - deduplicate by turn id so a repeated idle event does not double-count.
- Injection timing:
  - on the first pass of a session, load the project record and store a session snapshot
    (`record.facts = { version, ids, rendered }`);
  - every later pass reuses the snapshot byte-for-byte;
  - a fact learned mid-session is queued for the next session, never injected retroactively.
- Placement: a separate system part before the messages, e.g.
  `# Learned project facts` with one bullet per fact and its id. It is not part of the memory
  document, so it never rewrites page 1.
- Config keys (install-level, not profile keys):
  - `projectFacts` (boolean; start behind a flag, default on once validated)
  - `projectFactsMaxFacts` (4)
  - `projectFactsMaxTokens` (150)
  - `projectFactsPropose` (false; reserved for a future paid proposer)
- Commands/UI:
  - `/context facts` lists active/candidate facts with ids and evidence counts.
  - `/context facts forget <id>` / `unforget <id>`.
  - a status row shows `facts N (M injected)` and the block's token estimate.
- Tests:
  - lifecycle: candidate -> active after 3 drift-valid confirmations; retired on
    contradictions; firing gate blocks below 40% or under 4 exercises.
  - render: 4 facts/150 tokens, deterministic order, stable across passes.
  - injection: two passes produce the identical system part; a fact learned mid-session
    does not change the current session's block.
  - privacy: home path, token-like string and URL credentials are redacted.
  - forget: a forgotten fact disappears from the next session and is not re-learned under
    the same id.
- Acceptance:
  - a fresh session in a repo with facts shows the block exactly once, under 150 tokens;
  - the second pass is byte-identical;
  - `/context facts forget` changes the next session only;
  - no model calls and no new network activity.

### 5.2 Loop guard (implemented in 0.2.0)

Goal: detect a turn that is repeating failed work and redirect it once, without stopping the
turn or rewriting earlier messages.

What to port:

- The per-turn digest: tool name, normalized arguments hash, success/failure, error
  signature, edit count, verification commands.
- The learned per-repository envelope from turns that ended green (TokenEconomizer uses the
  successful-turn distribution; default backstop 2.5x, aggressive 1.8x).
- Conservative thresholds: around 20 tool calls at the default level, 14 aggressive; one
  redirect per prompt-turn (`loopguard_nudges = 1`).
- The redirect-before-notice rule: an unspent redirect goes first; a "still stuck" notice
  needs a second stuck segment.
- Shell-edit counting: `sed -i`, redirects/tee into source, `patch`/`git apply`; otherwise
  an agent that edits through the shell looks idle.

Design:

- New `src/core/loopguard.ts` - a pure function over the pass's messages:
  `update(state, messages) -> { state, redirect? }`.
- State lives on the session record (`record.guard`), bounded and reset on a new user turn.
- Envelope lives in the project record, learned from `record.history` turns that ended with a
  success signal; fall back to 20 calls until enough samples exist.
- Trigger examples:
  - the same normalized call + error signature 3 times;
  - 5+ failed calls with no successful verification;
  - 8+ edits without a test/build/typecheck;
  - turn length over the envelope and still no progress.
- Output: one trailing line in the state note (or a separate trailing message after it), e.g.
  "process check: the last 3 attempts repeated the same error; change the hypothesis or the
  input before trying again." No abort; no tool-result mutation.
- Config (install-level):
  - `loopGuard` (default true after validation)
  - `loopGuardMode`: `default` | `aggressive`
  - `loopGuardNudges`: 1
  - `loopGuardMinCalls`: 20
  - `loopGuardEnvelope`: true
- Do not port the paid judge initially. If a judge is added later, run it off the request
  path and pick up the verdict on a later pass.
- Tests:
  - a synthetic repeated-failure turn gets exactly one redirect;
  - a green turn never gets one;
  - a new user turn resets the counter;
  - the envelope comes from history and clamps to sane bounds;
  - the redirect is the only changed bytes in the payload.
- Acceptance:
  - no redirect in a normal 10-call turn;
  - one redirect on a synthetic 20-call failure loop;
  - two passes over the same messages produce the same guard decision.

### 5.3 Cache-aware cost accounting (implemented in 0.2.0)

Goal: report what the plugin actually saved and what it cost, with cached tokens weighted
correctly.

What to port:

- `pricing.py`: per-model weights for input, cache read, cache write (5m/1h), output.
  Cache reads are ~0.1x, cache writes ~1.25x (2x for 1h), output ~5-8x.
- `effective_tokens()`: reweight the per-pass token breakdown into fresh-input equivalents.
  Raw token counts overstate cached re-reads and understate output.

Design:

- New `src/core/pricing.ts` with the weight table and `effectiveTokens(usage, model)`.
- `scripts/analyze.mjs` reads the host session log (already does) and reports:
  - raw tokens vs effective tokens vs estimated dollars;
  - a savings line: erosion, raw store, `rebuildSaved`, facts block, loop nudges;
  - cache read/write/input/output split when the host exposes it.
- Status/history can show effective tokens for the last pass; the TUI stays read-only.
- Tests: known usage vectors produce expected effective tokens; unknown model ids fail
  loudly in the analyzer rather than silently using a default.
- Acceptance: the analyzer's totals reconcile with the host log, and the existing raw-token
  report remains available.

## 6. Phase 2 - report first, apply later

### 6.1 Tool usage report (in progress in 0.2.0)

TokenEconomizer requires 10 unused prompts across at least 2 sessions, or 5 sessions,
before proposing a tool removal; high-risk tools need a multiple. For smart-context:

- record per-project tool usage counts from observed tool calls;
- show unused tools in `/context tools` and the status dialog;
- do not auto-hide tools. Changing the tool schema mid-session invalidates the cache and can
  break Code Mode. If applying ever lands, it happens at session start via host config, after
  the report proves useful.

### 6.2 Repository map (deferred)

TokenEconomizer's map is aider's tree-sitter tags ranked by PageRank, generated in a separate
Python process, cached per commit, opt-in. Smart-context already has feature-map refs plus the
host's search/LSP tools. Porting aider and tree-sitter is a large dependency for an uncertain
win. If a map is wanted later, start with an on-demand `git ls-files` + package-manifest
summary, cached by commit, never injected automatically.

### 6.3 History import (deferred)

Seeding facts from sessions that predate the plugin would require a new importer over
OpenCode's session DB. The live free-facts layer should prove itself first.

## 7. What not to port

- The Python dispatcher and subprocess hook bridge. Smart-context is TypeScript-native and
  already has the same OpenCode seams: `session.hook("context")`, `tool.hook("execute.after")`
  and `ctx.event.subscribe()`.
- Paid judge/proposer side calls on the request path.
- Automatic tool deny-list writes.
- Aider/tree-sitter/PageRank repo maps.
- Multi-agent trace parsers and history import.
- "Stop the turn" mode. The plugin can nudge, not abort the host turn.
- Any fact derived from assistant prose rather than an observed command outcome.

## 8. Suggested sequence

| Step | Deliverable | Effort | Gate |
| --- | --- | --- | --- |
| 1 | `pricing.ts` + analyzer effective tokens | 0.5 day | analyzer reconciles with host log |
| 2 | `loopguard.ts` + tail note + envelope | 1 day | one redirect on a synthetic loop, none on green |
| 3 | `project.ts` + free envfacts + lifecycle + render | 1.5-2 days | 150-token block, stable per session, forget works |
| 4 | `/context facts` + status row + tests | 0.5 day | user can inspect and remove facts |
| 5 | tool usage report | 0.5 day | read-only report, no schema changes |
| 6 | repo map / paid proposer | only if measured | not scheduled |

## 9. Open questions

- Should the project key be the git root or the OpenCode directory? Recommend git root when
  available, else the canonical directory, so worktrees share facts.
- Should `projectFacts` ship on or default off for one release? Recommend off in the first
  release, on after the stability and privacy tests pass.
- Should facts be visible to subagents? Recommend yes: the project block is read-only and
  identical for parent and child; the child's memory stays independent.
- Should the loop guard be per-profile? Recommend install-level, because a profile changes
  budgets, not process policy.
- How long to keep candidates and retired facts? Recommend 90 days, capped by count.

## 10. Change log for this plan

- 2026-11-21: created from TokenEconomizer `1bfeccd` (v0.1.0-369-g1bfeccd) and
  mega-smart-context `a956106` (0.1.61).
- 2026-11-22: 0.2.0 pricing slice implemented: `src/core/pricing.ts`, the analyzer's
  host usage/effective-token report, `--model`/`--weights`, smoke tests, and the
  analysis page.
- 2026-11-22: loop guard implemented: `src/core/loopguard.ts`, session guard state,
  install-level config, one trailing-note redirect, and smoke coverage.
- 2026-11-22: project facts integrated through `project-session.ts`, the adapter resolver,
  the stable system block and `/context facts`; the read-only tool-usage report is wired
  through the pass, `/context tools` and the status sidebar.

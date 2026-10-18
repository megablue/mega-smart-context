# mega-smart-context - behavior spec

User-visible behavior only: what the product does and what a user sees, readable without knowing the code. Behavior belongs here even when the code is where the reason for it lives. The reason, the mechanism and the traps live in `docs/features/`; process and hard rules live in `AGENTS.md`.

## Scope

`mega-smart-context` is an OpenCode 2.0 CLI plugin that hands context management to the model. Instead of replaying the append-only transcript, every model request is rebuilt from three parts:

1. the **memory document** the model wrote;
2. a short **working window** of the newest turns, verbatim;
3. the **current turn**.

The model is told what it owns and how to use it. It folds durable facts, decisions, files and open threads into memory, archives a turn it wants to keep, or purges one it does not. The plugin enforces the caps, keeps the current turn intact, and never edits the durable transcript.

It is for long agent sessions where replaying history grows without bound.

It deliberately does **not**:

- edit the durable transcript; it rewrites only the request the host is about to send;
- run a private model to summarize; there is no automatic semantic fold;
- seed files, facts or a plan from observed tool calls; the model writes them;
- protect the first user message; `goal` is the only guaranteed record of the request after the first turn leaves the window;
- share memory between a parent and a subagent; every session is independent;
- replace the host's compactor when memory is empty;
- use a real tokenizer; every number is an estimate at `charsPerToken`.

## What the model sees

Every request starts with a `<smart-context>` block:

```
budget: memory 12.4k/50k est · working 6.1k/16k est · refs 3 · pending 1 · archive 41
goal: "..."
## Plan
- [active] 1. ...
## Facts
- "key": "value"
## Files
- "path": "what was done there"
## Decisions
- "name": "decision and why"
## Open
- "..."
## Refs
- docs/features/x.html#how-why - "gist" (~38 est; feature_map page:"x.html" section:"how-why")
## Notes
"..."
## Pending eviction
- u12 · "mechanical gist" · ~2.1k est
  -> smart_context action:"archive" turn:"u12" gist:"..." (or action:"purge" turn:"u12")
```

An empty `goal` renders an explicit warning. Values are JSON-quoted so a newline or a delimiter inside a model-written note cannot change the shape. The block is data, not instructions; the standing policy lives in the system message.

The working window follows the block, verbatim, newest turns first in budget terms. The current turn is always kept, including every tool call and result the model just asked for. Completed turns lose their private reasoning; the current turn keeps it.

Host **mode notices** - the Plan/Build reminders the host injects as synthetic user messages - are not replayed as turns. The plugin strips them from the working window and pins every distinct text into the system prompt under "## Pinned host notices", newest first. A mode switch therefore cannot evict a turn, and the standing instruction survives every pass until a newer notice replaces it. The model may retire a superseded notice with `smart_context { action:"notice", remove:"<id>" }`; the newest is the live instruction and a removal of it is refused.

## The first turn and `goal`

On the first turn the current user message is visible. Once it leaves the working window it is gone; only `goal` survives. The policy tells the model to write the request into `goal` on the first turn, and the block shows `goal: (empty ...)` until it does. There is no protected first message and no automatic seed.

## Budgets

| Budget | Default | What it measures |
| --- | --- | --- |
| `memoryTokens` | 50,000 | the rendered memory document, estimated |
| `workingTokens` | 16,000 | the verbatim working window, estimated |
| `charsPerToken` | 4 | the divisor that turns characters into estimated tokens |
| `maxResultChars` | 4,000 | one tool result larger than this is shortened head/tail |

A tool result is shortened by keeping a head, a tail and a marker with the number of missing characters. The tool call and its result keep their ids and their order. A turn that alone exceeds the working budget is still kept; the header reports `OVER CAP` and the policy asks the model to fold sooner.

When the host reports a model context size, the plugin also warns when memory plus working would exceed 90% of it. It does not silently shrink either side.

## Eviction and the archive

A turn that leaves the working window becomes **pending**. The model sees it under "Pending eviction" and chooses one of:

- `archive { turn, gist, keepRaw? }` - store a one-line gist, and optionally the raw messages, in the cold archive;
- `purge { turn }` - discard it permanently;
- do nothing.

With `autoArchive` on (the default), an unhandled pending turn is archived after `evictionLead` new user turns, under a mechanical gist (the first line of its user message and its tools) and with its raw messages kept. The model can purge it later. With `autoArchive` off, an unhandled turn is dropped when the lead expires.

The archive is cold storage, not a second working set. `smart_context` with `action:"recall"` refuses unless the call includes `lost:true`; without it, the tool returns an instruction instead of results. `expand { turn }` returns the raw turn, or the gist when no raw was kept. The archive is capped by `archiveMaxTurns` and `archiveMaxChars`, newest wins.

## Subagents

Every session - top-level or child - has its own memory, working window, pending turns and archive, keyed by session id. A child is detected by `parentID`. There is no inheritance in either direction; the only bridge is the normal tool result when the child finishes, which the parent can fold into its own memory.

`subagents: true` (the default) applies the same transform to child sessions. `subagents: false` leaves child sessions untouched and passes their requests through unchanged.

## Stored state

Each session's memory, pinned host notices, pending turns and archive live in OpenCode's plugin storage, keyed by session id, and survive a restart. Deleting a session at `/sessions` does not notify the plugin, so the record would outlive it; on the next start the plugin asks the host whether each record's session still exists and removes the ones that are gone. A lookup that fails for any other reason keeps the record, and storage is shared by every project, so a record belonging to another project is left for that project's instance. The archive and the transcript text inside it are reclaimed when the record is removed.

## Compaction

When the host asks for a checkpoint summary, the plugin returns the rendered memory document and skips the host's summarizer. If memory is empty, it declines and lets the host summarize; returning an empty block would erase the checkpoint in the name of owning it.

## Feature-map references

`smart_context { action:"ref", page, section, gist }` stores a pointer plus the model's own one-liner. It reads the section from `docs/features/<page>` - the HTML page first, the Markdown page as a fallback - reports the gist and section costs, and tells the model which is shorter. The reference counts toward `memoryTokens`. A section that cannot be read is reported, but the pointer is still stored.

## The model surface

`smart_context` actions:

| Action | Effect |
| --- | --- |
| `read { key? }` | print one memory key, or the whole document |
| `patch { patch }` | merge a patch; maps merge, lists replace, `null` resets a key or deletes one map entry |
| `stats` | memory, working, pending and archive usage |
| `ref { page, section, gist }` | store a feature-map pointer and compare costs |
| `archive { turn, gist, keepRaw? }` | move a pending turn to the archive |
| `purge { turn? \| query? }` | delete a pending or archived turn, or matching entries |
| `recall { query, lost:true }` | search the cold archive; refuses without `lost:true` |
| `expand { turn }` | read an archived turn back |
| `notice { remove? }` | list the pinned host notices, or retire a superseded one by id; the newest is refused |

The `/context` command prints the same state for the user:

| Command | Effect |
| --- | --- |
| `/context` or `/context status` | memory, working, pending, archive, goal, and the loaded build's version |
| `/context now` | archive every pending turn now |
| `/context memory <key>` | print one memory key |
| `/context recall <query>` | search the archive as the user |
| `/context purge <turn>` | delete a pending or archived turn |

The version is `MAJOR.MINOR.PATCH`: MAJOR.MINOR is the released line, and PATCH is the number of commits since the base recorded in `package.json`, so it advances with every commit and the README version badge follows the same field. What `/context` prints is the loaded build's own version, which lags the repository until the install is re-synced.

## Settings

Every setting is read from four layers, most specific last: built-in defaults, the package `options.json`, the plugin `options`, and `~/.config/opencode/mega-smart-context.json`. The user file is created with every default on first run and never overwritten. A source replaces only the keys it sets. An unknown key or a wrong type is an error: the plugin refuses to load rather than silently keeping a default the user believes they replaced.

| Setting | Default | Range | Where |
| --- | --- | --- | --- |
| `enabled` | `true` | bool - master switch | config file |
| `memoryTokens` | `50000` | >= 1000 - memory cap, estimated | config file |
| `workingTokens` | `16000` | >= 500 - working window cap, estimated | config file |
| `charsPerToken` | `4` | 2..8 - estimation divisor | config file |
| `subagents` | `true` | bool - manage child sessions independently | config file |
| `evictionLead` | `1` | 0..20 - new user turns a pending turn is shown before auto-archive/drop | config file |
| `autoArchive` | `true` | bool - archive unhandled evictions | config file |
| `archiveMaxTurns` | `200` | 0..5000 - archived turns per session | config file |
| `archiveMaxChars` | `400000` | >= 10000 - archived characters per session | config file |
| `refs` | `true` | bool - offer the `ref` action | config file |
| `maxResultChars` | `4000` | >= 200 - per-result erosion limit | config file |
| `manualCommand` | `true` | bool - register `/context` | config file |
| `debug` | `false` | bool - log pass decisions to stderr | config file |

The environment overrides are for tests and unusual installs: `MEGA_SMART_CONTEXT_CONFIG` points at a different user file, and `MEGA_SMART_CONTEXT_NO_USER_CONFIG=1` skips the user layer entirely.

## Out of scope

- No cross-session or shared memory.
- No automatic semantic summarization, file seeding or plan seeding.
- No protected first user message.
- No exact tokenizer or per-model token accounting; the caps are estimates.
- No transcript edits; host compaction remains the only thing that writes a checkpoint, and this plugin owns that checkpoint only when memory is non-empty.

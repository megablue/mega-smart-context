# Analysis - what a session would have cost with the plugin off

Status: shipped (v0.1) - Read when: `npm run analyze`, `scripts/analyze.mjs`, `history`, `PassSample`, the disabled baseline, "what would this session have cost", "compare enabled vs disabled".

## What it does

- Answers "what would this recorded session have cost with the plugin disabled?" offline, read-only, with no host restart.
- Reads the plugin's own session record out of OpenCode's SQLite database; it never rebuilds a message list from `session_message`.
- With `history`: a per-pass table (memory / working / policy / total / transcript), peak, min, mean, and where it crossed `OVER CAP`.
- Without `history` (a record written before the feature): `lastReport` and an approximate baseline, labelled approximate.
- Lists every plugin id that owns a record for the session, so a stale duplicate install is visible.

## Map

- `scripts/analyze.mjs` - `analyze`, `render`, `run`, `parseArgs`, `newestSession`, `sessionByID`, `pluginRecords`, `transcriptEstimate`, `summarizeHistory`, `decodePluginId`.
- `src/core/types.ts` - `PassSample`, `SessionRecord.history`, `LastReport`.
- `src/core/context.ts` - `buildPayload` writes one sample per pass.
- `src/core/state.ts` - `MAX_HISTORY`, `normalizeHistory`, `normalizeSample`, `trimHistory`.
- `package.json` - the `analyze` script; `files[]` already ships `scripts/`.
- `scripts/smoke.mjs` - the history, baseline and trim assertions.

## How & why

### The counterfactual is recorded, not rebuilt

The disabled baseline is the request payload, and the one moment both sides are known exactly is the pass itself: in `buildPayload`, `input.messages` **is** what a disabled plugin would send, and the payload it builds is the enabled side. So each pass appends one `PassSample` and the answer is a curve, not a snapshot.

Reconstructing it later from `session_message` is not an option. Those rows are not uniform (a `user` row carries `text` with no `content[]`; an `assistant` row carries `content[]`), and the host's own row-to-message mapper is not ours to mirror. The analyzer only ever reads the record the plugin wrote, plus a byte-length estimate for the fallback.

### The disabled side is characters

A disabled plugin sends the transcript verbatim, so its size is measured exactly as characters (`messagesChars`), stored in `PassSample.transcriptTokens` despite the name. Every other field is an *estimated* token count at `charsPerToken`. To compare, divide: the analyzer's `transcript` column is `transcriptTokens / 4` (the plugin default; the record does not carry the resolved divisor), and `--json` exposes the raw character count.

### Bounded history

`MAX_HISTORY` is a constant (200), not a config key: the samples are diagnostics. Trimming keeps `history[0]` - the cheap full-arc baseline the curve is measured against - plus the newest `MAX_HISTORY - 1`. `history` is **not part of the payload**, so appending a sample leaves the bytes two passes produce identical; the smoke pins both. A record with no `history` (every record written before this feature) loads unchanged, which is why there is no version bump.

### Reading the record

The record lives in OpenCode's `kv` under `plugin:<id>:session/<sessionID>`, where `<id>` is the plugin id as UTF-16**BE** hex (`decodePluginId` reverses it). The database defaults to `~/.local/share/opencode/opencode.db` and is opened **read-only**. With no `--session`, the newest `session_v2` row for the directory is chosen; directories are compared with separators folded and case-insensitively, because the host writes forward slashes and a Windows cwd does not.

## Config keys / UI

| Flag | Default | Effect |
| --- | --- | --- |
| `--session <id>` | newest in `--dir` | analyze this session id |
| `--dir <path>` | cwd | the directory whose newest session to analyze |
| `--db <path>` | `~/.local/share/opencode/opencode.db` | another database |
| `--json` | off | emit the data object instead of the report |

`npm run analyze` runs `node scripts/analyze.mjs`; the tool adds no runtime config key.

## Tests that pin it

- "a pass appends one history sample"
- "transcriptTokens is the raw input's character count"
- "totalTokens is memory + working + policy"
- "a repeat pass over the same transcript keeps the payload bytes"
- "every pass appends a sample"
- "history trims to MAX_HISTORY"
- "the first sample is always kept"
- "the newest sample is kept"

## Related

- `context-handoff.md` - `buildPayload`, where a sample is written.
- `archive.md` - the pending and archive counts the report prints.
- `installation.md` - two install scopes are two plugin ids, which the report lists.

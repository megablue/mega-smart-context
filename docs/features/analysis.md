# Analysis - what a session would have cost with the plugin off

Status: shipped (v0.1) - Read when: `npm run analyze`, `scripts/analyze.mjs`, `history`, `PassSample`, the disabled baseline, "what would this session have cost", "compare enabled vs disabled".

## What it does

- Answers "what would this recorded session have cost with the plugin disabled?" offline, read-only, with no host restart.
- Reads the plugin's own session record out of OpenCode's SQLite database; it never rebuilds a message list from `session_message`.
- With `history`: a per-pass table (memory / working / policy / total / transcript / native / saved), peak, min, mean, and where it crossed `OVER CAP`.
- The `native` column simulates what the host's own `/compact` would have sent (a sawtooth from the same recorded growth); the footer prints savings against both the append-only transcript and that native baseline.
- Without `history` (a record written before the feature): `lastReport` and an approximate baseline, labelled approximate.
- Lists every plugin id that owns a record for the session, so a stale duplicate install is visible.

## Map

- `scripts/analyze.mjs` - `analyze`, `render`, `run`, `parseArgs`, `newestSession`, `sessionByID`, `pluginRecords`, `transcriptEstimate`, `summarizeHistory`, `baselineOf`, `decodePluginId`.
- `scripts/native-compaction.mjs` - `calculateCeiling`, `simulateNative`, `UNKNOWN_WINDOW`, `RESERVE_MIN`, `DEFAULT_KEEP`, `DEFAULT_SUMMARY`.
- `src/core/types.ts` - `PassSample`, `SessionRecord.history`, `LastReport`.
- `src/core/context.ts` - `buildPayload` writes one sample per pass.
- `src/core/state.ts` - `MAX_HISTORY`, `normalizeHistory`, `normalizeSample`, `trimHistory`.
- `package.json` - the `analyze` script; `files[]` already ships `scripts/`.
- `scripts/smoke.mjs` - the history, baseline and trim assertions.

## How & why

### The counterfactual is recorded, not rebuilt

The disabled baseline is the request payload, and the one moment both sides are known exactly is the pass itself: in `buildPayload`, `input.messages` **is** what a disabled plugin would send, and the payload it builds is the enabled side. So each pass appends one `PassSample` and the answer is a curve, not a snapshot.

Reconstructing it later from `session_message` is not an option. Those rows are not uniform (a `user` row carries `text` with no `content[]`; an `assistant` row carries `content[]`), and the host's own row-to-message mapper is not ours to mirror. The analyzer only ever reads the record the plugin wrote, plus a byte-length estimate for the fallback.

### The native-compaction baseline

The second comparison answers "and with no plugin, letting the host's `/compact` manage it?". `scripts/native-compaction.mjs` mirrors the host's `calculateCeiling` and the floor it lands on:

- The ceiling is `window − max(floor(window × 0.1), 16k)` once the window is at least 32k; a smaller window keeps 10%. `--buffer` replaces the reserve, as the host's `buffer` setting does.
- Reaching the ceiling compacts, and the next request is the floor: `keep` (default 15,000) verbatim plus one checkpoint `summary` (default 2,000). Flags: `--keep`, `--summary`.
- Between passes, native grows by the **observed** growth of the recorded transcript. When the observed series drops, the simulation anchors to the observed value instead, because that drop is a real host compaction. The alternative — letting the model keep growing — would overstate native.

`raw` is separate: every positive step is added and nothing resets, which is the append-only baseline. `saved` per pass is `raw − ours`; the footer prints both `vs raw` and `vs native`, comparing peaks.

Three assumptions stay visible rather than hidden: the summary's size, the context window (the record has no `modelContext`; `--context` defaults to 200,000), and provider-native compaction (`settings.compaction.type: "native"`), which is opaque and not modelled. The anchor bias is deliberate: it can only make native look smaller, so the report understates the plugin's advantage. Right after a compaction native is cheaper than we are (~17k); its cost is the climb back to the ceiling, so read the peaks and the mean, not one pass.

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
| `--context <n>` | `200000` | model window for the native baseline |
| `--keep <n>` | `15000` | tokens native compaction keeps verbatim |
| `--summary <n>` | `2000` | tokens a native checkpoint is assumed to occupy |
| `--buffer <n>` | the host's 10% / 16k reserve | reserve below the window |
| `--no-native` | off | skip the native baseline |
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
- "the ceiling leaves 10% of a 200k window"
- "a window too small for 16k keeps 10% instead"
- "an explicit buffer replaces the reserve"
- "the native floor is keep + summary"
- "below the ceiling nothing compacts"
- "crossing the ceiling resets to the floor"
- "an observed drop anchors native instead of resetting it"
- "raw keeps the positive deltas and ignores the drop"
- "native grows again after an anchored reset"
- "raw is the sum of positive deltas"
- "a summary of zero does not crash the floor"

## Related

- `context-handoff.md` - `buildPayload`, where a sample is written.
- `archive.md` - the pending and archive counts the report prints.
- `installation.md` - two install scopes are two plugin ids, which the report lists.

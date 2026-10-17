# Archive - eviction, cold storage, and the lost gate

Status: shipped (v0.1) - Read when: pending eviction, `autoArchive`, `evictionLead`, `recall`, `lost:true`, `archivePending`, or "a turn disappeared".

## What it does

- Turns a turn that leaves the working window into a pending entry with a mechanical gist and its eroded raw messages.
- Lets the model archive it with its own gist (optionally keeping the raw), purge it, or leave it.
- With `autoArchive` on, archives an unhandled pending turn after `evictionLead` new user turns, so nothing is irrecoverably lost.
- Keeps the archive cold: `recall` refuses without `lost:true`, and the results are matches, not a replayed window.
- Caps the archive by turn count and characters, newest wins.

The user-visible behavior is in `docs/SPEC.md` under "Eviction and the archive".

## Map

- `src/core/archive.ts` - `mechanicalGist`, `turnMessages`, `archivePending`, `autoArchivePending`, `purgeTurn`, `purgeQuery`, `findArchived`, `recall`, `archiveChars`, `trimArchive`, `knows`.
- `src/core/context.ts` - the drop branch, the age step, and the auto-archive call.
- `src/core/memory-tool.ts` - the `archive`, `purge`, `recall` and `expand` actions.
- `src/core/command.ts` - `/context now`, `/context recall`, `/context purge`.
- `src/core/types.ts` - `PendingTurn`, `ArchivedTurn`.
- `scripts/smoke.mjs` - the pending/auto-archive/lost-gate assertions.

## How & why

### Pending is not "everything old"

Only a turn that was in the previous pass's working window and is not in the current one becomes pending. The first pass only seeds `seenTurns`; a plugin enabled mid-session must not archive turns it never managed. A turn the host already trimmed is skipped: it is not recoverable, and the model had the same chance to fold it.

### Age is counted in user turns

`age` increments only when the window's turn id list changes, which happens on a new user turn, not on a tool continuation. A ten-call turn therefore consumes one eviction lead, not ten. `evictionLead` is the number of new user turns a pending turn is shown before it is auto-archived (or dropped when `autoArchive` is off).

### Manual archive

`archive { turn, gist, keepRaw? }` requires a gist and a pending turn id. `keepRaw: true` keeps the messages for `expand`; the default is gist only, because the raw is the expensive half. The model's gist replaces the mechanical one.

### Auto-archive

With `autoArchive` on, an unhandled pending turn is archived with its mechanical gist and its raw messages. The raw is kept deliberately: a mechanical gist alone would make `expand` useless. The model can still `purge` the entry afterwards.

### Recall is gated

Without `lost:true`, `recall` returns an instruction, not results. The gate is mechanical because the policy alone is not enough: an archive searched out of habit is a second working set, and the plugin exists to keep the working set small. `recall` searches gists and, when raw exists, the rendered raw text. `expand` returns the raw turn, or the gist with a "gist only" note.

### Caps

`trimArchive` drops the oldest entries while the archive exceeds `archiveMaxTurns` or `archiveMaxChars`. It keeps at least one entry so a single huge turn does not empty the archive.

## Config keys / UI

| Key | Default | Effect |
| --- | --- | --- |
| `autoArchive` | true | archive unhandled evictions instead of dropping |
| `evictionLead` | 1 | new user turns a pending turn is shown |
| `archiveMaxTurns` | 200 | per-session turn cap |
| `archiveMaxChars` | 400000 | per-session character cap |

`/context now` archives every pending turn; `/context recall <query>` searches as the user; `/context purge <turn>` removes one.

## Tests that pin it

- "an evicted turn is shown as pending"
- "the pending turn auto-archived after the lead"
- "recall refuses without lost:true"
- "recall returns matches when lost:true"
- "the working window is bounded"

## Related

- `context-handoff.md` - the window that decides what leaves.
- `memory-tool.md` - the tool actions that operate on the archive.
- `compaction.md` - the other way a checkpoint is written.

# Compaction - one document, one checkpoint

Status: shipped (v0.1) - Read when: the `compaction` hook, `runCompaction`, a host checkpoint, or "the summary and the memory disagree".

## What it does

- Answers the host's compaction request with the rendered memory document, so no second summarizer runs.
- Declines when memory is empty and lets the host summarize.
- Never writes `event.messages`; the transcript is read-only here too.

The user-visible behavior is in `docs/SPEC.md` under "Compaction".

## Map

- `src/core/compaction.ts` - `runCompaction`, `CompactionEventLike`, `CompactionDeps`, `CompactionOutcome`.
- `src/adapters/opencode/index.ts` - the `ctx.session.hook("compaction", ...)` registration and its error handling.
- `src/core/prompts.ts` - `renderMemory`, `budgetOf`.
- `src/core/schema.ts` - `isMemoryEmpty`.
- `scripts/smoke.mjs` - the owned/declined assertions.

## How & why

### The seam

The host calls the `compaction` hook with the transcript it is about to summarize. Setting `event.result = { summary }` makes the host persist that string as the compaction message and skip its own model call. `runCompaction` sets it to `renderMemory(record, config)` when the record's memory is not empty.

This is the same block the next request will carry. A checkpoint and a working memory that disagree are worse than either alone, and a second summarizer would be a second source of truth.

### Why decline on empty

An empty memory document is not a summary. Returning it would replace a real checkpoint with an empty block and lose the transcript's content in the name of owning it. `isMemoryEmpty` checks every key; when it is true, `runCompaction` returns `undefined`, the host's own summarizer runs, and nothing is lost.

### Type and safety notes

`CompactionEventLike` has a mutable `result` and index signature because the source assigns to the host's event. `event.messages` is typed as readable and is never written. An error in the hook is caught in `index.ts` and turned into a decline, so the host still summarizes.

## Config keys / UI

| Key | Default | Effect |
| --- | --- | --- |
| `memoryTokens` | 50000 | the render's denominator in the budget line |
| `charsPerToken` | 4 | the render's estimate divisor |

There is no separate command; `/context` shows the same document before and after a checkpoint.

## Tests that pin it

- "compaction is owned when memory is non-empty"
- "compaction returns the memory document"

## Related

- `context-handoff.md` - the same block on the normal request path.
- `memory-tool.md` - how the document is written.
- `archive.md` - the other cold-storage path.

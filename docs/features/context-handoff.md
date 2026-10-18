# Context handoff - the request the model actually sees

Status: shipped (v0.1) - Read when: the request payload, the memory block, the working window, `buildPayload`, `selectWorkingWindow`, turn boundaries, or "the model lost the conversation".

## What it does

- Replaces `event.messages` on every request with the memory block, the newest turns that fit the working budget, and the current turn.
- Pushes the standing policy into `event.system` once, deduped by exact text.
- Never edits the durable transcript; every pass is re-derived from the raw transcript and the session record.
- Keeps the current turn intact, including every tool call and result the model just asked for.
- Reports the estimated memory/working usage in the block's first line.

The user-visible contract is in `docs/SPEC.md` under "What the model sees" and "Budgets".

## Map

- `src/core/context.ts` - `buildPayload`, `ContextInput`, `ContextDeps`, `ContextReport`, `ContextPlan`, `modelContextOf`, `sameTurns`.
- `src/core/view.ts` - `turnSpans`, `selectWorkingWindow`, `balanceCuts`, `erodeToolResults`, `stripReasoning`, `MEMORY_MESSAGE_ID`, `INJECTED_PREFIX`.
- `src/core/prompts.ts` - `POLICY`, `budgetOf`, `renderMemory`.
- `src/core/measure.ts` - `estimateTokens`, `messageChars`, `messagesChars`, `memoryChars`.
- `src/core/state.ts` - `MAX_HISTORY`, `normalizeHistory`, `trimHistory` (the record's pass history).
- `src/adapters/opencode/context.ts` - `runContextTransform`, `isChildSession`, `directoryOf`, `createFsFeatureMap`, `TransformDeps`.
- `scripts/smoke.mjs` - the payload-shape and idempotence assertions.

## How & why

### Turns and the window

A turn starts at a real user message (`isRealUser`: role `user`, not a `megasc_` injected id) and ends before the next one. The turn id is the user message id, because indices move when the host compacts and ids do not.

`selectWorkingWindow` walks backward from the newest turn, accumulating `span.chars`. It stops when the next whole turn would exceed `workingTokens * charsPerToken`. The current turn is always kept, even when it alone exceeds the budget; `overBudget` is reported instead of dropping the results the model just requested. A cut at a turn start cannot split a call from its result; `balanceCuts` is the assertion, and the window still checks it as a guard for a host that starts mid-turn.

### What leaves, and when

`record.seenTurns` is the window from the previous pass. On a new user turn, a turn in `seenTurns` that is not in the new window becomes a `PendingTurn` with a mechanical gist and its eroded raw messages. The first pass only seeds `seenTurns`: enabling the plugin mid-session is not an eviction of turns it never managed.

Pending turns age by **new user turns**, not by requests: the age step runs only when the window's turn id list changes. A ten-call turn must not consume ten eviction leads. With `autoArchive`, a pending turn older than `evictionLead` is archived; with it off, it is dropped when the lead expires. See `archive.md`.

### Erosion and reasoning

`erodeToolResults` shortens one result over `maxResultChars`, keeping a head, a tail and a marker with the missing count. The call and result keep their ids and order. `stripReasoning` drops private reasoning from completed turns; the current turn keeps it, because the tool call that follows may depend on it.

**A result's shape is part of the contract.** The host hands a tool result as one of three shapes and each survives erosion: `text` (`value` is a string), `content` (`value` is an array of parts) and `json` (`value` is structured). `content` is the trap: OpenCode's `SessionModelRequest.prepare` maps over that array (`l.value.map`), so writing a string into it aborts the request and the TUI shows **"session failed"**. Only the text parts shrink; the array and its non-text parts stay. `json` is left alone because there is no text to cut without retyping the result. This bites only a multi-part result that is also over `maxResultChars`; a single-text result is typed `text` and never takes that path. *Pinned by:* "a content result keeps its array shape", "the durable content result was not mutated" and "a structured result keeps its value".

### The block and the policy

The memory message is `{ id: "megasc_memory", role: "user", content: [text] }` and is prepended to the window. Values in it are JSON-quoted so a newline in a note cannot change the shape. The policy is a static system part; the budget line is the only dynamic cap restatement, which keeps the system prefix stable for provider caching.

No timestamp or pass counter is rendered. Two passes over the same transcript and record must produce the same bytes, and the smoke asserts it.

### The record keeps a pass history

Alongside `lastReport` (a single snapshot for `/context`), each pass appends one `PassSample` to `record.history`: the enabled page beside the disabled baseline, both exact at that moment. `history` is **not part of the payload**, so it does not affect the bytes two passes produce. It is trimmed to `MAX_HISTORY` (200), keeping the first sample and the newest; it is optional, so a record written before the feature loads unchanged. `analyze.md` reads it.

### `/context` arrives as a real turn

The host's command executor has no display-only channel: `ctx.command.transform` hands `execute` the session and the prompt, and the documented answer path is `ctx.session.prompt`. That is what the adapter does, so a `/context` report is a genuine user turn - visible in the TUI, counted in the working window, archivable later like any other turn. `ctx.session.synthetic` is not an escape hatch: it marks the message `synthetic` and skips prompt hooks, but it still admits an inbox item and **starts a model turn** (verified live). `prompt` stays: the report is short and it does not corrupt memory. If it ever crowds the window, shorten the report rather than looking for another channel.

## Config keys / UI

| Key | Default | Effect |
| --- | --- | --- |
| `memoryTokens` | 50000 | cap used by `budgetOf` and the tool's write check |
| `workingTokens` | 16000 | cap for the verbatim tail |
| `charsPerToken` | 4 | estimate divisor |
| `maxResultChars` | 4000 | per-result erosion limit |
| `subagents` | true | whether a child session is transformed |

The block's first line is the UI: `memory 12.4k/50k est · working 6.1k/16k est · refs 3 · pending 1 · archive 41`, plus `OVER CAP` when either side is over.

## Tests that pin it

- "the memory block is the first message"
- "the policy is in system"
- "the working window is bounded"
- "the durable transcript objects were not mutated"
- "an oversized tool result is eroded"
- "a content result keeps its array shape"
- "the durable content result was not mutated"
- "a structured result keeps its value rather than being retyped"
- "no call/result pair is split in the payload"
- "two passes over the same conversation produce the same payload"
- "the window always keeps the current turn"
- "a pass appends one history sample"
- "a repeat pass over the same transcript keeps the payload bytes"

## Related

- `memory-tool.md` - how the model writes the block.
- `archive.md` - what happens to turns that leave.
- `subagents.md` - who owns a child session's window.
- `compaction.md` - the checkpoint uses the same block.

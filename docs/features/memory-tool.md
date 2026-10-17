# Memory tool - the model's only write path

Status: shipped (v0.1) - Read when: `smart_context`, `applyPatch`, the memory schema, a patch that did not land, an over-cap write, or "why did the model lose a fact".

## What it does

- Exposes one tool, `smart_context`, with eight actions: `read`, `patch`, `stats`, `ref`, `archive`, `purge`, `recall`, `expand`.
- Merges a model patch under runtime-owned rules; the model cannot invent a key or corrupt one it did not mention.
- Rejects a write that would exceed `memoryTokens` and reports the projected usage; it never trims.
- Refuses `recall` without `lost:true`.
- Runs every write through `store.mutate`, so a tool call and a context pass cannot lose each other's update.

The user-visible actions are in `docs/SPEC.md` under "The model surface".

## Map

- `src/core/memory-tool.ts` - `runMemoryTool`, `MemoryToolRequest`, `MemoryToolDeps`, `MemoryToolOutcome`, `TOOL_HELP`, `read`, `patch`, `addRef`, `archive`, `purge`.
- `src/core/schema.ts` - `MEMORY_FIELDS`, `MEMORY_KEYS`, `emptyMemory`, `parsePatch`, `applyPatch`, `normalizeMemory`, `isMemoryEmpty`.
- `src/core/prompts.ts` - `renderMemory`, `renderStats`, `budgetOf`.
- `src/adapters/opencode/tool.ts` - `TOOL_NAME` (`smart_context`), `TOOL_INPUT`, `TOOL_DESCRIPTION`, `createSmartContextTool`.
- `src/adapters/opencode/context.ts` - puts the tool in `event.tools`.
- `scripts/smoke.mjs` - the merge, cap and action assertions.

## How & why

### The schema

Eight keys: `goal` (string), `plan` (list of `{step, status, text}`), `facts`, `files`, `decisions` (maps), `open` (list of strings), `refs` (list of `{page, section, gist, tokens}`), `notes` (string). Every key always exists; absence is an empty value, so the renderer never branches on a missing key.

Two rules decide the shape. A key whose entries accumulate is a map, so a patch that mentions one entry does not erase the others. A key that *is* the current state is a list, because the newest full list is the truth.

### The merge

- `null` at the top level resets a key to its empty value.
- `null` inside a map deletes that one entry.
- An unknown key is dropped and named in the ack.
- Maps merge key by key; lists replace wholesale.
- An invalid entry (a non-string map value, a plan item with no text, a ref with no page) is reported and the previous value is kept; one bad entry does not discard the rest of the patch.

The base is never mutated: `applyPatch` clones before it merges.

### The cap

The check is `estimateTokens(memoryChars(next), charsPerToken) > memoryTokens`. On failure the tool returns the projected usage and writes nothing. This is deliberate: a silent trim loses content the model believes it stored, and the model is the only one who knows what matters. The model is told to compact and retry.

### The envelope

The tool is registered with `options.codemode: false` and injected into `event.tools`; measured against this host, a tool without `codemode:false` is reachable only through `execute`, not by name. It returns `{ content: [{ type: "text", text }] }` and declares no `output`, because a result that declares output without an output schema loses the call.

A write returns an acknowledgement to the model and nothing else; a bookkeeping call never generates a user-facing reply.

### Concurrency

`patch`, `ref`, `archive` and `purge` use `store.mutate(sessionID, fn)`, which serializes load-modify-save per session. `read`, `stats`, `recall` and `expand` use `load` and do not write.

## Config keys / UI

| Key | Default | Effect |
| --- | --- | --- |
| `memoryTokens` | 50000 | the write cap and the reported denominator |
| `refs` | true | whether the `ref` action is allowed |
| `debug` | false | logs pass decisions, not tool writes |

The ack's last line is `usage(record, config)`: `memory X/Y est · working X/Y est · refs N · pending N · archive N`.

## Tests that pin it

- "unknown patch keys are dropped"
- "goal is written"
- "null deletes one map entry"
- "an over-cap memory write is rejected"
- "the rejected write did not land"
- "a feature-map ref is stored"
- "smart_context is registered"

## Related

- `context-handoff.md` - where the memory block is rendered.
- `archive.md` - the `archive`/`purge`/`recall`/`expand` actions.
- `feature-refs.md` - the `ref` action.

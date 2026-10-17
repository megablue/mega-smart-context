# Subagents - one independent context per session

Status: shipped (v0.1) - Read when: a child session, `parentID`, `subagents`, per-session storage, or "the subagent lost its task".

## What it does

- Gives every session - top-level or child - its own memory, working window, pending turns and archive.
- Keys the store by session id, so a child's `smart_context` call writes the child's record and nothing else.
- Detects a child through `parentID` and, when `subagents:false`, passes child requests through untouched.
- Does not inherit memory in either direction. The only bridge is the normal result the parent receives when the child finishes.

The user-visible behavior is in `docs/SPEC.md` under "Subagents".

## Map

- `src/adapters/opencode/context.ts` - `isChildSession` (reads `parentID`, caches the answer), `runContextTransform`, `TransformDeps.childCache`.
- `src/core/state.ts` - `SessionStore`, `keyOf` (`session/<sessionID>`), `MAX_SESSIONS` (64), `normalizeRecord`, the per-session `mutate` lock.
- `src/core/context.ts` - `buildPayload` takes the `sessionID` and never derives it from a parent.
- `src/adapters/opencode/index.ts` - `setup` creates one store and one child cache for the plugin instance.
- `src/adapters/opencode/types.ts` - `SessionDomain.get` returns `parentID` and `directory`.

## How & why

### One key, no tree

The store key is `session/<sessionID>`. There is no parent path and no inheritance lookup: a child's `goal` is its own task prompt, and a parent's memory cannot be read or written by the child. This is deliberate. A child is usually given a narrow task; importing the parent's whole memory would defeat the point of both contexts.

The parent sees the child's final answer as a normal tool result and can fold it into its own memory with `smart_context`. That is the only intended bridge.

### Child detection

`isChildSession` calls `ctx.session.get({ sessionID })` and checks for a non-empty `parentID`. The answer is cached per session because the check costs a host call and parentage never changes. A host that throws is treated as having no child sessions, which is the conservative direction: the transform runs.

With `subagents: true` (the default), a child is transformed exactly like a parent. With `false`, the hook returns before rewriting, so the child keeps the host's normal append-only payload.

### Lifecycle and caps

`MAX_SESSIONS` is 64. The store's `Map` order is the LRU order: `load` and `save` touch a session, and `trim` evicts the oldest from the cache and the durable store. A child's archive survives until that eviction, so a resumed child session still has its cold storage.

The per-session `mutate` lock serializes load-modify-save within one session. It does not lock across sessions: two children can write at the same time, which is correct because they never share a record.

## Config keys / UI

| Key | Default | Effect |
| --- | --- | --- |
| `subagents` | true | transform child sessions independently |
| - | - | `MAX_SESSIONS` is code, not config: 64 |

`/context` and `smart_context` always operate on the session that invoked them; there is no cross-session selector.

## Tests that pin it

- "a child starts with its own empty memory"
- "the parent goal is unchanged by the child"
- "the child has its own goal"
- "subagents:false leaves a child session alone"

## Related

- `context-handoff.md` - the transform the child runs.
- `archive.md` - the child's own cold storage.
- `memory-tool.md` - the tool that resolves the session from the call context.

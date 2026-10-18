# Subagents - one independent context per session

Status: shipped (v0.1) - Read when: a child session, `parentID`, `subagents`, per-session storage, a deleted session's record, or "the subagent lost its task".

## What it does

- Gives every session - top-level or child - its own memory, working window, pending turns and archive.
- Keys the store by session id, so a child's `smart_context` call writes the child's record and nothing else.
- Detects a child through `parentID` and, when `subagents:false`, passes child requests through untouched.
- Does not inherit memory in either direction. The only bridge is the normal result the parent receives when the child finishes.

The user-visible behavior is in `docs/SPEC.md` under "Subagents".

## Map

- `src/adapters/opencode/context.ts` - `isChildSession` (reads `parentID`, caches the answer), `runContextTransform`, `TransformDeps.childCache`.
- `src/core/state.ts` - `SessionStore` (stamps `directory` on save), `keyOf` (`session/<sessionID>`), `MAX_SESSIONS` (64), `normalizeRecord`, `pruneOrphans`, `sameDirectory`, the per-session `mutate` lock.
- `src/adapters/opencode/sessions.ts` - `livenessFromError` (the `SessionNotFoundError` tag or message), `sessionLiveness`, `sweepOrphanedSessions`.
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

`MAX_SESSIONS` is 64. The store's `Map` order is the LRU order: `load` and `save` touch a session, and `trim` evicts the oldest from the cache and the durable store. It only sees records this process has loaded, so a restart starts again from an empty cache. A child's archive survives until that eviction, so a resumed child session still has its cold storage.

The per-session `mutate` lock serializes load-modify-save within one session. It does not lock across sessions: two children can write at the same time, which is correct because they never share a record.

### The startup sweep

Deleting a session at `/sessions` removes the host's session and messages, but not the plugin's KV entry: there is no foreign key between the tables and no deletion event in the session hook surface. The record would keep the memory, pending turns and raw archive on disk forever, including transcript text the user thought they deleted.

`setup` therefore runs `sweepOrphanedSessions` after registration and without awaiting it (a slow lookup must not delay the plugin loading). It scans `session/`, asks `ctx.session.get` about each id, and removes the entry only when the host answers with `SessionNotFoundError` - `livenessFromError` also accepts the "Session not found" message for a host that throws a plain `Error`. A timeout, a closed store or any other failure is `"unknown"` and keeps the record. A removal failure is logged and counted, never thrown into `setup`.

The KV is shared by every project this host has opened, which is why `SessionRecord.directory` is stamped on save: a record stamped for another directory is left for that project's instance. A record written before the field existed has no stamp and is still swept, because a not-found answer from the session id is proof the session is gone wherever it lived. The sweep does not cap records for sessions that still exist; `MAX_SESSIONS` bounds the running cache, not the disk.

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
- "the sweep removes gone sessions, including unstamped legacy records"
- "an alive session keeps its record"
- "an unclassifiable lookup keeps the record"
- "a record stamped for another project is left for that instance"
- "the sweep follows the scan cursor"
- "a scan failure removes nothing"
- "a saved record is stamped with its directory"

## Related

- `context-handoff.md` - the transform the child runs.
- `archive.md` - the child's own cold storage.
- `memory-tool.md` - the tool that resolves the session from the call context.

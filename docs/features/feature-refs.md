# Feature refs - a pointer plus a gist

Status: shipped (v0.1) - Read when: the `ref` action, `extractSection`, `refVerdict`, `docs/features`, or "should I paste the section or point at it".

## What it does

- Stores a feature-map pointer (`page#section`) plus the model's one-line gist in `memory.refs`.
- Reads the real section from `docs/features/<page>.md` and reports the gist and section token costs.
- Tells the model which representation is shorter; the model decides.
- Counts the reference against `memoryTokens`; a reference to an unreadable section is still stored, with a warning.

The user-visible behavior is in `docs/SPEC.md` under "Feature-map references".

## Map

- `src/core/refs.ts` - `normalizePage`, `extractSection`, `refVerdict`, `RefVerdict`.
- `src/core/memory-tool.ts` - `addRef`, reached through `runMemoryTool({ action: "ref" })`.
- `src/adapters/opencode/context.ts` - `createFsFeatureMap`, the `FeatureMapPort` implementation that reads `docs/features/`.
- `src/core/prompts.ts` - the `## Refs` render in `renderMemory`.
- `src/core/types.ts` - `RefEntry`.

## How & why

### The page argument

`normalizePage` strips a leading `docs/features/`, appends `.md` when missing, and rejects an empty path or one containing `..`. `createFsFeatureMap` resolves the result under `<root>/docs/features/` and checks the resolved path is still inside that directory. A bad page is `undefined`, not an exception.

### The section argument

`extractSection` matches a heading exactly first, then by case-insensitive substring, so `how-why` finds `## How & why`. The returned text includes the heading and stops at the next heading of the same or a higher level, so a `##` section does not swallow its `###` subsections' siblings. A missing page or section returns `undefined`; it never returns an empty string, which would read as a real zero-cost section.

### The comparison

`refVerdict(gist, sectionText, charsPerToken)` reports:

- `gistTokens` - the model's one-liner;
- `sectionTokens` - the section it points at;
- `useRef` - `sectionTokens > gistTokens`;
- `saving` - the difference.

The tool's reply says either "the reference is shorter (saves ~N)" or "the gist is longer than the section; inline the section instead". This is the mechanical half of "whichever takes fewer words"; the model still chooses.

### Storage and the cap

A ref is `{ page, section, gist, tokens: gistTokens }`. Re-adding the same `page#section` replaces the entry instead of duplicating it. The write goes through the same `memoryTokens` check as a patch: if the new ref would push memory over the cap, the previous `refs` array is restored and nothing is written. The pointer is stored even when the section cannot be read; the reply says so, because a pointer that cannot be expanded is still a note to the model.

## Config keys / UI

| Key | Default | Effect |
| --- | --- | --- |
| `refs` | true | allow the `ref` action; false returns an error |
| `memoryTokens` | 50000 | refs count toward this cap |

The rendered line is `- page#section - "gist" (~N est; feature_map page:"..." section:"...")`, so the model can expand it with the `feature_map` tool.

## Tests that pin it

- "a feature-map ref is stored"
- "an over-cap memory write is rejected" (the same cap path)

The smoke uses `context-handoff.md` / `How & why`, which now resolves against this repository; the missing-section branch is exercised by the adapter's `undefined` return and should be covered by a dedicated fixture if it changes.

## Related

- `memory-tool.md` - the action envelope and the cap.
- `context-handoff.md` - where the `## Refs` section is rendered.

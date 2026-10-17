/**
 * The memory schema and the patch merge.
 *
 * The runtime owns the schema, not the model. A patch names a key this module
 * does not know and it is dropped; a patch sets a key to `null` and it is reset;
 * a map merges key by key, while a list replaces wholesale. That split is the
 * whole defence against the two failure modes that matter: a model overwriting a
 * key it did not mean to, and a model deleting what it did not own.
 *
 * Two container rules decide which shape a key takes:
 *
 * 1. A key whose entries accumulate is a **map** (`facts`, `files`, `decisions`):
 *    a patch that mentions one entry must not erase the others.
 * 2. A key that *is* the current state is a **list** (`plan`, `open`, `refs`):
 *    the newest full list is the truth.
 *
 * @module mega-smart-context/schema
 */

import type { Memory, PlanStep, RefEntry } from "./types.ts"
import { isPlainObject } from "./types.ts"

export type PlanStatus = PlanStep["status"]

export const PLAN_STATUSES: ReadonlySet<string> = new Set(["todo", "active", "done", "blocked"])

export interface MemoryField {
  readonly key: keyof Memory
  readonly kind: "string" | "list" | "map"
  readonly hint: string
}

/** The schema, in render order. The hints are what the model reads. */
export const MEMORY_FIELDS: ReadonlyArray<MemoryField> = [
  { key: "goal", kind: "string", hint: "the current objective, in your own words" },
  { key: "plan", kind: "list", hint: "steps, each { step, status: todo|active|done|blocked, text }" },
  { key: "facts", kind: "map", hint: "name -> a durable finding or verified flag" },
  { key: "files", kind: "map", hint: "path -> what you know or changed there" },
  { key: "decisions", kind: "map", hint: "name -> the decision and why, one line" },
  { key: "open", kind: "list", hint: "blockers, open questions and concrete next actions" },
  { key: "refs", kind: "list", hint: "feature-map pointers, each { page, section, gist, tokens }" },
  { key: "notes", kind: "string", hint: "free-form notes that do not fit the keys above" },
]

export const MEMORY_KEYS: ReadonlySet<string> = new Set(MEMORY_FIELDS.map((field) => field.key))

/** A fresh, empty document. Every key exists so readers never branch on absence. */
export function emptyMemory(): Memory {
  return {
    goal: "",
    plan: [],
    facts: {},
    files: {},
    decisions: {},
    open: [],
    refs: [],
    notes: "",
  }
}

function emptyValue(key: keyof Memory): any {
  return key === "plan" || key === "open" || key === "refs" ? [] : key === "facts" || key === "files" || key === "decisions" ? {} : ""
}

/** The keys a patch names that the schema does not own. */
export function unknownKeys(patch: unknown): string[] {
  if (!isPlainObject(patch)) return []
  return Object.keys(patch).filter((key) => !MEMORY_KEYS.has(key))
}

export interface PatchResult {
  readonly memory: Memory
  readonly changed: string[]
  readonly dropped: string[]
  readonly errors: string[]
}

/**
 * Parse a patch that may arrive as an object or as a JSON string.
 *
 * The tool's input schema asks for an object, but a model that formats its call
 * as text is common enough that accepting the string is cheaper than failing the
 * call. A string that is not JSON is an error, not a silent no-op.
 */
export function parsePatch(value: unknown): { patch: unknown; error?: string } {
  if (typeof value !== "string") return { patch: value }
  const text = value.trim()
  if (text.length === 0) return { patch: undefined, error: "the patch string is empty" }
  try {
    return { patch: JSON.parse(text) }
  } catch {
    return { patch: undefined, error: "the patch is not valid JSON" }
  }
}

function stringMap(current: Record<string, string>, value: unknown, key: string, errors: string[]): Record<string, string> {
  if (!isPlainObject(value)) {
    errors.push(`${key} must be an object of string values`)
    return { ...current }
  }
  const next = { ...current }
  for (const name of Object.keys(value)) {
    const entry = value[name]
    if (entry === null) {
      delete next[name]
      continue
    }
    if (typeof entry !== "string") {
      errors.push(`${key}.${name} must be a string (or null to delete it)`)
      continue
    }
    next[name] = entry
  }
  return next
}

function normalizePlan(value: unknown, errors: string[]): PlanStep[] {
  if (!Array.isArray(value)) {
    errors.push("plan must be an array")
    return []
  }
  const steps: PlanStep[] = []
  value.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`plan[${index}] must be an object`)
      return
    }
    const text = typeof item.text === "string" ? item.text : ""
    if (text.length === 0) {
      errors.push(`plan[${index}].text must be a non-empty string`)
      return
    }
    const status = typeof item.status === "string" && PLAN_STATUSES.has(item.status) ? item.status : "todo"
    if (item.status !== undefined && (typeof item.status !== "string" || !PLAN_STATUSES.has(item.status))) {
      errors.push(`plan[${index}].status must be todo, active, done or blocked`)
    }
    const step = typeof item.step === "number" && Number.isFinite(item.step) ? item.step : index + 1
    steps.push({ step, status: status as PlanStatus, text })
  })
  return steps
}

function normalizeOpen(value: unknown, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push("open must be an array of strings")
    return []
  }
  const items: string[] = []
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      errors.push(`open[${index}] must be a string`)
      return
    }
    items.push(item)
  })
  return items
}

function normalizeRefs(value: unknown, errors: string[]): RefEntry[] {
  if (!Array.isArray(value)) {
    errors.push("refs must be an array")
    return []
  }
  const refs: RefEntry[] = []
  value.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`refs[${index}] must be an object`)
      return
    }
    const page = typeof item.page === "string" ? item.page : ""
    const section = typeof item.section === "string" ? item.section : ""
    const gist = typeof item.gist === "string" ? item.gist : ""
    if (page.length === 0 || section.length === 0 || gist.length === 0) {
      errors.push(`refs[${index}] needs page, section and gist strings`)
      return
    }
    const tokens = typeof item.tokens === "number" && Number.isFinite(item.tokens) ? Math.max(0, Math.round(item.tokens)) : Math.ceil(gist.length / 4)
    refs.push({ page, section, gist, tokens })
  })
  return refs
}

/**
 * Apply one patch over the memory.
 *
 * The base is never mutated. `null` resets a top-level key; inside a map it
 * deletes that one entry. Arrays replace wholesale. Invalid values are reported
 * in `errors` and leave the previous value in place, so one malformed entry does
 * not discard the rest of an otherwise good patch.
 */
export function applyPatch(memory: Memory, patch: unknown): PatchResult {
  if (!isPlainObject(patch)) {
    return { memory: { ...memory }, changed: [], dropped: [], errors: ["the patch must be an object"] }
  }
  const next: Memory = {
    ...memory,
    plan: memory.plan.map((step) => ({ ...step })),
    facts: { ...memory.facts },
    files: { ...memory.files },
    decisions: { ...memory.decisions },
    open: [...memory.open],
    refs: memory.refs.map((ref) => ({ ...ref })),
  }
  const changed: string[] = []
  const dropped: string[] = []
  const errors: string[] = []

  for (const key of Object.keys(patch)) {
    if (!MEMORY_KEYS.has(key)) {
      dropped.push(key)
      continue
    }
    const value = (patch as Record<string, unknown>)[key]
    const typedKey = key as keyof Memory
    if (value === null) {
      ;(next as any)[typedKey] = emptyValue(typedKey)
      changed.push(key)
      continue
    }
    if (typedKey === "goal" || typedKey === "notes") {
      if (typeof value !== "string") {
        errors.push(`${key} must be a string`)
        continue
      }
      ;(next as any)[typedKey] = value
      changed.push(key)
      continue
    }
    if (typedKey === "facts" || typedKey === "files" || typedKey === "decisions") {
      const before = next[typedKey]
      const after = stringMap(before, value, key, errors)
      ;(next as any)[typedKey] = after
      if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(key)
      continue
    }
    if (typedKey === "plan") {
      const after = normalizePlan(value, errors)
      next.plan = after
      changed.push(key)
      continue
    }
    if (typedKey === "open") {
      const after = normalizeOpen(value, errors)
      next.open = after
      changed.push(key)
      continue
    }
    if (typedKey === "refs") {
      const after = normalizeRefs(value, errors)
      next.refs = after
      changed.push(key)
      continue
    }
  }

  return { memory: next, changed, dropped, errors }
}

/** Coerce a stored value back into the schema. Never throws; bad entries are dropped. */
export function normalizeMemory(value: unknown): Memory {
  if (!isPlainObject(value)) return emptyMemory()
  const errors: string[] = []
  const memory = emptyMemory()
  if (typeof value.goal === "string") memory.goal = value.goal
  if (typeof value.notes === "string") memory.notes = value.notes
  if (isPlainObject(value.facts)) {
    for (const [key, entry] of Object.entries(value.facts)) if (typeof entry === "string") memory.facts[key] = entry
  }
  if (isPlainObject(value.files)) {
    for (const [key, entry] of Object.entries(value.files)) if (typeof entry === "string") memory.files[key] = entry
  }
  if (isPlainObject(value.decisions)) {
    for (const [key, entry] of Object.entries(value.decisions)) if (typeof entry === "string") memory.decisions[key] = entry
  }
  memory.plan = normalizePlan(value.plan ?? [], errors)
  memory.open = normalizeOpen(value.open ?? [], errors)
  memory.refs = normalizeRefs(value.refs ?? [], errors)
  return memory
}

/** Is the document still untouched? Used to decline compaction and to warn about `goal`. */
export function isMemoryEmpty(memory: Memory): boolean {
  return (
    memory.goal.trim().length === 0 &&
    memory.plan.length === 0 &&
    Object.keys(memory.facts).length === 0 &&
    Object.keys(memory.files).length === 0 &&
    Object.keys(memory.decisions).length === 0 &&
    memory.open.length === 0 &&
    memory.refs.length === 0 &&
    memory.notes.trim().length === 0
  )
}

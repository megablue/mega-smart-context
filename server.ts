/**
 * The host entry point.
 *
 * OpenCode resolves `<plugin-root>/server` before `<plugin-root>/index`, probing
 * `.ts` ahead of `.js`, so a directory install needs only this one re-export. It
 * points at the adapter, never at the core: the core is host-free.
 *
 * @module server
 */

export { default } from "./src/adapters/opencode/index.ts"

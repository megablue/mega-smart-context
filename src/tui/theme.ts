/**
 * The colours both drawn surfaces share.
 *
 * The host owns the palette and publishes it as `theme.text`; a slot claim passes
 * those strings straight to `fg`. The mapping lives in a plain module so the
 * sidebar and the panel cannot drift apart, and so a theme shape the host does
 * not resolve degrades to the terminal default instead of throwing from render.
 *
 * @module mega-smart-context/tui/theme
 */

import { TextAttributes } from "@opentui/core"
import type { SidebarTone } from "../core/status.ts"
import type { TuiContext } from "./context.ts"

/** One colour per tone; `undefined` means "whatever the terminal draws". */
export function toneColor(context: TuiContext, tone: SidebarTone): string | undefined {
  try {
    const text = context.theme.text
    if (tone === "alert") return text.feedback.warning.base
    if (tone === "muted") return text.muted
    return text.base
  } catch {
    return undefined
  }
}

/**
 * The text attributes a tone adds. Only the title is bold, the way the host
 * draws the header of every other sidebar block; the numbers beside it stay
 * plain so they read as data rather than as a second heading.
 *
 * `attributes` is a bitmask, not a boolean, so this returns `TextAttributes.NONE`
 * (0, the default) for the other tones rather than leaving the prop out.
 */
export function toneAttributes(tone: SidebarTone): number {
  return tone === "title" ? TextAttributes.BOLD : TextAttributes.NONE
}

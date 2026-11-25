/**
 * Windows allocates a console for a console-app child when its parent has none.
 * `windowsHide` gives the immediate child no console, so its node/npm/vite
 * grandchildren can allocate a visible console and steal focus. Share the
 * host's console when the host has one; hide only when there is nothing to
 * inherit.
 */
export function hideConsoleWindow(
  hostHasConsole: boolean = Boolean(process.stdout.isTTY || process.stderr.isTTY),
): boolean {
  if (process.platform !== "win32") return true
  return !hostHasConsole
}

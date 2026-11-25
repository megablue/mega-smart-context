/**
 * Windows allocates a console for a console-app child when its parent has none.
 * `windowsHide` alone gives the top-level child no console, so its node/npm/vite
 * grandchildren can allocate a visible console and steal focus. If the host has
 * a console, share it (windowsHide: false). Otherwise give the child its own
 * console and hide it (detached: true, windowsHide: true) so descendants inherit
 * a hidden console instead of allocating a visible one.
 */
export interface ConsoleSpawnOptions {
  windowsHide: boolean
  detached: boolean
}

export function consoleSpawnOptions(
  hostHasConsole: boolean = Boolean(process.stdout.isTTY || process.stderr.isTTY),
): ConsoleSpawnOptions {
  if (process.platform !== "win32") return { windowsHide: true, detached: false }
  return hostHasConsole ? { windowsHide: false, detached: false } : { windowsHide: true, detached: true }
}

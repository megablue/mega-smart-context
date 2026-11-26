/**
 * Windows allocates a console for a console-app child when its parent has none.
 * If the host has a console, share it (windowsHide: false). Otherwise hide the
 * child's console (windowsHide: true) so a console-app grandchild cannot steal
 * focus. The child must stay attached: a detached PowerShell with piped stdio
 * exits immediately on Windows without running the command, which silently
 * broke every job. `detached` stays in the shape so call sites can spread it.
 */
export interface ConsoleSpawnOptions {
  windowsHide: boolean
  detached: boolean
}

export function consoleSpawnOptions(
  hostHasConsole: boolean = Boolean(process.stdout.isTTY || process.stderr.isTTY),
): ConsoleSpawnOptions {
  if (process.platform !== "win32") return { windowsHide: true, detached: false }
  return { windowsHide: !hostHasConsole, detached: false }
}

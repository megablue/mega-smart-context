import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"

export interface ShellResult {
  output: string
  exitCode: number | null
  wallTimeSeconds: number
}

interface Pending {
  marker: string
  resolve: (value: ShellResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  started: number
}

/**
 * A PowerShell REPL kept alive between calls.
 *
 * Windows PowerShell's `-Command -` buffers stdin until EOF, so a persistent
 * shell cannot be built by writing scripts to it. Instead the child runs a
 * base64 REPL loop: every line is `<marker>|<base64 command>`, the command is
 * decoded and invoked, and the loop prints `<marker>:<exit>`. The result is a
 * persistent shell with per-command markers.
 *
 * Only commands expected to exit belong here. Long runners go through the job
 * registry, where a deadline never kills them.
 */
const LOOP = `$ErrorActionPreference = 'Stop'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $split = $line.IndexOf('|')
  if ($split -lt 1) { continue }
  $marker = $line.Substring(0, $split)
  $cmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring($split + 1)))
  $global:LASTEXITCODE = 0
  $ok = $true
  $result = $null
  try { $result = Invoke-Expression $cmd 2>&1; $ok = $true } catch { $result = $_.Exception.Message; $ok = $false }
  $code = if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } elseif ($ok) { 0 } else { 1 }
  if ($null -ne $result) { $result | Out-String -Stream }
  Write-Output ($marker + ':' + $code)
}`

export class PersistentShell {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ""
  private stderrBuffer = ""
  private pending: Pending | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly warn: (line: string) => void

  constructor(warn: (line: string) => void = () => {}) {
    this.warn = warn
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc !== null && this.proc.exitCode === null) return this.proc
    const exe = process.platform === "win32" ? "powershell.exe" : "pwsh"
    const encoded = Buffer.from(LOOP, "utf16le").toString("base64")
    const proc = spawn(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1", CLICOLOR: "0" },
    })
    proc.stdout.setEncoding("utf8")
    proc.stderr.setEncoding("utf8")
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk))
    proc.stderr.on("data", (chunk: string) => { this.stderrBuffer += chunk })
    proc.on("exit", () => {
      this.proc = null
      this.fail("shell exited")
    })
    proc.on("error", (error) => {
      this.proc = null
      this.fail("shell failed: " + error.message)
    })
    this.proc = proc
    return proc
  }

  prewarm(): void {
    try {
      this.ensure()
    } catch (error) {
      this.warn("shell prewarm failed: " + (error instanceof Error ? error.message : String(error)))
    }
  }

  private fail(message: string): void {
    const pending = this.pending
    if (pending === null) return
    this.pending = null
    clearTimeout(pending.timer)
    pending.reject(new Error(message))
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    const pending = this.pending
    if (pending === null) return
    const token = pending.marker + ":"
    const index = this.buffer.indexOf(token)
    if (index === -1) {
      if (this.buffer.length > 2_000_000) this.buffer = this.buffer.slice(-1_000_000)
      return
    }
    const before = this.buffer.slice(0, index)
    const after = this.buffer.slice(index + token.length)
    const match = /^(-?\d+)\r?\n?/.exec(after)
    const exitCode = match === null ? null : Number(match[1])
    this.buffer = match === null ? after : after.slice(match[0].length)
    const stderr = this.stderrBuffer.trim()
    this.stderrBuffer = ""
    this.pending = null
    clearTimeout(pending.timer)
    let output = before.replace(/\r\n/g, "\n")
    if (stderr.length > 0 && !stderr.includes("#< CLIXML")) {
      output = output.length > 0 && !output.endsWith("\n") ? output + "\n" + stderr : output + stderr
    }
    pending.resolve({
      output,
      exitCode: Number.isFinite(exitCode as number) ? exitCode : null,
      wallTimeSeconds: (Date.now() - pending.started) / 1000,
    })
  }

  run(command: string, workdir: string | undefined, timeoutMs: number): Promise<ShellResult> {
    const task = async (): Promise<ShellResult> => {
      const proc = this.ensure()
      const marker = "__MEGA_RUN_END_" + randomUUID().replace(/-/g, "").slice(0, 12) + "__"
      const cwd = workdir !== undefined && workdir.length > 0 ? workdir : process.cwd()
      const payload = "Set-Location -LiteralPath '" + cwd.replace(/'/g, "''") + "' -ErrorAction Stop\n" + command
      const line = marker + "|" + Buffer.from(payload, "utf8").toString("base64") + "\n"
      this.buffer = ""
      this.stderrBuffer = ""
      const started = Date.now()
      return await new Promise<ShellResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null
          try { proc.kill() } catch {}
          this.proc = null
          this.warn("quick command exceeded " + Math.round(timeoutMs / 1000) + "s; restarting the shell")
          reject(new Error("command did not exit within " + Math.round(timeoutMs / 1000) + "s; start it as a service or job"))
        }, timeoutMs)
        this.pending = { marker, resolve, reject, timer, started }
        proc.stdin.write(line)
      })
    }
    const next = this.queue.then(task, task)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  dispose(): void {
    this.fail("plugin disposed")
    try { this.proc?.kill() } catch {}
    this.proc = null
  }
}

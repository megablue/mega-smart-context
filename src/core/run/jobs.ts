import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { connect } from "node:net"
import { hideConsoleWindow } from "./windows.ts"

export type JobState = "running" | "completed" | "failed" | "stopped"

export interface JobResult {
  output: string
  exitCode: number | null
  wallTimeSeconds: number
  jobID?: string
  ready?: boolean
  state: JobState
}

export interface ServiceOptions {
  ready?: string
  port?: number
  readyTimeoutMs?: number
}

interface Job {
  id: string
  sessionID: string
  command: string
  kind: "service" | "job"
  child: ChildProcess
  output: string
  started: number
  state: JobState
  exitCode: number | null
  ready: boolean
  notified: boolean
  waiters: Array<(result: JobResult) => void>
}

const MAX_OUTPUT = 200_000

const DEFAULT_READY = [
  /Local:\s*https?:\/\//i,
  /\bready in\b/i,
  /\blistening on\b/i,
  /\brunning at\b/i,
  /\bstarted server\b/i,
  /\bwatching for file changes\b/i,
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/i,
]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(400)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

function shellSpawn(command: string, cwd: string): ChildProcess {
  if (process.platform === "win32") {
    return spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { cwd, windowsHide: hideConsoleWindow(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", CI: "1" } },
    )
  }
  return spawn("bash", ["-lc", command], {
    cwd,
    windowsHide: hideConsoleWindow(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
  })
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>()
  private readonly notify: (sessionID: string, text: string) => void

  constructor(notify: (sessionID: string, text: string) => void) {
    this.notify = notify
  }

  start(sessionID: string, command: string, cwd: string, kind: "service" | "job"): Job {
    const child = shellSpawn(command, cwd)
    const job: Job = {
      id: "run_" + randomUUID().replace(/-/g, "").slice(0, 12),
      sessionID,
      command,
      kind,
      child,
      output: "",
      started: Date.now(),
      state: "running",
      exitCode: null,
      ready: false,
      notified: true,
      waiters: [],
    }
    const append = (chunk: string): void => {
      job.output += chunk
      if (job.output.length > MAX_OUTPUT) job.output = job.output.slice(-MAX_OUTPUT)
    }
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    child.on("error", (error) => {
      append("\n" + error.message)
      this.settle(job, "failed", null)
    })
    child.on("exit", (code) => {
      this.settle(job, code === 0 ? "completed" : "failed", code)
    })
    this.jobs.set(job.id, job)
    return job
  }

  private settle(job: Job, state: JobState, code: number | null): void {
    if (job.state !== "running") return
    job.state = state
    job.exitCode = code
    const result = this.result(job)
    for (const waiter of job.waiters.splice(0)) waiter(result)
    if (!job.notified) {
      job.notified = true
      this.notify(job.sessionID, this.notification(job))
    }
  }

  private notification(job: Job): string {
    const tail = job.output.length > 4000 ? job.output.slice(-4000) : job.output
    return (
      '<background-result kind="run" jobID="' + job.id + '" state="' + job.state +
      '" exit="' + (job.exitCode ?? "null") + '">\n' + tail + "\n</background-result>"
    )
  }

  private result(job: Job): JobResult {
    return {
      output: job.output,
      exitCode: job.exitCode,
      wallTimeSeconds: (Date.now() - job.started) / 1000,
      jobID: job.id,
      ready: job.ready,
      state: job.state,
    }
  }

  private tail(job: Job, lines = 20): string {
    return job.output.split(/\r?\n/).slice(-lines).join("\n")
  }

  expect(jobID: string): void {
    const job = this.jobs.get(jobID)
    if (job === undefined) return
    if (job.state !== "running") {
      if (!job.notified) {
        job.notified = true
        this.notify(job.sessionID, this.notification(job))
      }
      return
    }
    job.notified = false
  }

  async waitForService(job: Job, options: ServiceOptions): Promise<JobResult> {
    const timeout = options.readyTimeoutMs ?? 15_000
    const started = Date.now()
    let pattern: RegExp | undefined
    if (options.ready !== undefined) {
      try { pattern = new RegExp(options.ready, "i") } catch { pattern = undefined }
    }
    while (job.state === "running") {
      const ready =
        (pattern !== undefined && pattern.test(job.output)) ||
        (options.port !== undefined && (await portOpen(options.port))) ||
        (pattern === undefined &&
          options.port === undefined &&
          DEFAULT_READY.some((expression) => expression.test(job.output)))
      if (ready) {
        job.ready = true
        return { ...this.result(job), output: this.tail(job, 12), ready: true, state: "running" }
      }
      if (Date.now() - started >= timeout) break
      await sleep(100)
    }
    return { ...this.result(job), output: this.tail(job, 20) }
  }

  async waitForJob(job: Job, deadlineMs: number): Promise<JobResult> {
    if (job.state !== "running") return this.result(job)
    return await new Promise<JobResult>((resolve) => {
      const onDone = (result: JobResult): void => {
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        const index = job.waiters.indexOf(onDone)
        if (index >= 0) job.waiters.splice(index, 1)
        resolve({ ...this.result(job), output: this.tail(job, 20) })
      }, deadlineMs)
      job.waiters.push(onDone)
      if (job.state !== "running") {
        clearTimeout(timer)
        const index = job.waiters.indexOf(onDone)
        if (index >= 0) job.waiters.splice(index, 1)
        resolve(this.result(job))
      }
    })
  }

  status(jobID: string, sessionID: string): JobResult | undefined {
    const job = this.jobs.get(jobID)
    if (job === undefined || job.sessionID !== sessionID) return undefined
    return { ...this.result(job), output: this.tail(job, 30) }
  }

  stop(jobID: string, sessionID: string): JobResult | undefined {
    const job = this.jobs.get(jobID)
    if (job === undefined || job.sessionID !== sessionID) return undefined
    if (job.state === "running") {
      job.notified = true
      try {
        if (process.platform === "win32" && job.child.pid !== undefined) {
          spawn("taskkill", ["/PID", String(job.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        } else {
          job.child.kill()
        }
      } catch {
        // The process may already be gone.
      }
      job.state = "stopped"
    }
    return this.result(job)
  }

  dispose(): void {
    for (const job of this.jobs.values()) {
      if (job.state !== "running") continue
      try {
        if (process.platform === "win32" && job.child.pid !== undefined) {
          spawn("taskkill", ["/PID", String(job.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        } else {
          job.child.kill()
        }
      } catch {
        // Best effort.
      }
    }
    this.jobs.clear()
  }
}

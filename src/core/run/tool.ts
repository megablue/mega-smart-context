import { classify, readManifest, type CommandClass } from "./classify.ts"
import { npmScriptCommand, resolveNpmScript } from "./npm.ts"
import type { JobRegistry, JobResult } from "./jobs.ts"
import { ShellTimeoutError, type PersistentShell } from "./shell.ts"
import { TimingStore } from "./timings.ts"

export const TOOL_NAME = "run"

export const TOOL_DESCRIPTION = `Run a shell command with a clock that fits the work.
- Omit timeout for quick commands: the call returns when the command exits, usually in under a second.
- npm run <script> runs the package script directly with the npm lifecycle env and node_modules/.bin on PATH; pre/post scripts or extra arguments fall back to npm.
- Servers and watchers (vite, npm run dev, dev-preview, gh run watch) return a job id as soon as they are ready and keep running.
- Builds, tests and deploys across toolchains (cargo, go, pytest, dotnet, Maven/Gradle, make) wait for their learned p90; if they overrun, they return a job id, keep running, and send a completion note. Nothing on the job path is killed on a deadline.
- A quick command that runs past 10s is stopped with the output so far; pass a timeout above 10000 ms or add it to .opencode/run.json to put it on the job clock.
- Pass job to check a running job; pass job and stop:true to stop it. timeout is a hint, never a hard cap.`

export const TOOL_INPUT = {
  type: "object",
  properties: {
    command: { type: "string", description: "Command to run. Omit when checking a job." },
    workdir: { type: "string", description: "Working directory. Defaults to the session directory." },
    timeout: { type: "number", description: "Expected-duration hint in milliseconds; never a hard cap." },
    job: { type: "string", description: "A job id returned by an earlier call." },
    stop: { type: "boolean", description: "With job: stop the process." },
  },
  required: [],
  additionalProperties: false,
}

export const TOOL_OUTPUT = {
  type: "object",
  properties: {
    output: { type: "string" },
    exitCode: { type: ["number", "null"] },
    wallTimeSeconds: { type: "number" },
    jobID: { type: "string" },
    ready: { type: "boolean" },
    state: { type: "string" },
  },
  required: ["output", "exitCode", "wallTimeSeconds", "state"],
}

export interface RunToolDeps {
  readonly shell: PersistentShell
  readonly jobs: JobRegistry
  readonly timings: TimingStore
  readonly directoryOf: (sessionID: string) => Promise<string>
  readonly warn: (line: string) => void
}

interface RunOutput {
  output: string
  exitCode: number | null
  wallTimeSeconds: number
  jobID?: string
  ready?: boolean
  state: "running" | "completed" | "failed" | "stopped"
}

const MAX_TEXT = 8000

/** The quick shell's guard; a longer stated duration belongs on the job clock. */
export const QUICK_TIMEOUT_MS = 10_000

/**
 * A quick command with a longer stated duration is promoted to the job path.
 * The quick shell must not kill work the caller already said would be long.
 */
export function shouldPromoteToJob(kind: CommandClass, hint: number | undefined): boolean {
  return kind === "quick" && hint !== undefined && Number.isFinite(hint) && hint > QUICK_TIMEOUT_MS
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toOutput(result: JobResult): RunOutput {
  return {
    output: result.output,
    exitCode: result.exitCode,
    wallTimeSeconds: result.wallTimeSeconds,
    jobID: result.jobID,
    ready: result.ready,
    state: result.state,
  }
}

function render(result: RunOutput): string {
  let body = result.output
  if (body.length > MAX_TEXT) {
    const omitted = body.length - MAX_TEXT
    body = body.slice(0, MAX_TEXT / 2) +
      "\n… [" + omitted + " chars omitted; use job " + (result.jobID ?? "") + " for the full log]\n" +
      body.slice(-MAX_TEXT / 2)
  }
  const meta = [
    result.state,
    result.exitCode !== null ? "exit " + result.exitCode : undefined,
    result.wallTimeSeconds.toFixed(2) + "s",
    result.jobID !== undefined ? "job " + result.jobID : undefined,
    result.ready === true ? "ready" : undefined,
  ].filter((entry): entry is string => entry !== undefined).join(" · ")
  return body + (body.length > 0 && !body.endsWith("\n") ? "\n" : "") + "[" + meta + "]"
}

function done(result: RunOutput): any {
  return {
    content: [{ type: "text", text: render(result) }],
    output: result,
  }
}

function failed(message: string): any {
  const text = "Error: " + message
  return {
    content: [{ type: "text", text }],
    output: { output: text, exitCode: null, wallTimeSeconds: 0, state: "failed" },
  }
}

/** A quick command that hit the guard: keep the output it produced. */
function stopped(message: string, output: string, wallTimeSeconds: number): any {
  let text = "Error: " + message + (output.length > 0 ? "\n" + output : "")
  if (text.length > MAX_TEXT) {
    const omitted = text.length - MAX_TEXT
    text = text.slice(0, MAX_TEXT / 2) +
      "\n… [" + omitted + " chars omitted; the command was stopped]\n" +
      text.slice(-MAX_TEXT / 2)
  }
  return {
    content: [{ type: "text", text }],
    output: { output: text, exitCode: null, wallTimeSeconds, state: "stopped" },
  }
}

export function createRunTool(deps: RunToolDeps): any {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    input: TOOL_INPUT,
    output: TOOL_OUTPUT,
    options: { codemode: true },
    async execute(input: any, context: any): Promise<any> {
      const sessionID = String(context?.sessionID ?? "")
      const value = input ?? {}

      const jobID = typeof value.job === "string" && value.job.length > 0 ? value.job : undefined
      if (jobID !== undefined) {
        if (value.stop === true) {
          const stopped = deps.jobs.stop(jobID, sessionID)
          if (stopped === undefined) return failed("unknown job " + jobID)
          return done(toOutput(stopped))
        }
        const status = deps.jobs.status(jobID, sessionID)
        if (status === undefined) return failed("unknown job " + jobID)
        if (status.state === "running") deps.jobs.expect(jobID)
        return done(toOutput(status))
      }

      if (typeof value.command !== "string" || value.command.trim().length === 0) {
        return failed("command is required")
      }

      let directory: string
      try {
        directory = typeof value.workdir === "string" && value.workdir.length > 0
          ? value.workdir
          : await deps.directoryOf(sessionID)
      } catch (error) {
        return failed("could not resolve the session directory: " + messageOf(error))
      }

      const manifest = await readManifest(directory)
      const classified = classify(value.command, manifest)
      const hint = typeof value.timeout === "number" && Number.isFinite(value.timeout) ? value.timeout : undefined
      const direct = resolveNpmScript(directory, value.command)
      const command = direct === undefined ? value.command : npmScriptCommand(direct)
      const promoted = shouldPromoteToJob(classified.kind, hint)

      if (classified.kind === "quick" && !promoted) {
        try {
          const result = await deps.shell.run(command, directory, QUICK_TIMEOUT_MS)
          return done({
            output: result.output,
            exitCode: result.exitCode,
            wallTimeSeconds: result.wallTimeSeconds,
            state: result.exitCode === 0 ? "completed" : "failed",
          })
        } catch (error) {
          if (error instanceof ShellTimeoutError) {
            return stopped(
              error.message + ". Pass a timeout above " + QUICK_TIMEOUT_MS +
                " ms to run it as a job, or add the command to .opencode/run.json.",
              error.output,
              error.wallTimeSeconds,
            )
          }
          return failed(messageOf(error))
        }
      }

      const job = deps.jobs.start(sessionID, command, directory, classified.kind === "service" ? "service" : "job")

      if (classified.kind === "service") {
        const result = await deps.jobs.waitForService(job, {
          ready: classified.rule?.ready,
          port: classified.rule?.port,
          readyTimeoutMs: classified.rule?.readyTimeoutMs ?? 15_000,
        })
        const output = toOutput(result)
        if (output.state === "running") deps.jobs.expect(job.id)
        return done(output)
      }

      const project = TimingStore.project(directory)
      const signature = TimingStore.signature(value.command)
      const deadline = deps.timings.deadline(project, signature, hint)
      // A new signature can have a zero learned deadline. Wait briefly so
      // short jobs (git push, deploys) return their output instead of an
      // immediate empty running result.
      const result = await deps.jobs.waitForJob(job, Math.max(deadline, 2_000))
      if (result.state === "completed" || result.state === "failed") {
        void deps.timings.record(project, signature, result.wallTimeSeconds * 1000)
      } else if (result.state === "running") {
        deps.jobs.expect(job.id)
      }
      return done(toOutput(result))
    },
  }
}

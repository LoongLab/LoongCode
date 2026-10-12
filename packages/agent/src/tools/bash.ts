import { stat } from "node:fs/promises"
import * as path from "node:path"
import { runProcess, type ProcessResult } from "./process"
import { resolveShell, shellStartFailure } from "./shell"
import type { Tool, ToolExecutionContext, ToolResult } from "./types"

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000

/**
 * The description states the shell the command will actually run in, because
 * the model cannot see the platform and the two Windows shells are different
 * languages. The POSIX text is byte-identical to what it has always been; the
 * Windows text names CMD, PowerShell, the setting that chooses between them,
 * and the fact that POSIX commands are unavailable — it does not claim CMD and
 * PowerShell are interchangeable, and it points at the environment block,
 * which states the active shell for the run.
 */
const POSIX_DESCRIPTION =
  "Execute a shell command (/bin/sh on Unix, cmd.exe on Windows) in the repository and observe its output. " +
  "Use for builds, tests, git status/diff, and any repository-specific verification. " +
  "Output is truncated to the last 50KB. The exit code is appended to the output."

const WINDOWS_DESCRIPTION =
  "Execute a command line in the repository and observe its output. On Windows the command runs in " +
  'CMD (cmd.exe) by default, or in Windows PowerShell when "shell" is set to "powershell" in settings.json; ' +
  "the active shell and its syntax are stated in the <env> block of the system prompt. " +
  "CMD and PowerShell are different languages and their syntax is not interchangeable, and POSIX commands " +
  "(ls, cat, rm, grep, ...) do not exist in either — use dir/type/del/where, the read/grep/find tools, or the " +
  "PowerShell cmdlet with the same purpose. Use for builds, tests, git status/diff, and any " +
  "repository-specific verification. Output is truncated to the last 50KB. The exit code is appended to the output."

/** Exit-code sentinel appended to output so the model always sees the
 *  command result; a non-zero exit is data, not a runtime failure. */
export const bashTool: Tool = {
  description: process.platform === "win32" ? WINDOWS_DESCRIPTION : POSIX_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute. Supports pipes, redirects, and variable expansion." },
      workdir: { type: "string", description: "Working directory for the command. Defaults to the session workspace." },
      timeout: { type: "integer", minimum: 1, description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT} (2 minutes). Max ${MAX_TIMEOUT} (10 minutes).` },
    },
    required: ["command"],
  },

  async execute(input: unknown, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { command, workdir, timeout } = input as {
      command?: string
      workdir?: string
      timeout?: number
    }
    if (typeof command !== "string" || command.trim().length === 0) {
      return { ok: false, error: "Command is empty." }
    }
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1)) {
      return { ok: false, error: "timeout must be a positive integer (milliseconds)" }
    }

    let cwd: string
    if (workdir === undefined || workdir === "") {
      cwd = ctx?.cwd ?? process.cwd()
    } else {
      const resolved = resolveWorkdir(workdir, ctx?.cwd)
      const entry = await stat(resolved).catch(() => null)
      if (entry?.isDirectory() !== true) {
        return { ok: false, error: `workdir does not exist or is not a directory: ${resolved}` }
      }
      cwd = resolved
    }

    const effectiveTimeout = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT, 1), MAX_TIMEOUT)
    const timeoutController = new AbortController()
    const timeoutHandle = setTimeout(() => timeoutController.abort(), effectiveTimeout)
    // The run's cancellation signal also kills the command: aborting a run
    // must not wait out a long-running child.
    const signal = ctx?.signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([timeoutController.signal, ctx.signal])

    // The platform's own shell, or the Windows shell the user selected. The
    // selection never changes what POSIX runs, and an unavailable shell is a
    // failure to report, never a reason to run the command in another one.
    const shell = resolveShell(process.platform, ctx?.shell, process.env)

    let result: ProcessResult
    try {
      result = await runProcess(shell.command, [...shell.args, command], {
        cwd,
        env: { ...process.env },
        signal,
        onOutput: ctx?.onOutput,
      })
    } catch (err) {
      clearTimeout(timeoutHandle)
      if (timeoutController.signal.aborted) {
        return {
          ok: false,
          error: `Command timed out after ${formatDuration(effectiveTimeout)} and was terminated.`,
        }
      }
      if (ctx?.signal?.aborted) {
        return { ok: false, error: "Command cancelled: the run was aborted." }
      }
      const message = err instanceof Error ? err.message : String(err)
      if (process.platform === "win32") {
        return { ok: false, error: shellStartFailure(shell, message) }
      }
      return { ok: false, error: `Command execution failed: ${message}` }
    }
    clearTimeout(timeoutHandle)

    if (timeoutController.signal.aborted) {
      return {
        ok: false,
        error: `Command timed out after ${formatDuration(effectiveTimeout)}.\nPartial output:\n${combine(result.stdout, result.stderr)}${resultNotes(result)}`,
      }
    }

    // A non-zero exit is `ok: true` — exit codes are data, not tool errors.
    // The text stays byte-identical; `failureEvidence` only records that the
    // command *observed* a failure, so request-time pruning keeps it.
    // Notes ride in front of the exit code: a guessed decoding, or a
    // cancellation whose cleanup could not be confirmed, is never silently
    // presented as fact.
    const data = `${combine(result.stdout, result.stderr)}${resultNotes(result)}\n(exit code: ${result.exitCode})`
    return result.exitCode === 0
      ? { ok: true, data }
      : { ok: true, data, failureEvidence: true }
  },
}

function resolveWorkdir(workdir: string, cwd?: string): string {
  const base = cwd ?? process.cwd()
  // path.resolve instead of string concatenation: a relative workdir and a
  // Windows drive-letter workdir both have to survive, and a trailing
  // separator must be trimmed without eating the root itself (`/` or `C:\`).
  const resolved = path.isAbsolute(workdir) ? path.normalize(workdir) : path.resolve(base, workdir)
  const root = path.parse(resolved).root
  const trimmed = resolved.replace(/[\\/]+$/, "")
  return trimmed.length < root.length ? root : trimmed
}

/**
 * Joins the two streams. Deliberately does NOT cap: the size bound belongs to
 * the canonical cap in `truncate.ts`, which both limits what the model sees and
 * keeps the full text recoverable.
 *
 * This used to keep only the last 50KB and drop the head with no way back. The
 * cut ran after `readStreaming` had already accumulated every byte and after
 * `Promise.all` had awaited both pipes, so it never protected memory or the
 * runtime — all it did was discard the head immediately before the canonical
 * cap would have spilled the whole output for recovery.
 */
function combine(stdout: string, stderr: string): string {
  return stderr ? `${stdout}\n(stderr)\n${stderr}` : stdout
}

/** Both caveats a result can carry: a disclosed decoding fallback (Windows)
 *  and a cancellation whose cleanup could not be confirmed. Neither is set on
 *  an ordinary POSIX command, so its text is unchanged. */
function resultNotes(result: ProcessResult): string {
  const decode = result.decodeNote === undefined ? "" : `\n(note: ${result.decodeNote})`
  const termination = result.terminationNote === undefined ? "" : `\n(warning: ${result.terminationNote})`
  return decode + termination
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

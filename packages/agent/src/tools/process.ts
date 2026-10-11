import { spawn, type ChildProcess } from "node:child_process"
import { constants } from "node:os"

/**
 * Subprocess execution for the bash and grep tools, on `node:child_process`.
 *
 * The behaviour mirrors what `Bun.spawn` was measured to do, so the tools keep
 * their existing contracts:
 *
 * - stdin is `/dev/null` — a spawned command must not steal the TUI's input
 * - stdout and stderr stream to `onOutput` as they arrive, in arrival order
 * - the exit code is the process's own, or `128 + signal` when it was killed
 *   (SIGTERM → 143, SIGKILL → 137), which is what Bun reported
 * - aborting the run terminates the child rather than leaving it running
 * - a command that cannot be spawned rejects with the same wording Bun used
 *
 * Aborting takes the whole process tree down, not just the direct child. A
 * shell command routinely forks (`sh -c "sleep 30"` on dash leaves `sleep`
 * running with the output pipes still open, so killing only the shell both
 * orphans the child and never lets the read finish). On POSIX the child gets
 * its own process group and abort signals the group; on Windows `taskkill /T`
 * does the same job.
 */

export interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface RunProcessOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** The run's cancellation signal. Aborting terminates the child. */
  readonly signal?: AbortSignal
  /** Streaming output for both stdout and stderr, in arrival order. */
  readonly onOutput?: (chunk: string) => void
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group on POSIX so abort can signal the whole tree.
      // Deliberately not detached on Windows: there it would open a console
      // window, and taskkill already reaches the tree.
      detached: process.platform !== "win32",
    })

    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener("abort", onAbort)
      finish()
    }

    function onAbort(): void {
      terminate(child)
    }

    // A signal that fired before the spawn finished still has to kill it.
    if (options.signal?.aborted === true) terminate(child)
    else options.signal?.addEventListener("abort", onAbort, { once: true })

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => reject(spawnFailure(command, err)))
    })

    // setEncoding decodes with a streaming decoder, so a multi-byte character
    // split across two chunks is reassembled rather than mangled.
    child.stdout?.setEncoding("utf-8")
    child.stderr?.setEncoding("utf-8")

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
      options.onOutput?.(chunk)
    })
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
      options.onOutput?.(chunk)
    })

    child.on("close", (code, signal) => {
      settle(() => resolve({ stdout, stderr, exitCode: code ?? signalExitCode(signal) }))
    })
  })
}

/** SIGTERM → 143, SIGKILL → 137: the shell convention Bun also reported. */
function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 0
  return 128 + (constants.signals[signal] ?? 0)
}

/** Ends the child and everything the child started. */
function terminate(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("error", () => {})
    } catch {
      // taskkill unavailable — fall back to ending the direct child only.
      child.kill()
    }
    return
  }
  try {
    // Negative pid signals the child's process group, taking its children too.
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
}

/** Bun's wording for a missing executable, preserved so messages do not drift. */
function spawnFailure(command: string, err: NodeJS.ErrnoException): Error {
  if (err.code === "ENOENT") return new Error(`Executable not found in $PATH: "${command}"`)
  return err
}

import { spawn, type ChildProcess } from "node:child_process"
import { constants } from "node:os"
import { decodeUtf8, decodeWindowsOutput } from "./encoding"

/**
 * Subprocess execution for the bash and grep tools, on `node:child_process`.
 *
 * The behaviour mirrors what `Bun.spawn` was measured to do, so the tools keep
 * their existing contracts:
 *
 * - stdin is `/dev/null` — a spawned command must not steal the TUI's input
 * - stdout and stderr stream to `onOutput` as they arrive, in arrival order
 * - the bytes of both streams are decoded when the stream ends: UTF-8 on
 *   POSIX, and on Windows UTF-8 unless the whole stream proves otherwise, in
 *   which case the console code page is used as a labelled fallback
 * - the exit code is the process's own, or `128 + signal` when it was killed
 *   (SIGTERM → 143, SIGKILL → 137), which is what Bun reported
 * - aborting the run terminates the child rather than leaving it running, and
 *   the call settles within a bounded grace period even when termination
 *   cannot be confirmed
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
  /** Set when output had to be decoded with a disclosed fallback (Windows code
   *  pages); null/absent on POSIX, where UTF-8 is the contract. */
  readonly decodeNote?: string
  /** Set when cancellation could not be confirmed to have ended the process
   *  tree. Never proof either way — it records what was attempted. */
  readonly terminationNote?: string
}

export interface RunProcessOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** The run's cancellation signal. Aborting terminates the child. */
  readonly signal?: AbortSignal
  /** Streaming output for both stdout and stderr, in arrival order. */
  readonly onOutput?: (chunk: string) => void
}

/** How long a cancelled run may take to settle before the call stops waiting.
 *  Completion is a guarantee; termination is not, and the two are reported
 *  separately: when this elapses, the result says termination was attempted
 *  and could not be confirmed. */
const TERMINATION_GRACE_MS = 2000

/** What cancellation was able to do, recorded rather than assumed. */
type TerminationAttempt = "none" | "tree" | "direct"

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
    let terminationAttempt: TerminationAttempt = "none"
    let terminationTimer: NodeJS.Timeout | null = null

    const stdoutChunks = captureStream(child.stdout, options.onOutput)
    const stderrChunks = captureStream(child.stderr, options.onOutput)

    const finalResult = (exitCode: number, terminationNote?: string): ProcessResult => {
      const stdout = decodeCaptured(stdoutChunks)
      const stderr = decodeCaptured(stderrChunks)
      const notes = [stdout.note, stderr.note].filter((note): note is string => note !== null)
      const decodeNote = notes.length === 0 ? undefined : [...new Set(notes)].join("; ")
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        ...(decodeNote === undefined ? {} : { decodeNote }),
        ...(terminationNote === undefined ? {} : { terminationNote }),
      }
    }

    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener("abort", onAbort)
      if (terminationTimer !== null) clearTimeout(terminationTimer)
      finish()
    }

    function onAbort(): void {
      terminationAttempt = terminate(child)
      if (settled) return
      // Started only once a termination has been attempted, so a normal run
      // never carries a pending timer.
      terminationTimer = setTimeout(onTerminationDeadline, TERMINATION_GRACE_MS)
      // The child's own handle keeps the run alive until it exits; the timer
      // must not be a second reason for the process to stay open.
      terminationTimer.unref?.()
    }

    /**
     * The process had not exited within the grace period after cancellation.
     * Completion is enforced here — the pipes are closed so this call cannot
     * wait any longer — while termination is reported as what it is: attempted
     * and unconfirmed. Destroying the pipes is not evidence of anything about
     * the process; it only ends our interest in its output.
     */
    function onTerminationDeadline(): void {
      if (settled) return
      escalateTermination(child, terminationAttempt)
      child.stdout?.destroy()
      child.stderr?.destroy()
      // Nothing is waiting on the child any more; do not let a process we could
      // not kill hold the whole CLI open.
      child.unref()
      const note = terminationAttempt === "none"
        // Nothing was there to terminate: the command had exited, and what kept
        // this call waiting was output still held open by something it started.
        ? "the command had already exited but its output was still held open; a process it started may still be running, and this output may be incomplete"
        : `termination was attempted (${
          terminationAttempt === "tree" ? "process tree" : "direct child"
        }) but the process had not exited within ${TERMINATION_GRACE_MS}ms; it may still be running, and this output may be incomplete`
      settle(() => resolve(finalResult(SIGNAL_TERM_EXIT_CODE, note)))
    }

    // A signal that fired before the spawn finished still has to kill it.
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener("abort", onAbort, { once: true })

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => reject(spawnFailure(command, err)))
    })

    child.on("close", (code, signal) => {
      settle(() => resolve(finalResult(code ?? signalExitCode(signal))))
    })
  })
}

/** Collects a stream's bytes, forwarding a decoded preview as they arrive. */
function captureStream(
  stream: NodeJS.ReadableStream | null,
  onOutput?: (chunk: string) => void,
): Buffer[] {
  const chunks: Buffer[] = []
  if (stream === null) return chunks
  const preview = new TextDecoder("utf-8")
  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk)
    onOutput?.(preview.decode(chunk, { stream: true }))
  })
  return chunks
}

/** One complete stream, decoded by the platform's contract. */
function decodeCaptured(chunks: readonly Buffer[]): { text: string; note: string | null } {
  const bytes = Buffer.concat(chunks)
  if (process.platform !== "win32") return { text: decodeUtf8(bytes), note: null }
  return decodeWindowsOutput(bytes)
}

/** SIGTERM → 143, SIGKILL → 137: the shell convention Bun also reported. */
function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 0
  return 128 + (constants.signals[signal] ?? 0)
}

const SIGNAL_TERM_EXIT_CODE = 128 + (constants.signals.SIGTERM ?? 15)

/**
 * Ends the child and everything the child started, and reports what it was
 * able to attempt. Nothing here can prove the tree is gone: `taskkill` exiting
 * non-zero, `kill` returning false, or the child already having exited are all
 * just observations, which is why confirmation is a separate question with its
 * own deadline and its own note.
 */
function terminate(child: ChildProcess): TerminationAttempt {
  if (child.pid === undefined || child.exitCode !== null) return "none"

  if (process.platform === "win32") {
    // taskkill reaches descendants (/t) and cannot be ignored (/f). Both
    // handler paths fall back to the direct child, and both are attached to
    // the killer process — the previous version attached the error handler to
    // a stream it had dropped, so neither could ever run and a missing
    // taskkill left the child alive and the call waiting forever.
    let killer: ChildProcess
    try {
      killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      })
    } catch {
      child.kill()
      return "direct"
    }
    killer.on("error", () => child.kill())
    killer.on("close", code => {
      if (code !== 0) child.kill()
    })
    killer.unref()
    return "tree"
  }

  try {
    // Negative pid signals the child's process group, taking its children too.
    process.kill(-child.pid, "SIGTERM")
    return "tree"
  } catch {
    child.kill("SIGTERM")
    return "direct"
  }
}

/** The last resort when the grace period expires: an escalation that cannot be
 *  ignored, still best-effort, still unconfirmed. */
function escalateTermination(child: ChildProcess, attempt: TerminationAttempt): void {
  if (attempt === "none" || child.exitCode !== null) return
  if (process.platform === "win32") {
    // TerminateProcess has no graceful variant, and taskkill has already been
    // tried: the direct child is all that is left.
    child.kill()
    return
  }
  try {
    process.kill(-child.pid!, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

/** Bun's wording for a missing executable, preserved so messages do not drift. */
function spawnFailure(command: string, err: NodeJS.ErrnoException): Error {
  if (err.code === "ENOENT") return new Error(`Executable not found in $PATH: "${command}"`)
  return err
}

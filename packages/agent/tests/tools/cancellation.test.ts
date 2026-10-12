import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runProcess } from "../../src/tools/process"

/**
 * Cancellation has two guarantees, and they are tested separately:
 *
 * - completion: the call settles within the grace period, always
 * - cleanup: the processes it started are actually gone — best-effort, and
 *   reported as unconfirmed when it cannot be established
 *
 * A test that only asserted "the promise resolved" would pass on an
 * implementation that left the process running forever, which is exactly what
 * the Windows path did before this change; so the assertions below look at the
 * OS, not only at the promise.
 */

const unixOnly = process.platform !== "win32"
const GRACE_MS = 2000
/** Generous margin over the grace period: the assertion is "bounded", not "fast". */
const SETTLE_LIMIT_MS = GRACE_MS + 3000

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loongcode-cancel-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** True when the pid exists (POSIX: signal 0 probes without sending). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The pid a command wrote for itself, or a failure — never an endless wait. */
async function waitForPid(file: string): Promise<number> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(file, "utf-8").trim()
      if (text.length > 0) return Number.parseInt(text, 10)
    } catch {
      // Not written yet.
    }
    await Bun.sleep(10)
  }
  throw new Error(`the command never wrote its pid to ${file}`)
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<"timeout">(resolve => {
    timer = setTimeout(() => resolve("timeout"), ms)
  })
  const outcome = await Promise.race([promise.then(() => "settled" as const), timeout])
  clearTimeout(timer)
  return outcome === "settled"
}

if (unixOnly) {
  describe("completion and cleanup, separately", () => {
    test("a cancelled command settles, and the process it started is gone", async () => {
      const { dir, cleanup } = scratch()
      const controller = new AbortController()

      const promise = runProcess(
        "/bin/sh",
        ["-c", `echo $$ > ${join(dir, "pid")}; exec sleep 30`],
        { signal: controller.signal },
      )
      const pid = await waitForPid(join(dir, "pid"))

      controller.abort()
      const result = await promise

      expect(result.exitCode).toBe(143)
      // Cleanup verified against the OS rather than inferred from the promise.
      expect(alive(pid)).toBe(false)
      // The command was confirmed gone, so there is no uncertainty to disclose.
      expect(result.terminationNote).toBeUndefined()
      cleanup()
    })

    test("descendants are taken down with the shell, not orphaned", async () => {
      const { dir, cleanup } = scratch()
      const controller = new AbortController()

      // The shell's child is what keeps the output pipes open, so killing only
      // the shell would orphan it and never let the read finish.
      const promise = runProcess(
        "/bin/sh",
        ["-c", `sleep 30 & echo $! > ${join(dir, "pid")}; wait`],
        { signal: controller.signal },
      )
      const grandchild = await waitForPid(join(dir, "pid"))

      controller.abort()
      const result = await promise

      expect(result.exitCode).toBe(143)
      expect(alive(grandchild)).toBe(false)
      cleanup()
    })

    test("a descendant that ignores SIGTERM cannot hang the call", async () => {
      const { dir, cleanup } = scratch()
      const controller = new AbortController()

      // The subshell ignores SIGTERM and holds the pipe, so no 'close' event
      // will ever arrive: only the grace period can end this call.
      const promise = runProcess(
        "/bin/sh",
        ["-c", `(trap "" TERM; echo $$ > ${join(dir, "pid")}; exec sleep 30) & wait`],
        { signal: controller.signal },
      )
      const stubborn = await waitForPid(join(dir, "pid"))

      const started = Date.now()
      controller.abort()
      const settled = await settledWithin(promise, SETTLE_LIMIT_MS)
      const elapsed = Date.now() - started
      const result = await promise

      expect(settled).toBe(true)
      expect(elapsed).toBeLessThan(SETTLE_LIMIT_MS)
      expect(result.exitCode).toBe(143)
      // The uncertainty is disclosed rather than hidden...
      expect(result.terminationNote).toContain("had not exited")
      expect(result.terminationNote).toContain("may still be running")
      // ...and the escalation after the deadline still cleaned up.
      expect(alive(stubborn)).toBe(false)
      cleanup()
    })

    test("a child that exits as it is cancelled reports its own exit, not a hang", async () => {
      // The race between cancellation and a normal exit, repeatedly: the
      // single-shot settle means one of them wins, and what must never happen
      // is a hang or two results.
      for (let i = 0; i < 15; i++) {
        const controller = new AbortController()
        const promise = runProcess("/bin/sh", ["-c", "exit 0"], { signal: controller.signal })
        controller.abort()
        expect(await settledWithin(promise, SETTLE_LIMIT_MS)).toBe(true)
        const result = await promise
        expect([0, 143]).toContain(result.exitCode)
      }
    })

    test("a signal that fired before the spawn still ends the child", async () => {
      const { dir, cleanup } = scratch()
      const controller = new AbortController()
      controller.abort()

      const result = await runProcess(
        "/bin/sh",
        ["-c", `echo $$ > ${join(dir, "pid")}; exec sleep 30`],
        { signal: controller.signal },
      )
      expect(result.exitCode).toBe(143)

      // If it managed to start at all, it must not still be running.
      let pid = 0
      try {
        pid = Number.parseInt(readFileSync(join(dir, "pid"), "utf-8").trim(), 10)
      } catch {
        // Never started: nothing to clean up.
      }
      if (pid > 0) expect(alive(pid)).toBe(false)
      cleanup()
    })
  })
}

describe("the simulated Windows path", () => {
  if (!unixOnly) return // the simulation runs the POSIX command on a POSIX host

  test("a missing taskkill no longer leaves the call waiting forever", async () => {
    const { dir, cleanup } = scratch()
    const controller = new AbortController()

    const promise = runProcess(
      "/bin/sh",
      ["-c", `(trap "" TERM; echo $$ > ${join(dir, "pid")}; exec sleep 30) & wait`],
      { signal: controller.signal },
    )
    const stubborn = await waitForPid(join(dir, "pid"))

    // Take the Windows branch on this host. `taskkill` does not exist here, so
    // the fallback has to run and the grace period has to end the call — the
    // old code attached its error handler to a stream it had dropped, leaving
    // this promise pending forever.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      const started = Date.now()
      controller.abort()
      const settled = await settledWithin(promise, SETTLE_LIMIT_MS)
      const elapsed = Date.now() - started
      const result = await promise

      expect(settled).toBe(true)
      expect(elapsed).toBeLessThan(SETTLE_LIMIT_MS)
      expect(result.exitCode).toBe(143)
      // The simulated branch cannot reach a Windows tree, so it must say so.
      expect(result.terminationNote).toBeDefined()
    } finally {
      if (platform !== undefined) Object.defineProperty(process, "platform", platform)
      try {
        process.kill(stubborn, "SIGKILL")
      } catch {
        // Already gone.
      }
      cleanup()
    }
  })
})

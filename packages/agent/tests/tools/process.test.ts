import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runProcess } from "../../src/tools/process"

/** Signal delivery is POSIX; on Windows the exit-code shape differs. */
const unixOnly = process.platform !== "win32"

describe("runProcess", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const result = await runProcess("/bin/sh", ["-c", "echo out; echo err 1>&2; exit 7"])
    expect(result.stdout).toBe("out\n")
    expect(result.stderr).toBe("err\n")
    expect(result.exitCode).toBe(7)
  })

  test("streams both pipes to onOutput as they arrive", async () => {
    const chunks: string[] = []
    const result = await runProcess("/bin/sh", ["-c", "printf a; printf b; printf c 1>&2"], {
      onOutput: chunk => chunks.push(chunk),
    })
    expect(chunks.join("")).toBe("abc")
    expect(result.stdout).toBe("ab")
    expect(result.stderr).toBe("c")
  })

  test("a multibyte character split across writes is reassembled", async () => {
    // "é" is C3 A9; printing it as two writes puts the decoder on the seam,
    // where a decoder without partial-sequence buffering yields garbage.
    const result = await runProcess("/bin/sh", ["-c", "printf '\\303'; printf '\\251'"])
    expect(result.stdout).toBe("é")
  })

  test("stdin is /dev/null, so a command cannot consume the terminal", async () => {
    const result = await runProcess("/bin/sh", ["-c", "cat; echo done"])
    expect(result.stdout).toBe("done\n")
    expect(result.exitCode).toBe(0)
  })

  test("the cwd option is the child's working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loongcode-process-test-"))
    try {
      const result = await runProcess("/bin/sh", ["-c", "pwd"], { cwd: dir })
      expect(realpathSync(result.stdout.trim())).toBe(realpathSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an executable that does not exist rejects with the preserved message", async () => {
    await expect(runProcess("definitely-not-a-real-binary-xyz", [])).rejects.toThrow(
      /Executable not found in \$PATH/,
    )
  })

  test("explicit env replaces the environment", async () => {
    const result = await runProcess("/bin/sh", ["-c", "printf %s \"$LOONGCODE_PROCESS_TEST\""], {
      env: { LOONGCODE_PROCESS_TEST: "sentinel", PATH: process.env.PATH },
    })
    expect(result.stdout).toBe("sentinel")
  })

  if (unixOnly) {
    test("aborting terminates the child and reports 128 + SIGTERM", async () => {
      const controller = new AbortController()
      const promise = runProcess("/bin/sh", ["-c", "sleep 30"], { signal: controller.signal })
      setTimeout(() => controller.abort(), 200)
      const result = await promise
      expect(result.exitCode).toBe(143)
    })

    test("a signal-killed process reports 128 + the signal number", async () => {
      const result = await runProcess("/bin/sh", ["-c", "kill -9 $$"])
      expect(result.exitCode).toBe(137)
    })
  }
})

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CODING_TOOLS } from "../../src/tools"

/**
 * Filesystem behaviour the Node migration had to preserve exactly. Each case
 * here was a real difference between the old runtime's helpers and the plain
 * node:fs calls that replaced them.
 */

const ctx = (cwd: string) => ({ cwd })

function tempWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loongcode-fs-semantics-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("filesystem semantics preserved by the migration", () => {
  test("edit creating a file also creates missing parent directories", async () => {
    const { dir, cleanup } = tempWorkspace()
    const result = await CODING_TOOLS.get("edit")!.execute(
      { filePath: "deep/nested/created.md", oldString: "", newString: "# Hello" },
      ctx(dir),
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "deep/nested/created.md"), "utf-8")).toBe("# Hello")
    cleanup()
  })

  test("write preserves a byte-order mark it did not add", async () => {
    const { dir, cleanup } = tempWorkspace()
    const path = join(dir, "bom.txt")
    writeFileSync(path, "﻿original\n", "utf-8")

    const result = await CODING_TOOLS.get("write")!.execute(
      { filePath: "bom.txt", content: "replaced\n" },
      ctx(dir),
    )
    expect(result.ok).toBe(true)
    // The BOM survives the round trip: readFile keeps it, so the write path
    // detects it and puts it back.
    expect(readFileSync(path, "utf-8")).toBe("﻿replaced\n")
    cleanup()
  })

  test("read handles files larger than the binary-sniff prefix", async () => {
    const { dir, cleanup } = tempWorkspace()
    const lines = Array.from({ length: 4000 }, (_, i) => `line-${i}`)
    writeFileSync(join(dir, "big.txt"), lines.join("\n") + "\n", "utf-8")

    const result = await CODING_TOOLS.get("read")!.execute({ filePath: "big.txt" }, ctx(dir))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toContain("1: line-0")
      expect(result.data).toContain("2000: line-1999")
    }
    cleanup()
  })

  test("bash reports a missing workdir instead of failing later", async () => {
    const { dir, cleanup } = tempWorkspace()
    const result = await CODING_TOOLS.get("bash")!.execute(
      { command: "pwd", workdir: "does/not/exist" },
      ctx(dir),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("workdir does not exist")
    cleanup()
  })

  test("bash resolves a relative workdir under the session cwd", async () => {
    const { dir, cleanup } = tempWorkspace()
    mkdirSync(join(dir, "sub"), { recursive: true })
    writeFileSync(join(dir, "sub/inside.txt"), "here")
    const result = await CODING_TOOLS.get("bash")!.execute(
      { command: "ls", workdir: "sub" },
      ctx(dir),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toContain("inside.txt")
      // The workdir is the subdirectory, not the session root.
      expect(result.data).not.toContain("sub/")
    }
    cleanup()
  })
})

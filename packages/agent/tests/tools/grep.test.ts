import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { grepTool } from "../../src/tools/grep"

/**
 * The native search tool must keep the contract the spawned GNU grep had.
 * Every case below was measured against GNU `grep -rniIE` before the tool was
 * replaced, so these tests pin behaviour rather than describe an implementation.
 *
 * Symlinks, permissions and FIFOs are POSIX; those cases carry `unixOnly`.
 */

const unixOnly = process.platform !== "win32"

function workspace(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "loongcode-grep-")))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const ctx = (cwd: string) => ({ cwd })

async function search(pattern: string, input: Record<string, unknown>, dir: string) {
  return grepTool.execute({ pattern, ...input }, ctx(dir))
}

describe("output shape", () => {
  test("a directory target prints path:line:text from the resolved target", async () => {
    const { dir, cleanup } = workspace()
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg/a.ts"), "export const needle = 1\n")

    const result = await search("needle", { path: "pkg" }, dir)
    expect(result).toEqual({ ok: true, data: `${dir}/pkg/a.ts:1:export const needle = 1` })
    cleanup()
  })

  test("a file target omits the filename, as grep did for a single operand", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "a.ts"), "alpha\nbeta\nalpha\n")

    const result = await search("alpha", { path: "a.ts" }, dir)
    expect(result).toEqual({ ok: true, data: "1:alpha\n3:alpha" })
    cleanup()
  })

  test("line numbers restart for each file", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "a.txt"), "x\nmatch\n")
    writeFileSync(join(dir, "b.txt"), "match\n")

    const result = await search("match", {}, dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toContain("a.txt:2:match")
      expect(result.data).toContain("b.txt:1:match")
    }
    cleanup()
  })

  test("a directory target with a trailing separator does not double the slash", async () => {
    const { dir, cleanup } = workspace()
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg/a.ts"), "needle\n")

    const result = await search("needle", { path: `${dir}/pkg/` }, dir)
    expect(result).toEqual({ ok: true, data: `${dir}/pkg/a.ts:1:needle` })
    cleanup()
  })

  test("no matches is exactly the historical sentence", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "a.txt"), "nothing here\n")

    expect(await search("zzz-not-there", {}, dir)).toEqual({ ok: true, data: "No matches found." })
    cleanup()
  })
})

describe("matching", () => {
  test("matching is case-insensitive in the pattern only", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "a.txt"), "Needle\nneedle\nNEEDLE\n")

    const result = await search("nEeDlE", {}, dir)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.split("\n")).toHaveLength(3)
    cleanup()
  })

  test("include filters on the basename, case-sensitively", async () => {
    const { dir, cleanup } = workspace()
    mkdirSync(join(dir, "sub"))
    writeFileSync(join(dir, "sub/a.ts"), "needle\n")
    writeFileSync(join(dir, "sub/b.TS"), "needle\n")

    const result = await search("needle", { include: "*.ts" }, dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toContain("a.ts")
      expect(result.data).not.toContain("b.TS")
    }
    cleanup()
  })

  test("include applies to an explicit file target too", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "a.ts"), "needle\n")

    expect(await search("needle", { path: "a.ts", include: "*.md" }, dir))
      .toEqual({ ok: true, data: "No matches found." })
    expect(await search("needle", { path: "a.ts", include: "*.ts" }, dir))
      .toEqual({ ok: true, data: "1:needle" })
    cleanup()
  })

  test("JavaScript constructs that POSIX ERE lacked now work", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "a.txt"), "id-42\nid-abc\n")

    const result = await search("id-\\d+", {}, dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toContain("id-42")
      expect(result.data).not.toContain("id-abc")
    }
    cleanup()
  })

  test("non-ASCII content matches", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "cn.txt"), "第一行\n第二行 龙\n")

    const result = await search("龙", {}, dir)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toContain("2:第二行 龙")
    cleanup()
  })
})

describe("lines", () => {
  test("CRLF content keeps its carriage return, as grep emitted it", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "crlf.txt"), "x\r\nneedle\r\n")

    const result = await search("needle", { path: "crlf.txt" }, dir)
    expect(result).toEqual({ ok: true, data: "2:needle\r" })
    cleanup()
  })

  test("a last line without a trailing newline is searched and numbered", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "noeol.txt"), "alpha\nneedle")

    const result = await search("needle", { path: "noeol.txt" }, dir)
    expect(result).toEqual({ ok: true, data: "2:needle" })
    cleanup()
  })

  test("an empty line matches ^$ at its real line number, and no phantom line exists", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "blank.txt"), "head\nalpha\n\ntail\n")

    const result = await search("^$", { path: "blank.txt" }, dir)
    expect(result).toEqual({ ok: true, data: "3:" })
    cleanup()
  })

  test("an empty file has nothing to match", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "empty.txt"), "")

    expect(await search("^$", { path: "empty.txt" }, dir)).toEqual({ ok: true, data: "No matches found." })
    cleanup()
  })
})

describe("caps", () => {
  test("only the first 100 matches are returned, with the total in the suffix", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "many.txt"), Array.from({ length: 130 }, (_, i) => `needle ${i}`).join("\n"))

    const result = await search("needle", { path: "many.txt" }, dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const body = result.data.split("\n\n")[0]!
      expect(body.split("\n")).toHaveLength(100)
      expect(result.data).toContain("(Showing 100 of 130 matches. Refine the pattern or narrow the path.)")
    }
    cleanup()
  })

  test("a matched line longer than 2000 characters is truncated with an ellipsis", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "long.txt"), `needle ${"x".repeat(3000)}\n`)

    const result = await search("needle", { path: "long.txt" }, dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.endsWith("...")).toBe(true)
      // 2000 characters kept, plus the ellipsis.
      expect(result.data.length).toBe(2003)
    }
    cleanup()
  })
})

describe("binary detection", () => {
  test("a file containing a NUL is skipped even when a match precedes it", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "blob.bin"), Buffer.from("needle before NUL\0after\n", "utf-8"))

    expect(await search("needle", { path: "blob.bin" }, dir)).toEqual({ ok: true, data: "No matches found." })
    cleanup()
  })

  test("detection is by content, not by extension: a .png holding text is searched", async () => {
    const { dir, cleanup } = workspace()
    writeFileSync(join(dir, "fake.png"), "needle\n")

    expect(await search("needle", { path: "fake.png" }, dir)).toEqual({ ok: true, data: "1:needle" })
    cleanup()
  })

  test("high-entropy content is skipped", async () => {
    const { dir, cleanup } = workspace()
    // Bytes 1-8 repeated: non-printable by ratio, and deliberately no NUL, so
    // this exercises the ratio rule rather than the NUL shortcut.
    const bytes = Buffer.alloc(512)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i % 8) + 1
    writeFileSync(join(dir, "noise.dat"), bytes)

    expect(await search(".", { path: "noise.dat" }, dir)).toEqual({ ok: true, data: "No matches found." })
    cleanup()
  })
})

describe("traversal scope", () => {
  test(".git and node_modules are searched: the scope did not change", async () => {
    const { dir, cleanup } = workspace()
    mkdirSync(join(dir, ".git"))
    mkdirSync(join(dir, "node_modules/dep"), { recursive: true })
    writeFileSync(join(dir, ".git/config"), "needle-in-git\n")
    writeFileSync(join(dir, "node_modules/dep/index.js"), "needle-in-modules\n")

    const result = await search("needle-in-", {}, dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toContain(".git/config:1:needle-in-git")
      expect(result.data).toContain("node_modules/dep/index.js:1:needle-in-modules")
    }
    cleanup()
  })

  if (unixOnly) {
    test("a symlinked file met during traversal is not searched, a symlinked target is", async () => {
      const { dir, cleanup } = workspace()
      mkdirSync(join(dir, "real"))
      writeFileSync(join(dir, "real/a.ts"), "needle\n")
      symlinkSync(join(dir, "real/a.ts"), join(dir, "link.ts"))
      symlinkSync(join(dir, "real"), join(dir, "linkdir"))

      const tree = await search("needle", {}, dir)
      expect(tree.ok).toBe(true)
      if (tree.ok) {
        expect(tree.data).toContain("real/a.ts:1:needle")
        expect(tree.data).not.toContain("link.ts")
        expect(tree.data).not.toContain("linkdir/")
      }

      const linked = await search("needle", { path: "linkdir" }, dir)
      expect(linked.ok).toBe(true)
      if (linked.ok) expect(linked.data).toContain(`${dir}/linkdir/a.ts:1:needle`)
      cleanup()
    })

    test("a FIFO is skipped rather than read", async () => {
      const { dir, cleanup } = workspace()
      execFileSync("mkfifo", [join(dir, "pipe")])
      writeFileSync(join(dir, "a.txt"), "needle\n")

      // If the walker opened the FIFO this would never settle; the test's own
      // timeout is the failure signal.
      const result = await search("needle", {}, dir)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data).toContain("a.txt:1:needle")
      cleanup()
    })

    test("an unreadable subdirectory yields partial results that say they are incomplete", async () => {
      const { dir, cleanup } = workspace()
      mkdirSync(join(dir, "open"))
      mkdirSync(join(dir, "locked"))
      writeFileSync(join(dir, "open/a.txt"), "needle\n")
      writeFileSync(join(dir, "locked/b.txt"), "needle\n")
      chmodSync(join(dir, "locked"), 0o000)

      try {
        const result = await search("needle", {}, dir)
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.data).toContain("a.txt:1:needle")
          expect(result.data).toContain("Search incomplete: 1 path could not be read")
          expect(result.data).toContain("locked")
        }
      } finally {
        chmodSync(join(dir, "locked"), 0o755)
        cleanup()
      }
    })

    test("an unreadable root is an error, as the failing grep invocation was", async () => {
      const { dir, cleanup } = workspace()
      mkdirSync(join(dir, "locked"))
      chmodSync(join(dir, "locked"), 0o000)

      try {
        const result = await search("needle", { path: "locked" }, dir)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.startsWith("Cannot read directory")).toBe(true)
      } finally {
        chmodSync(join(dir, "locked"), 0o755)
        cleanup()
      }
    })
  }
})

describe("errors", () => {
  test("a missing search path is an error, never 'no matches'", async () => {
    const { dir, cleanup } = workspace()
    const result = await search("needle", { path: "does-not-exist" }, dir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("Search path does not exist")
    cleanup()
  })

  if (unixOnly) {
    test("an inaccessible search path is not reported as a missing one", async () => {
      const { dir, cleanup } = workspace()
      mkdirSync(join(dir, "locked/child"), { recursive: true })
      chmodSync(join(dir, "locked"), 0o000)
      try {
        const result = await search("needle", { path: "locked/child" }, dir)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          // Saying "does not exist" would send the model hunting for a typo.
          expect(result.error).toContain("Cannot read search path")
          expect(result.error).not.toContain("does not exist")
        }
      } finally {
        chmodSync(join(dir, "locked"), 0o755)
        cleanup()
      }
    })
  }

  test("an invalid regular expression is reported, not thrown", async () => {
    const { dir, cleanup } = workspace()
    const result = await search("(unclosed", {}, dir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.startsWith("Invalid regular expression")).toBe(true)
    cleanup()
  })

  test("an empty pattern is rejected before any filesystem work", async () => {
    const { dir, cleanup } = workspace()
    expect(await search("", {}, dir)).toEqual({ ok: false, error: "pattern is required" })
    cleanup()
  })

  test("POSIX-only constructs are rejected with the replacement spelled out", async () => {
    const { dir, cleanup } = workspace()

    const posixClass = await search("[[:alpha:]]lpha", {}, dir)
    expect(posixClass.ok).toBe(false)
    if (!posixClass.ok) {
      expect(posixClass.error).toContain("POSIX character class")
      expect(posixClass.error).toContain("[A-Za-z]")
    }

    const wordBoundary = await search("\\<needle", {}, dir)
    expect(wordBoundary.ok).toBe(false)
    if (!wordBoundary.ok) {
      expect(wordBoundary.error).toContain("word-boundary")
      expect(wordBoundary.error).toContain("\\b")
    }
    cleanup()
  })
})

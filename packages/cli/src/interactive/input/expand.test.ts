import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandFileReferences, resolveReferencePath } from "./expand"

describe("@file expansion", () => {
  test("expands an existing file reference into a marked block", () => {
    const dir = mkdtempSync(join(tmpdir(), "loongcode-expand-"))
    try {
      writeFileSync(join(dir, "notes.md"), "# Notes\nthe payload")
      const expanded = expandFileReferences("review @notes.md please", dir)
      expect(expanded).toContain(`<file path="${join(dir, "notes.md")}">`)
      expect(expanded).toContain("# Notes\nthe payload")
      expect(expanded).toContain("please")
      expect(expanded).not.toContain("@notes.md")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("leaves unresolved references untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "loongcode-expand-"))
    try {
      const expanded = expandFileReferences("email me @someone about @missing.txt", dir)
      expect(expanded).toContain("@someone")
      expect(expanded).toContain("@missing.txt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("truncates oversized files", () => {
    const dir = mkdtempSync(join(tmpdir(), "loongcode-expand-"))
    try {
      writeFileSync(join(dir, "big.txt"), "x".repeat(300 * 1024))
      const expanded = expandFileReferences("see @big.txt", dir)
      expect(expanded).toContain("file truncated at 200KB")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("expands a quoted reference whose path contains spaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "loongcode-expand-"))
    try {
      mkdirSync(join(dir, "docs"), { recursive: true })
      writeFileSync(join(dir, "docs", "my notes.md"), "the payload")
      const expanded = expandFileReferences('review @"docs/my notes.md" please', dir)
      expect(expanded).toContain(`<file path="${join(dir, "docs", "my notes.md")}">`)
      expect(expanded).toContain("the payload")
      expect(expanded).not.toContain('@"')
      expect(expanded).toContain("please")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an unquoted reference still stops at the first space", () => {
    const dir = mkdtempSync(join(tmpdir(), "loongcode-expand-"))
    try {
      writeFileSync(join(dir, "a.txt"), "A")
      writeFileSync(join(dir, "b.txt"), "B")
      // The bare form is a single token; the second file is a second reference.
      const expanded = expandFileReferences("@a.txt and @b.txt", dir)
      expect(expanded).toContain("<file")
      expect(expanded).toContain("and")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an unresolvable quoted reference is left exactly as written", () => {
    const dir = mkdtempSync(join(tmpdir(), "loongcode-expand-"))
    try {
      const text = 'see @"no such file.md" here'
      expect(expandFileReferences(text, dir)).toBe(text)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an email address is still never a reference", () => {
    const dir = mkdtempSync(join(tmpdir(), "loongcode-expand-"))
    try {
      const text = "write to someone@example.com about it"
      expect(expandFileReferences(text, dir)).toBe(text)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("how a reference resolves", () => {
  const cwd = "/workspace"

  test("a bare or quoted relative path resolves under the workspace", () => {
    expect(resolveReferencePath("src/a.ts", cwd)).toBe(join(cwd, "src/a.ts"))
    expect(resolveReferencePath("my file.md", cwd)).toBe(join(cwd, "my file.md"))
  })

  test("a POSIX absolute path is used as written", () => {
    expect(resolveReferencePath("/etc/hosts", cwd)).toBe("/etc/hosts")
  })

  test("a Windows drive-absolute path is used as written, with either slash", () => {
    expect(resolveReferencePath("C:\\src\\a.ts", cwd)).toBe("C:\\src\\a.ts")
    expect(resolveReferencePath("C:/src/a.ts", cwd)).toBe("C:/src/a.ts")
    expect(resolveReferencePath("D:\\Program Files\\a.txt", cwd)).toBe("D:\\Program Files\\a.txt")
  })

  test("a drive-relative path is not absolute, and a UNC path is not either", () => {
    // `C:foo` is drive-relative, and UNC support matches the tools' path
    // resolution, which does not treat `\\server\share` as absolute here.
    expect(resolveReferencePath("C:foo", cwd)).toBe(join(cwd, "C:foo"))
    expect(resolveReferencePath("\\\\server\\share\\a.ts", cwd)).toBe(join(cwd, "\\\\server\\share\\a.ts"))
  })
})

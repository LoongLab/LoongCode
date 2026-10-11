import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * The published package runs on Node, and nothing else may creep back in.
 *
 * Tests are exempt: they run on the Bun test runner by design. Every other
 * TypeScript file under a package's `src` directory is production code — it
 * reaches the published bundle — so it must be free of Bun runtime APIs. The
 * built bundle is checked separately (it only exists after a build); this guard
 * catches the regression at the source, where the fix is cheap.
 */

const ROOT = join(import.meta.dir, "../../..")
const PACKAGES = join(ROOT, "packages")

const FORBIDDEN: Array<[name: string, pattern: RegExp]> = [
  ["a Bun global", /\bBun\.[A-Za-z_$]/],
  ["a bun module import", /from\s+["']bun["':]/],
  ["a Bun-only import.meta property", /import\.meta\.(main|dir|file|path)\b/],
]

function productionSources(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "tests") continue
        walk(full)
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(full)
      }
    }
  }
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (pkg.isDirectory()) walk(join(PACKAGES, pkg.name, "src"))
  }
  return files
}

/** Whole-line comments may name Bun freely — they explain the migration. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith("*") || trimmed.startsWith("//") ||
    trimmed.startsWith("/*") || trimmed.startsWith("*/")
}

describe("runtime independence", () => {
  test("no production source uses a Bun runtime API", () => {
    const offenders: string[] = []
    for (const file of productionSources()) {
      const lines = readFileSync(file, "utf-8").split("\n")
      lines.forEach((line, index) => {
        if (isCommentLine(line)) return
        for (const [what, pattern] of FORBIDDEN) {
          if (pattern.test(line)) {
            offenders.push(`${relative(ROOT, file)}:${index + 1} uses ${what}: ${line.trim()}`)
          }
        }
      })
    }
    expect(offenders).toEqual([])
  })

  test("the scan covers the whole workspace", () => {
    // A guard that silently scans nothing would pass forever.
    expect(productionSources().length).toBeGreaterThan(60)
  })

  test("the build produces a Node program", () => {
    const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"))
    const build = root.scripts["build:cli"] as string
    expect(build).toContain("--target=node")
    expect(build).toContain("#!/usr/bin/env node")
    expect(build).not.toContain("target=bun")
  })

  test("the published package declares the Node version it needs", () => {
    const cli = JSON.parse(readFileSync(join(PACKAGES, "cli/package.json"), "utf-8"))
    expect(cli.engines.node).toBe(">=22.0.0")
  })

  test("the published package needs no runtime dependencies", () => {
    // The bundle inlines everything, so an install must not fetch packages.
    // If a future change externalises something, this fails and the dependency
    // belongs back in `dependencies` (and the assertion updated).
    const cli = JSON.parse(readFileSync(join(PACKAGES, "cli/package.json"), "utf-8"))
    expect(cli.dependencies).toBeUndefined()
  })

  const BUNDLE = join(PACKAGES, "cli/dist/loongcode.js")

  // Only meaningful once a build has run; CI builds before testing.
  test.skipIf(!existsSync(BUNDLE))("the built bundle imports nothing but Node builtins", () => {
    const source = readFileSync(BUNDLE, "utf-8")
    const specifiers = [...source.matchAll(/from\s*["']([^"']+)["']/g)]
      .map(match => match[1]!)
      // A module specifier, as opposed to a minified string that merely looks
      // like one (`from",label:"` inside a string literal).
      .filter(specifier => /^[a-zA-Z@][\w@/.-]*$/.test(specifier))
    const nonBuiltin = [...new Set(specifiers)].filter(
      specifier => !specifier.startsWith("node:") && !NODE_BUILTINS.has(specifier),
    )
    expect(nonBuiltin).toEqual([])
  })
})

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "dns", "events", "fs", "http",
  "https", "module", "net", "os", "path", "perf_hooks", "process", "readline",
  "stream", "string_decoder", "timers", "tty", "url", "util", "v8", "vm",
  "worker_threads", "zlib",
])

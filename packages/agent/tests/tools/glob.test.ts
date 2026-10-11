import { describe, expect, test } from "bun:test"
import { matchGlob } from "../../src/tools/glob"

/**
 * The table is the behaviour `Bun.Glob.match` was measured to have before the
 * Node migration — every row was run against Bun and copied here, so a future
 * change to the matcher that alters observable behaviour fails loudly.
 */
const MEASURED: Array<[pattern: string, path: string, expected: boolean]> = [
  ["*.ts", "a.ts", true],
  ["*.ts", "pkg/a.ts", false],
  ["**/*.ts", "a.ts", true],
  ["**/*.ts", "pkg/a.ts", true],
  ["**/*.ts", "pkg/sub/a.ts", true],
  ["src/**/*.json", "src/x.json", true],
  ["src/**/*.json", "src/d/x.json", true],
  ["src/*.json", "src/d/x.json", false],
  ["?.ts", "a.ts", true],
  ["?.ts", "ab.ts", false],
  ["{a,b}.ts", "a.ts", true],
  ["{a,b}.ts", "b.ts", true],
  ["{a,b}.ts", "c.ts", false],
  ["[ab].ts", "a.ts", true],
  ["[ab].ts", "c.ts", false],
  ["a", "a.ts", false],
  ["a.ts", "a.ts", true],
  ["*.TS", "a.ts", false],
  ["./*.ts", "a.ts", false],
  ["**", "pkg/a.ts", true],
  ["**", "a.ts", true],
  ["pkg/**", "pkg/a.ts", true],
  ["pkg/**", "pkg/sub/a.ts", true],
  ["*.{ts,json}", "a.json", true],
  ["a.ts", "./a.ts", false],
]

describe("glob matching (find tool)", () => {
  for (const [pattern, path, expected] of MEASURED) {
    test(`${JSON.stringify(pattern)} against ${JSON.stringify(path)} → ${expected}`, () => {
      expect(matchGlob(pattern, path)).toBe(expected)
    })
  }

  // Not part of the measured table: standard glob behaviour the matcher also
  // implements, asserted so it cannot regress silently.
  test("character classes admit ranges and negation", () => {
    expect(matchGlob("file[0-9].txt", "file7.txt")).toBe(true)
    expect(matchGlob("file[0-9].txt", "filex.txt")).toBe(false)
    expect(matchGlob("file[!0-9].txt", "filex.txt")).toBe(true)
  })

  test("brace alternatives nest", () => {
    expect(matchGlob("{a,{b,c}}.ts", "c.ts")).toBe(true)
    expect(matchGlob("{a,{b,c}}.ts", "d.ts")).toBe(false)
  })

  test("regex metacharacters in the pattern match literally", () => {
    expect(matchGlob("a+b.ts", "a+b.ts")).toBe(true)
    expect(matchGlob("a+b.ts", "aab.ts")).toBe(false)
    expect(matchGlob("v1.0.ts", "v1x0.ts")).toBe(false)
  })

  test("an unclosed brace or bracket is a literal character", () => {
    expect(matchGlob("a{b.ts", "a{b.ts")).toBe(true)
    expect(matchGlob("a[b.ts", "a[b.ts")).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import { argumentPlaceholderFor, composerGhostText, type ArgumentPlaceholderCommand } from "./argument-placeholder"

const COMMANDS: ArgumentPlaceholderCommand[] = [
  { name: "name", argumentPlaceholder: "Name…" },
  { name: "import", argumentPlaceholder: "Path…" },
  { name: "model" },
  { name: "export" },
  { name: "help" },
]

function at(line: string, cursorCol = line.length) {
  return { lines: [line], cursorLine: 0, cursorCol }
}

describe("argumentPlaceholderFor", () => {
  test("bare /name shows Name…", () => {
    expect(argumentPlaceholderFor(at("/name"), COMMANDS)).toBe("Name…")
  })

  test("/name with a trailing space still shows Name…", () => {
    expect(argumentPlaceholderFor(at("/name "), COMMANDS)).toBe("Name…")
  })

  test("/name with several trailing spaces still shows Name…", () => {
    expect(argumentPlaceholderFor(at("/name   "), COMMANDS)).toBe("Name…")
  })

  test("/import shows Path…", () => {
    expect(argumentPlaceholderFor(at("/import"), COMMANDS)).toBe("Path…")
  })

  test("a real argument hides the ghost", () => {
    expect(argumentPlaceholderFor(at("/name X"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/name My project"), COMMANDS)).toBeUndefined()
  })

  test("cursor before the end hides the ghost", () => {
    expect(argumentPlaceholderFor(at("/name ", 0), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/name", 3), COMMANDS)).toBeUndefined()
  })

  test("multiline input hides the ghost", () => {
    expect(argumentPlaceholderFor({ lines: ["/name", ""], cursorLine: 1, cursorCol: 0 }, COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor({ lines: ["/name", "x"], cursorLine: 0, cursorCol: 5 }, COMMANDS)).toBeUndefined()
  })

  test("partial and malformed commands hide the ghost", () => {
    expect(argumentPlaceholderFor(at("/nam"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/namefoo"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/name/foo"), COMMANDS)).toBeUndefined()
  })

  test("unknown commands hide the ghost", () => {
    expect(argumentPlaceholderFor(at("/foo"), COMMANDS)).toBeUndefined()
  })

  test("commands without a placeholder hide the ghost", () => {
    expect(argumentPlaceholderFor(at("/model"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/export"), COMMANDS)).toBeUndefined()
    expect(argumentPlaceholderFor(at("/help"), COMMANDS)).toBeUndefined()
  })

  test("a bare slash with only whitespace hides the ghost", () => {
    expect(argumentPlaceholderFor(at("/   "), COMMANDS)).toBeUndefined()
  })
})

describe("composerGhostText", () => {
  const IDLE = "Type a message…"

  test("an empty input shows the idle placeholder", () => {
    expect(composerGhostText(at(""), COMMANDS, IDLE)).toBe(IDLE)
  })

  test("a command's argument ghost takes over once a command is typed", () => {
    expect(composerGhostText(at("/name"), COMMANDS, IDLE)).toBe("Name…")
  })

  test("real input shows neither ghost", () => {
    expect(composerGhostText(at("fix the bug"), COMMANDS, IDLE)).toBeUndefined()
  })

  test("a cursor away from the start of an empty line is not the idle case", () => {
    // The line is empty but the cursor is not at the start, so it is not the
    // untouched empty input.
    expect(composerGhostText({ lines: [""], cursorLine: 0, cursorCol: 0 }, COMMANDS, IDLE)).toBe(IDLE)
    expect(composerGhostText({ lines: ["", ""], cursorLine: 1, cursorCol: 0 }, COMMANDS, IDLE)).toBeUndefined()
  })

  test("no idle placeholder configured falls through to the command ghost", () => {
    expect(composerGhostText(at(""), COMMANDS, undefined)).toBeUndefined()
    expect(composerGhostText(at("/import"), COMMANDS, undefined)).toBe("Path…")
  })

  test("a slash with trailing whitespace is not empty, so it is not the idle case", () => {
    expect(composerGhostText(at("   "), COMMANDS, IDLE)).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMMANDS } from "../commands"
import { LoongCodeAutocomplete } from "./autocomplete"

/**
 * Slash-command filtering (E1).
 *
 * The provider matches a slash query case-insensitively against command names
 * and ranks exact → prefix → substring, preserving declaration order inside each
 * tier. The typed query is never executed or inserted: the completion always
 * carries the canonical command name.
 */

/** The production command source, exactly as the application wires it. */
const production = () => COMMANDS.map(command => ({ name: command.name, description: command.description }))
const provider = (workspace = process.cwd()): LoongCodeAutocomplete =>
  new LoongCodeAutocomplete(production, () => workspace)

/** A fixture surface whose declaration order is deliberately not rank order. */
const FIXTURE = [
  { name: "commit", description: "substring, declared first" }, // contains "it"
  { name: "iterate", description: "prefix" }, // begins with "it"
  { name: "it", description: "exact" }, // equals "it"
  { name: "unit", description: "substring, declared last" }, // contains "it"
]
const fixtureProvider = (): LoongCodeAutocomplete =>
  new LoongCodeAutocomplete(() => FIXTURE, () => process.cwd())

const labels = (suggestions: { items: Array<{ label: string }> } | null): string[] =>
  suggestions === null ? [] : suggestions.items.map(item => item.label)

describe("slash-command filtering", () => {
  test("case-insensitive exact match", async () => {
    const result = await provider().getSuggestions(["/HELP"], 0, 5)
    expect(labels(result)).toEqual(["/help"])
  })

  test("case-insensitive prefix match", async () => {
    const result = await provider().getSuggestions(["/MO"], 0, 3)
    expect(labels(result)).toEqual(["/model"])
  })

  test("case-insensitive substring match that is not a prefix", async () => {
    // "ode" appears inside "model" but does not begin it.
    const result = await provider().getSuggestions(["/ODE"], 0, 4)
    expect(labels(result)).toEqual(["/model"])
  })

  test("exact ranks ahead of prefix, which ranks ahead of other substrings", async () => {
    const result = await fixtureProvider().getSuggestions(["/it"], 0, 3)
    expect(labels(result)).toEqual(["/it", "/iterate", "/commit", "/unit"])
  })

  test("ranking is case-insensitive too", async () => {
    const result = await fixtureProvider().getSuggestions(["/IT"], 0, 3)
    expect(labels(result)).toEqual(["/it", "/iterate", "/commit", "/unit"])
  })

  test("declaration order is preserved within the substring tier", async () => {
    // `commit` is declared before `unit`, so it stays ahead despite both matching
    // only as substrings.
    const result = await fixtureProvider().getSuggestions(["/it"], 0, 3)
    expect(labels(result)).toEqual(["/it", "/iterate", "/commit", "/unit"])
  })

  test("empty query returns every command in declaration order", async () => {
    const result = await provider().getSuggestions(["/"], 0, 1)
    expect(labels(result)).toEqual(COMMANDS.map(command => `/${command.name}`))
  })

  test("empty query preserves declaration order for fixtures too", async () => {
    const result = await fixtureProvider().getSuggestions(["/"], 0, 1)
    expect(labels(result)).toEqual(FIXTURE.map(command => `/${command.name}`))
  })

  test("a no-match query returns an empty result without throwing", async () => {
    const result = await provider().getSuggestions(["/hh"], 0, 3)
    expect(result).not.toBeNull()
    expect(result!.items).toEqual([])
    // The prefix is retained so the editor can quote the query in its no-match row.
    expect(result!.prefix).toBe("/hh")
  })

  test("the completion carries the canonical command name, not the typed case", async () => {
    const result = await provider().getSuggestions(["/HELP"], 0, 5)
    expect(result!.items[0]!.value).toBe("/help ")
  })

  test("activation stays line-start-only", async () => {
    // A slash not at the start of the first line is ordinary text.
    expect(await provider().getSuggestions(["hello /mo"], 0, 9)).toBeNull()
    // No leading slash at all.
    expect(await provider().getSuggestions(["m"], 0, 1)).toBeNull()
    // First line only: a slash on a later line is not a command.
    expect(await provider().getSuggestions(["", "/m"], 1, 2)).toBeNull()
    // The cursor at column 0 leaves nothing to match.
    expect(await provider().getSuggestions(["/"], 0, 0)).toBeNull()
  })

  test("an argument position shows no command list", async () => {
    // Whitespace after the name means the argument is being typed, not the name.
    expect(await provider().getSuggestions(["/model "], 0, 7)).toBeNull()
    expect(await provider().getSuggestions(["/help x"], 0, 7)).toBeNull()
  })
})

describe("@ file completion is unchanged", () => {
  test("files still complete, and a miss stays silent (no command no-match)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "loongcode-ac-"))
    writeFileSync(join(workspace, "alpha.txt"), "x")

    const hit = await provider(workspace).getSuggestions(["@al"], 0, 3)
    expect(labels(hit)).toContain("@alpha.txt")

    // File completion never reports a slash-style no-match: a miss closes the menu.
    expect(await provider(workspace).getSuggestions(["@nope"], 0, 5)).toBeNull()
  })
})

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMMANDS } from "../commands"
import { LoongCodeAutocomplete } from "../input/autocomplete"
import { TuiHarness } from "./testing"

/**
 * Slash-command interaction (E2), driven through the real editor on the real
 * layout: input bytes go through the same dispatch a terminal would use, and the
 * assertions read the reconstructed screen rows.
 */

const ENTER = "\r"
const ESC = "\x1b"
const TAB = "\t"
const DOWN = "\x1b[B"
const BACKSPACE = "\x7f"

/** Let the provider's async request resolve and the editor re-render. */
const flush = async (): Promise<void> => {
  // Long enough to clear the attachment (`@`) completion debounce as well as the
  // immediate slash request.
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 2))
}

function mount(workspace = process.cwd()): TuiHarness {
  const h = new TuiHarness({ width: 100, height: 30 }).start()
  h.editor.setAutocompleteProvider(
    new LoongCodeAutocomplete(
      () => COMMANDS.map(command => ({ name: command.name, description: command.description })),
      () => workspace,
    ),
  )
  return h
}

const frame = (h: TuiHarness): string => h.screen().join("\n")
/** The row the menu marks as selected (`→`), or "" when the menu is closed. */
const selectedRow = (h: TuiHarness): string => h.screen().find(row => row.includes("→")) ?? ""

describe("slash-command suggestions", () => {
  test("a query with matches displays suggestions", async () => {
    const h = mount()
    h.feed("/")
    await flush()
    const shown = frame(h)
    expect(shown).toContain("/help")
    expect(shown).toContain("/model")
  })

  test("a case-insensitive substring query still matches", async () => {
    const h = mount()
    h.feed("/ODE")
    await flush()
    expect(frame(h)).toContain("/model")
    expect(selectedRow(h)).toContain("/model")
  })
})

describe("slash-command no-match", () => {
  test("a query without matches displays the explicit no-match message", async () => {
    const h = mount()
    h.feed("/zzz")
    await flush()
    expect(frame(h)).toContain('No matching commands "/zzz"')
    // The message is informational: the input is untouched.
    expect(h.editor.getText()).toBe("/zzz")
  })

  test("editing a no-match query into a valid query restores suggestions", async () => {
    const h = mount()
    h.feed("/zzz")
    await flush()
    expect(frame(h)).toContain("No matching commands")
    h.feed(BACKSPACE)
    h.feed(BACKSPACE)
    h.feed(BACKSPACE)
    await flush()
    const shown = frame(h)
    expect(shown).not.toContain("No matching commands")
    expect(shown).toContain("/help")
  })

  test("Escape dismisses the no-match interaction and preserves the input exactly", async () => {
    const h = mount()
    h.feed("/zzz")
    await flush()
    h.feed(ESC)
    await flush()
    expect(frame(h)).not.toContain("No matching commands")
    expect(h.editor.getText()).toBe("/zzz")
  })

  test("ordinary text never renders the no-match message", async () => {
    const plain = mount()
    plain.feed("hello")
    await flush()
    expect(frame(plain)).not.toContain("No matching commands")

    // A slash that is not at the start of the line is ordinary text too.
    const midLine = mount()
    midLine.feed("hello /mo")
    await flush()
    expect(frame(midLine)).not.toContain("No matching commands")
  })
})

describe("slash-command keys", () => {
  test("Tab accepts the selected completion without submitting", async () => {
    const h = mount()
    h.feed("/mo")
    await flush()
    h.feed(TAB)
    await flush()
    expect(h.editor.getText()).toBe("/model ")
    expect(h.submitted).toEqual([])
  })

  test("Enter applies the completion and submits it", async () => {
    const h = mount()
    h.feed("/he")
    await flush()
    h.feed(ENTER)
    await flush()
    expect(h.submitted.map(text => text.trim())).toEqual(["/help"])
  })

  test("Up/Down move the selection and editing resets it to the best match", async () => {
    const h = mount()
    h.feed("/")
    await flush()
    expect(selectedRow(h)).toContain("/help")

    h.feed(DOWN)
    await flush()
    expect(selectedRow(h)).toContain("/model")

    h.feed(DOWN)
    await flush()
    expect(selectedRow(h)).toContain("/new")

    // Typing narrows the query and re-selects the best match from scratch.
    h.feed("c")
    await flush()
    expect(selectedRow(h)).toContain("/compact")
    expect(frame(h)).toContain("/copy")
  })
})

describe("@ completion and argument state stay unchanged", () => {
  test("@ files still complete, and a miss shows no command no-match", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "loongcode-editor-ac-"))
    writeFileSync(join(workspace, "alpha.txt"), "x")

    const hit = mount(workspace)
    hit.feed("@al")
    await flush()
    expect(frame(hit)).toContain("@alpha.txt")

    const miss = mount(workspace)
    miss.feed("@nope")
    await flush()
    expect(frame(miss)).not.toContain("No matching commands")
  })

  test("production commands declare no argument hint or placeholder", async () => {
    for (const command of COMMANDS) {
      expect(command.argumentHint).toBeUndefined()
      expect(command.argumentPlaceholder).toBeUndefined()
    }

    // An argument position shows no menu and no ghost copy.
    const h = mount()
    h.feed("/model ")
    await flush()
    const shown = frame(h)
    expect(shown).not.toContain("No matching commands")
    expect(shown).not.toContain("Name…")
    expect(shown).not.toContain("Path…")
  })
})

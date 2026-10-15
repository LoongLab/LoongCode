import { afterEach, describe, expect, test } from "bun:test"
import { Markdown } from "@loongcode/tui"
import { assistantMessage } from "./components"
import { markdownTheme, setThemeColorDepth, setThemeScheme, themeScheme } from "./theme"

/**
 * Regression tests for the assistant-message renderer cache.
 *
 * The transcript is re-rendered in full on every frame; a stable `Markdown`
 * per message is what keeps those frames from re-parsing every message. These
 * tests assert the cache contract directly — the observable signal is the
 * identity of the returned `string[]`, which `Markdown` returns by reference
 * on a cache hit (`markdown.ts`) and rebuilds on a miss.
 */

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

const LONG = "The refresh now resets its **backoff** on success and keeps the pending promise across retries. "
	+ "This sentence exists to make the message wrap at a narrow width so reflow is observable."

const originalScheme = themeScheme()

afterEach(() => {
	// The scheme is module-global state; restore it so this file cannot affect others.
	setThemeScheme(originalScheme)
	setThemeColorDepth("256")
})

describe("assistant message renderer cache", () => {
	test("an unchanged message reuses its rendered output across frames", () => {
		const message = assistantMessage(LONG)
		const first = message.render(80)
		const second = message.render(80)
		// Same array by reference: the second frame hit the cache instead of
		// re-parsing the message.
		expect(second).toBe(first)
	})

	test("a width change reflows the message and is not served the other width's output", () => {
		const message = assistantMessage(LONG)
		const wide = message.render(80)
		const narrow = message.render(40)
		expect(narrow).not.toBe(wide)
		// The narrow render is genuinely narrower, so the markdown reflowed.
		for (const line of narrow) expect(strip(line).length).toBeLessThanOrEqual(40)
		// And the wide render is available again (recomputed, not stale).
		const wideAgain = message.render(80)
		expect(strip(wideAgain.join("\n"))).toEqual(strip(wide.join("\n")))
	})

	test("different messages never show one another's content", () => {
		const alpha = assistantMessage("ALPHA-UNIQUE-TOKEN")
		const beta = assistantMessage("BETA-UNIQUE-TOKEN")
		expect(strip(alpha.render(80).join("\n"))).toContain("ALPHA-UNIQUE-TOKEN")
		expect(strip(beta.render(80).join("\n"))).toContain("BETA-UNIQUE-TOKEN")
		expect(strip(alpha.render(80).join("\n"))).not.toContain("BETA-UNIQUE-TOKEN")
		expect(strip(beta.render(80).join("\n"))).not.toContain("ALPHA-UNIQUE-TOKEN")
	})

	test("invalidate() discards the cached output so the next render recomputes", () => {
		const message = assistantMessage(LONG)
		const first = message.render(80)
		message.invalidate()
		const second = message.render(80)
		// A miss returns a fresh array with the same content.
		expect(second).not.toBe(first)
		expect(strip(second.join("\n"))).toEqual(strip(first.join("\n")))
	})

	test("a scheme change recolors rather than serving the previous scheme's output", () => {
		setThemeScheme("dark")
		const message = assistantMessage("**Bold** and `code` and a [link](https://example.test).")
		const dark = message.render(80)
		setThemeScheme("light")
		const light = message.render(80)
		expect(light).not.toBe(dark)
		// The same text, rendered under a different palette: the escapes differ.
		expect(light.join("\n")).not.toEqual(dark.join("\n"))
	})

	test("an empty or whitespace-only message renders no rows", () => {
		expect(assistantMessage("").render(80)).toEqual([])
		expect(assistantMessage("   \n  ").render(80)).toEqual([])
	})
})

describe("in-place renderer updates (streaming contract)", () => {
	test("setText reflects new text, so one renderer can carry a growing message", () => {
		const renderer = new Markdown("first chunk", 0, 0, markdownTheme())
		const before = renderer.render(80)
		renderer.setText("second chunk, complete")
		const after = renderer.render(80)
		expect(after).not.toBe(before)
		expect(strip(after.join("\n"))).toContain("second chunk, complete")
		expect(strip(after.join("\n"))).not.toContain("first chunk")
	})
})

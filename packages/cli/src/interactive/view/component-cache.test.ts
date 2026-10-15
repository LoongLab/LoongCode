import { afterEach, describe, expect, test } from "bun:test"
import { ToolExecutionComponent, userMessage } from "./components"
import { setThemeColorDepth, setThemeScheme, themeScheme } from "./theme"

/**
 * Regression tests for the per-instance render memo on `userMessage` and
 * `ToolExecutionComponent`.
 *
 * The transcript is re-rendered in full on every frame, so a component whose
 * content, width, and theme are unchanged must reuse its last output. The
 * observable signal is the identity of the returned `string[]`: a memo hit
 * returns the same array, a miss rebuilds it.
 */

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")
const plain = (lines: readonly string[]): string => strip(lines.join("\n"))
const originalScheme = themeScheme()

afterEach(() => {
	setThemeScheme(originalScheme)
	setThemeColorDepth("256")
})

const PLAIN_RESULT = Array.from({ length: 10 }, (_, i) => `alpha-${i}`).join("\n")

function successTool(result = PLAIN_RESULT): ToolExecutionComponent {
	const tool = new ToolExecutionComponent("call-1", "bash", { command: "bun test" })
	tool.setResult(true, result, 25)
	return tool
}

describe("userMessage render memo", () => {
	test("an unchanged message reuses its rendered output across frames", () => {
		const message = userMessage("fix the token refresh bug in src/auth/session.ts")
		expect(message.render(80)).toBe(message.render(80))
	})

	test("different messages never show one another's content", () => {
		const a = userMessage("ALPHA-UNIQUE-TOKEN")
		const b = userMessage("BETA-UNIQUE-TOKEN")
		expect(plain(a.render(80))).toContain("ALPHA-UNIQUE-TOKEN")
		expect(plain(b.render(80))).toContain("BETA-UNIQUE-TOKEN")
		expect(plain(a.render(80))).not.toContain("BETA-UNIQUE-TOKEN")
		expect(plain(b.render(80))).not.toContain("ALPHA-UNIQUE-TOKEN")
	})

	test("a width change reflows and is not served the other width's output", () => {
		const message = userMessage("a fairly long task description that must wrap at a narrow width for the test to observe reflow")
		const wide = message.render(100)
		const narrow = message.render(40)
		expect(narrow).not.toBe(wide)
		for (const line of narrow) expect(strip(line).length).toBeLessThanOrEqual(40)
		expect(plain(message.render(100))).toEqual(plain(wide))
	})

	test("invalidate() discards the memo so the next render recomputes", () => {
		const message = userMessage("recompute me")
		const first = message.render(80)
		message.invalidate()
		const second = message.render(80)
		expect(second).not.toBe(first)
		expect(plain(second)).toEqual(plain(first))
	})

	test("a scheme change recolors rather than serving the previous palette", () => {
		setThemeScheme("dark")
		const message = userMessage("recolor me")
		const dark = message.render(80)
		setThemeScheme("light")
		const light = message.render(80)
		expect(light).not.toBe(dark)
		expect(light.join("\n")).not.toEqual(dark.join("\n"))
	})
})

describe("ToolExecutionComponent render memo", () => {
	test("an unchanged tool reuses its rendered output across frames", () => {
		const tool = successTool()
		expect(tool.render(80)).toBe(tool.render(80))
	})

	test("different tools never show one another's content", () => {
		const a = successTool("ALPHA-TOOL-OUTPUT")
		const b = successTool("BETA-TOOL-OUTPUT")
		expect(plain(a.render(80))).toContain("ALPHA-TOOL-OUTPUT")
		expect(plain(b.render(80))).toContain("BETA-TOOL-OUTPUT")
		expect(plain(a.render(80))).not.toContain("BETA-TOOL-OUTPUT")
		expect(plain(b.render(80))).not.toContain("ALPHA-TOOL-OUTPUT")
	})

	test("setResult invalidates: a late result is not hidden by the earlier render", () => {
		const tool = new ToolExecutionComponent("call-9", "bash", { command: "bun test" })
		// The running row sets the memo.
		expect(plain(tool.render(80))).toContain("bun")
		tool.setResult(true, "RESULT-AFTER-COMPLETION", 12)
		const lines = tool.render(80)
		expect(plain(lines)).toContain("RESULT-AFTER-COMPLETION")
		expect(plain(lines)).not.toContain("⠿") // the running glyph is gone
	})

	test("setProgress invalidates while running", () => {
		const tool = new ToolExecutionComponent("call-2", "bash", { command: "run" })
		expect(plain(tool.render(80))).not.toContain("progress-line-1")
		tool.setProgress("progress-line-1\nprogress-line-2")
		expect(plain(tool.render(80))).toContain("progress-line-1")
	})

	test("setInterrupted invalidates and changes the state glyph", () => {
		const tool = new ToolExecutionComponent("call-3", "bash", { command: "run" })
		const running = tool.render(80)
		expect(plain(running)).toContain("⠿")
		tool.setInterrupted()
		const interrupted = tool.render(80)
		expect(interrupted).not.toBe(running)
		expect(plain(interrupted)).toContain("⊘")
		expect(plain(interrupted)).not.toContain("⠿")
	})

	test("setExpanded invalidates and reveals the full result", () => {
		const tool = successTool()
		const collapsed = tool.render(80)
		const collapsedRows = collapsed.length
		tool.setExpanded(true)
		const expanded = tool.render(80)
		expect(expanded).not.toBe(collapsed)
		expect(expanded.length).toBeGreaterThan(collapsedRows)
		// The last result line only appears once the tool is expanded.
		expect(plain(collapsed)).not.toContain("alpha-9")
		expect(plain(expanded)).toContain("alpha-9")
		// Collapsing again returns to the preview, not the expanded cache.
		tool.setExpanded(false)
		expect(tool.render(80).length).toBe(collapsedRows)
	})

	test("invalidate() drops the memo and recomputes the same output", () => {
		const tool = successTool()
		const first = tool.render(80)
		tool.invalidate()
		const second = tool.render(80)
		expect(second).not.toBe(first)
		expect(plain(second)).toEqual(plain(first))
	})

	test("a width change reflows and is not served the other width's output", () => {
		const tool = successTool()
		const wide = tool.render(100)
		const narrow = tool.render(40)
		expect(narrow).not.toBe(wide)
		for (const line of narrow) expect(strip(line).length).toBeLessThanOrEqual(40)
	})

	test("a scheme change recolors rather than serving the previous palette", () => {
		setThemeScheme("dark")
		const tool = successTool()
		const dark = tool.render(80)
		setThemeScheme("light")
		const light = tool.render(80)
		expect(light).not.toBe(dark)
		expect(light.join("\n")).not.toEqual(dark.join("\n"))
	})
})

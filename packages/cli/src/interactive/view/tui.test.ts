import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@loongcode/agent"
import { IterationBlock, ToolExecutionComponent, replayMessage, toolArgumentSummary, userMessage } from "./components"

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

function render(component: { render(width: number): string[] }): string {
	return strip(component.render(100).join("\n"))
}

describe("TUI component mapping (Masthead)", () => {
	test("a tool row carries the state glyph, name, arguments and duration", () => {
		const component = new ToolExecutionComponent("call_1", "bash", { command: "bun test" })
		const running = render(component)
		expect(running).toContain("⠿")
		expect(running).toContain("bash")
		expect(running).toContain("bun test")

		component.setResult(true, "3 pass\n0 fail\nRan 3 tests\ndone in 12ms", 1240)
		const done = render(component)
		expect(done).toContain("✓")
		expect(done).toContain("1.2s")
		expect(done).toContain("3 pass")
		expect(done).toContain("… 1 more line · ctrl+o")
		expect(done).not.toContain("done in 12ms")
	})

	test("each state is distinguishable by its own glyph, with no state word", () => {
		const running = new ToolExecutionComponent("c1", "bash", { command: "sleep 1" })
		expect(render(running)).toContain("⠿")

		const ok = new ToolExecutionComponent("c2", "read", { filePath: "a.ts" })
		ok.setResult(true, "1: ok")
		const okText = render(ok)
		expect(okText).toContain("✓")
		expect(okText).not.toContain("⠿")

		const bad = new ToolExecutionComponent("c3", "read", { filePath: "missing.ts" })
		bad.setResult(false, "File not found: missing.ts")
		const badText = render(bad)
		expect(badText).toContain("✗")
		expect(badText).toContain("File not found")

		const stopped = new ToolExecutionComponent("c4", "bash", { command: "sleep 100" })
		stopped.setInterrupted()
		expect(render(stopped)).toContain("⊘")
		// No state word is printed beside any glyph.
		for (const text of [okText, badText]) {
			expect(text).not.toMatch(/\b(done|failed|running|interrupted)\b/)
		}
	})

	test("a diff reports a truthful +/− metric and shows changed lines when collapsed", () => {
		const component = new ToolExecutionComponent("call_4", "edit", { filePath: "src/math.ts" })
		component.setResult(
			true,
			["Index: src/math.ts", "===", "--- src/math.ts", "+++ src/math.ts", "@@ -1,3 +1,3 @@", " a", "-  return a-b", "+  return a+b"].join("\n"),
		)
		const collapsed = render(component)
		expect(collapsed).toContain("-  return a-b")
		expect(collapsed).toContain("+  return a+b")
		expect(collapsed).toContain("+1 −1")
		expect(collapsed).not.toContain("Index: src/math.ts")

		component.setExpanded(true)
		const expanded = render(component)
		expect(expanded).toContain("@@ -1,3 +1,3 @@")
		expect(expanded).not.toContain("--- src/math.ts")
	})

	test("a read result keeps its line-number gutter and reports a line count", () => {
		const component = new ToolExecutionComponent("call_5", "read", { filePath: "src/a.ts" })
		component.setResult(true, "41: export class AuthModule {\n42:   constructor() {}")
		const text = render(component)
		expect(text).toContain("41 │ export class AuthModule {")
		expect(text).toContain("2 lines")
	})

	test("a read result's protocol envelope is not shown as the file's content", () => {
		// The tool wraps its content as `<path>…</path>`, `<type>file</type>`,
		// `<content>`. A collapsed preview that showed those instead of the
		// numbered content would hide the very output the user asked for.
		const component = new ToolExecutionComponent("call_6", "read", { filePath: "/tmp/ws/a.ts" })
		component.setResult(
			true,
			["<path>/tmp/ws/a.ts</path>", "<type>file</type>", "<content>", "", "1: first", "2: second", "3: third"].join("\n"),
		)
		const collapsed = render(component)
		expect(collapsed).toContain("1 │ first")
		expect(collapsed).not.toContain("<path>")
		expect(collapsed).not.toContain("<type>")
		// The metric counts the file's lines, not the envelope.
		expect(collapsed).toContain("3 lines")
	})

	test("tool argument summaries stay short", () => {
		const long = toolArgumentSummary("bash", { command: `echo ${"x".repeat(200)}` })
		expect(long.length).toBeLessThanOrEqual(81)
		expect(long.endsWith("…")).toBe(true)
		expect(toolArgumentSummary("read", { filePath: "src/a.ts" })).toBe("src/a.ts")
	})

	test("no rendered line exceeds the width it was given", () => {
		const read = new ToolExecutionComponent("c1", "read", { filePath: "src/a/really/deep/path.ts" })
		read.setResult(true, "12345: " + "x".repeat(180))
		for (const width of [1, 4, 12, 20, 40, 80]) {
			for (const line of [read.render(width), userMessage("a b c d e f g h").render(width)].flat()) {
				expect(strip(line).length).toBeLessThanOrEqual(width)
			}
		}
	})
})

describe("iteration margin", () => {
	test("carries the number at wide widths and drops it when narrow", () => {
		const block = new IterationBlock(3)
		block.addChild({ invalidate() {}, render: () => ["content"] })
		const wide = strip(block.render(80).join("\n"))
		expect(wide).toContain(" 3 content")
		const narrow = strip(block.render(40).join("\n"))
		expect(narrow).toContain("  content")
		expect(narrow).not.toContain("3")
	})

	test("a block without an iteration keeps a blank margin — no fabricated number", () => {
		const block = new IterationBlock(undefined)
		block.addChild({ invalidate() {}, render: () => ["content"] })
		const out = strip(block.render(80).join("\n"))
		expect(out).toContain("   content")
		expect(out).not.toMatch(/\d/)
	})

	test("a block wraps its already-styled children without miscounting them", () => {
		// Regression: the margin was once combined by re-measuring the child's
		// styled line, so the child's escape sequences were counted as columns and
		// the row collapsed to a fragment.
		const read = new ToolExecutionComponent("c1", "read", { filePath: "/tmp/ws/src/auth/session.ts" })
		read.setResult(true, Array.from({ length: 12 }, (_, i) => `  <line ${i}>`).join("\n"), 120)
		const block = new IterationBlock(1)
		block.addChild(read)
		for (const width of [40, 48, 60, 80, 120]) {
			const lines = block.render(width)
			for (const line of lines) expect(strip(line).length).toBe(width)
			// The two-column row survives: name, a clipped argument and the duration.
			expect(strip(lines[1]!)).toContain("read")
			expect(strip(lines[1]!)).toContain("120ms")
		}
	})

	test("the user's turn is marked by the chevron in the margin, never a number", () => {
		const text = strip(userMessage("hello there").render(80).join("\n"))
		expect(text).toContain(" ❯ hello there")
		expect(text).not.toMatch(/^\s*\d/m)
	})
})

describe("replay", () => {
	test("user, assistant, and correlated tool history render with glyph states", () => {
		const messages: SessionMessage[] = [
			{ id: "1", role: "user", content: "fix the bug", status: "complete", timestamp: 1 },
			{
				id: "2",
				role: "assistant",
				content: [
					{ type: "text", text: "Looking at the file." },
					{ type: "tool_call", toolCallId: "call_1", toolName: "read", input: { filePath: "a.ts" } },
				],
				status: "complete",
				timestamp: 2,
			},
			{
				id: "3",
				role: "tool",
				content: [{ toolCallId: "call_1", toolName: "read", output: { type: "text", text: "1: ok" } }],
				status: "complete",
				timestamp: 3,
			},
			{
				id: "4",
				role: "assistant",
				content: [{ type: "text", text: "**Fixed.**" }],
				status: "complete",
				timestamp: 4,
			},
		]

		const results = new Map([["call_1", { ok: true, result: "1: ok" }]])
		const components = messages.flatMap(message => replayMessage(message, results))
		const rendered = components.map(component => render(component as { render(width: number): string[] }))

		expect(components).toHaveLength(3)
		expect(rendered[0]).toContain("fix the bug")
		expect(rendered[1]).toContain("Looking at the file.")
		expect(rendered[1]).toContain("read")
		expect(rendered[1]).toContain("✓")
		expect(rendered[2]).toContain("Fixed.")
		// The replayed block carries the margin but never a fabricated number:
		// no line's margin columns hold a digit. (A `read` body's own line
		// numbers sit far to the right of the margin and are not iteration
		// numbers.)
		const margins = rendered[1]!.split("\n").filter(line => line.trim() !== "").map(line => line.slice(0, 3))
		for (const margin of margins) expect(margin).not.toMatch(/\d/)
	})

	test("replay renders failed tool history with the failure glyph", () => {
		const messages: SessionMessage[] = [
			{
				id: "1",
				role: "assistant",
				content: [{ type: "tool_call", toolCallId: "call_9", toolName: "bash", input: { command: "exit 1" } }],
				status: "complete",
				timestamp: 1,
			},
			{
				id: "2",
				role: "tool",
				content: [{ toolCallId: "call_9", toolName: "bash", output: { type: "tool_error", text: "boom" } }],
				status: "complete",
				timestamp: 2,
			},
		]

		const results = new Map([["call_9", { ok: false, result: "boom" }]])
		const components = messages.flatMap(message => replayMessage(message, results))
		const rendered = components.map(component => render(component as { render(width: number): string[] }))
		expect(rendered[0]).toContain("✗")
		expect(rendered[0]).toContain("boom")
	})
})

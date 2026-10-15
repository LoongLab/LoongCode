import { describe, expect, test } from "bun:test"
import { type Component } from "@loongcode/tui"
import { displayWidth } from "../../projection"
import { TuiHarness } from "./testing"
import { HelloHeader, KEYBOARD_HINTS, READY_LINE, WORDMARK, helloHeader, renderHelloHeader, transcriptHeight } from "./banner"

const LABEL = "/tmp/project"
const VERSION = "9.9.9"

const strip = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "")
const visibleWidth = (line: string): number => displayWidth(strip(line))

function headerLines(width: number, availableHeight: number): string[] {
	return renderHelloHeader({
		width,
		availableHeight,
		label: LABEL,
		hints: KEYBOARD_HINTS,
		version: VERSION,
		branch: "main",
		model: "probe-model",
	})
}

const text = (lines: readonly string[]): string => lines.map(strip).join("\n")

describe("masthead — composition", () => {
	test("the wordmark, version, rule, workspace and context are all present", () => {
		const rendered = text(headerLines(80, 30))
		expect(rendered).toContain(WORDMARK)
		expect(rendered).toContain(VERSION)
		expect(rendered).toContain(LABEL)
		expect(rendered).toContain("main")
		expect(rendered).toContain("probe-model")
		// The hairline rule spans the text column.
		expect(rendered).toContain("─".repeat(80 - 4))
	})

	test("the wordmark leads and the version is set against the right edge", () => {
		const first = strip(headerLines(80, 30)[1]!)
		expect(first.trimStart().startsWith(WORDMARK)).toBe(true)
		expect(first.trimEnd().endsWith(VERSION)).toBe(true)
		// Two columns of inset on each side.
		expect(first.startsWith(`  ${WORDMARK}`)).toBe(true)
		expect(first.endsWith(`${VERSION}  `)).toBe(true)
	})

	test("the opening guidance names the product state, the commands and the keys", () => {
		const rendered = text(headerLines(80, 30))
		expect(rendered).toContain(READY_LINE)
		for (const command of ["/help", "/model", "/session"]) expect(rendered).toContain(command)
		expect(rendered).toContain("esc interrupt")
	})

	test("the command descriptions share one column", () => {
		const lines = headerLines(80, 30).map(strip)
		const columns = ["all commands and keys", "switch the active model", "browse and resume sessions"]
			.map(description => lines.find(line => line.includes(description))!.indexOf(description))
		expect(new Set(columns).size).toBe(1)
	})

	test("an unresolved branch or model simply drops out of the context line", () => {
		const none = text([renderHelloHeader({ width: 80, availableHeight: 30, label: LABEL, hints: KEYBOARD_HINTS, version: VERSION })[3]!])
		expect(none).toContain(LABEL)
		expect(none).not.toContain("·")
	})
})

describe("masthead — width and height safety", () => {
	test("every rendered line is exactly the requested width", () => {
		const widths: number[] = []
		for (let width = 8; width <= 72; width++) widths.push(width)
		for (const width of [80, 100, 120, 160, 200]) widths.push(width)
		for (const width of widths) {
			for (const height of [1, 5, 8, 13, 30]) {
				for (const line of headerLines(width, height)) {
					expect(visibleWidth(line)).toBe(width)
				}
			}
		}
	})

	test("the workspace and context never collide — they yield, they do not overlap", () => {
		// Long path, narrow terminal: the context is clipped away, and at least a
		// separating column remains in every case the two share.
		for (const width of [24, 30, 36, 40, 48, 60, 80]) {
			const meta = strip(headerLines(width, 30)[3]!)
			expect(meta).toContain("/tmp/project")
			expect(visibleWidth(headerLines(width, 30)[3]!)).toBe(width)
			// No run of the path immediately followed by the context with no gap.
			expect(meta).not.toMatch(/project\S/)
		}
	})

	test("guidance wraps rather than being cut mid-word", () => {
		// The ready line is longer than a narrow content column; it wraps and
		// still states the whole sentence.
		const rendered = text(headerLines(40, 30))
		expect(rendered).toContain("Ready when you are.")
		expect(rendered).toContain("commands.")
	})
})

describe("masthead — layout and lifecycle", () => {
	test("the masthead is top-anchored, not vertically centred", () => {
		const lines = headerLines(80, 30)
		// It contributes exactly its composition, not a viewport-filling block.
		expect(lines.length).toBeLessThan(30)
		expect(strip(lines[0]!).trim()).toBe("")
		expect(strip(lines[1]!)).toContain(WORDMARK)
		expect(strip(lines[2]!)).toContain("─")
	})

	test("a short viewport drops guidance before the masthead", () => {
		const head = headerLines(80, 5).map(strip)
		expect(head).toHaveLength(4)
		expect(head.join("\n")).toContain(WORDMARK)
		expect(head.join("\n")).toContain("─")
		expect(head.join("\n")).not.toContain(READY_LINE)
	})

	test("a viewport shorter than the masthead keeps its first rows", () => {
		const lines = headerLines(80, 3).map(strip)
		expect(lines).toHaveLength(3)
		expect(lines.join("\n")).toContain(WORDMARK)
	})

	test("taller viewports do not pad the masthead with blank rows", () => {
		expect(headerLines(80, 30)).toEqual(headerLines(80, 20))
	})
})

describe("masthead — component", () => {
	test("HelloHeader renders the pure masthead for the live height", () => {
		const component = new HelloHeader({
			label: LABEL,
			hints: KEYBOARD_HINTS,
			version: VERSION,
			availableHeight: () => 30,
			branch: () => "main",
			model: () => "probe-model",
		})
		expect(component.render(80)).toEqual(headerLines(80, 30))
	})

	test("helloHeader honours the height provider", () => {
		let height = 30
		const component = helloHeader({
			label: LABEL,
			hints: KEYBOARD_HINTS,
			version: VERSION,
			availableHeight: () => height,
			branch: () => "main",
			model: () => "probe-model",
		})
		expect(component.render(80)).toEqual(headerLines(80, 30))
		height = 5
		expect(component.render(80)).toEqual(headerLines(80, 5))
	})

	test("branch and model are re-read on every render", () => {
		let branch = "main"
		let model = "probe-model"
		const component = helloHeader({
			label: LABEL,
			hints: KEYBOARD_HINTS,
			version: VERSION,
			availableHeight: () => 30,
			branch: () => branch,
			model: () => model,
		})
		expect(strip(component.render(80)[3]!)).toContain("main")
		branch = "release"
		model = "other-model"
		expect(strip(component.render(80)[3]!)).toContain("release")
	})

	test("a false visibility predicate contributes zero rows", () => {
		const component = helloHeader({
			label: LABEL,
			hints: KEYBOARD_HINTS,
			availableHeight: () => 30,
			visible: () => false,
		})
		expect(component.render(80)).toEqual([])
	})

	test("visibility is re-read on every render", () => {
		let visible = true
		const component = helloHeader({
			label: LABEL,
			hints: KEYBOARD_HINTS,
			version: VERSION,
			availableHeight: () => 30,
			branch: () => "main",
			model: () => "probe-model",
			visible: () => visible,
		})
		expect(component.render(80)).toEqual(headerLines(80, 30))
		visible = false
		expect(component.render(80)).toEqual([])
	})
})

describe("masthead — transcript integration", () => {
	const header: Component = helloHeader({
		label: LABEL,
		hints: KEYBOARD_HINTS,
		version: VERSION,
		availableHeight: () => transcriptHeight(24),
	})

	test("an empty transcript shows the masthead at the top and leaves the chrome intact", () => {
		const h = new TuiHarness({ width: 80, height: 24, chatLines: 0, headerComponent: header }).start()
		const rows = h.screen()
		expect(rows[1]).toContain(WORDMARK)
		expect(rows.join("\n")).toContain(READY_LINE)
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
		expect(rows.at(-3)).toMatch(/^─+$/)
	})

	test("the masthead coexists with the status area and never displaces it", () => {
		const h = new TuiHarness({ width: 80, height: 24, chatLines: 0, statusRows: 2, headerComponent: header }).start()
		const rows = h.screen()
		expect(rows.join("\n")).toContain(WORDMARK)
		expect(rows.join("\n")).toContain("STATUS-0")
		expect(rows.at(-1)).toBe("FOOTER-2")
	})
})

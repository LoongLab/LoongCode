import { describe, expect, test } from "bun:test"
import { getScrollViewBox, renderLayoutFrame } from "./layout.ts"
import { Container, type Component } from "./tui.ts"
import { ScrollView } from "./components/scroll-view.ts"
import { VStack } from "./components/v-stack.ts"
import { WindowedStack } from "./components/windowed-stack.ts"

/**
 * Regression tests for the scroll child's per-frame render count.
 *
 * A scroll node's content is rendered by the scroll-layout branch. Measuring the
 * scroll entry must reuse that same render rather than rendering the whole child
 * a second time — the duplication is invisible in the output but doubles the
 * cost of every frame, which is what made a long transcript lag.
 */

/** A component of a fixed number of rows that counts how often it renders. */
class CountingLines implements Component {
	renders = 0
	constructor(private readonly rows: number) {}
	invalidate(): void {}
	render(width: number): string[] {
		this.renders += 1
		return Array.from({ length: this.rows }, (_, i) => `row-${i}`.padEnd(Math.max(1, width)))
	}
}

describe("scroll child render count", () => {
	test("the scroll child is rendered exactly once per frame", () => {
		const child = new CountingLines(60)
		const scroll = new ScrollView(child, { follow: "end", primary: true, scrollbar: "auto" })
		const root = new VStack([{ component: scroll, grow: 1, shrink: 1 }])

		renderLayoutFrame(root, 40, 10, () => {})
		expect(child.renders).toBe(1)

		// A second frame renders once more (no cross-frame cache).
		renderLayoutFrame(root, 40, 10, () => {})
		expect(child.renders).toBe(2)
	})

	test("the natural content height and the pinned viewport are preserved", () => {
		const child = new CountingLines(60)
		const scroll = new ScrollView(child, { follow: "end", primary: true, scrollbar: "auto" })
		const root = new VStack([{ component: scroll, grow: 1, shrink: 1 }])

		const frame = renderLayoutFrame(root, 40, 10, () => {})
		// The whole child measured (60 rows), not just the viewport.
		expect(scroll.viewportHeight).toBe(10)
		const box = getScrollViewBox(frame, scroll)!
		expect(box.scrollContent!.rowCount).toBe(60)
		// follow: "end" pins the last viewport at the bottom of the content.
		expect(scroll.isFollowingEnd).toBe(true)
		expect(scroll.scrollTop).toBe(50)
		expect(frame.lines[0]).toContain("row-50")
		expect(frame.lines[9]).toContain("row-59")
	})

	test("the child is rendered once even with a reserved scrollbar column", () => {
		const child = new CountingLines(30)
		const scroll = new ScrollView(child, { follow: "end", primary: true, scrollbar: "always" })
		const root = new VStack([{ component: scroll, grow: 1, shrink: 1 }])

		renderLayoutFrame(root, 20, 8, () => {})
		expect(child.renders).toBe(1)
	})

	test("non-scroll components are still rendered once per frame", () => {
		const fixed = new CountingLines(2)
		const child = new CountingLines(40)
		const scroll = new ScrollView(child, { follow: "end", primary: true, scrollbar: "auto" })
		const root = new VStack([
			{ component: scroll, grow: 1, shrink: 1 },
			{ component: fixed, shrink: 0 },
		])

		const frame = renderLayoutFrame(root, 40, 12, () => {})
		expect(fixed.renders).toBe(1)
		expect(child.renders).toBe(1)
		// The fixed rows sit below the scroll viewport.
		expect(frame.lines[10]).toContain("row-0")
		expect(frame.lines[11]).toContain("row-1")
	})

	test("a plain container child is rendered once per frame", () => {
		let renders = 0
		const chat: Component = {
			invalidate() {},
			render(width: number) {
				renders += 1
				return [`x`.repeat(Math.max(1, width))]
			},
		}
		const transcript = new Container()
		transcript.addChild(chat)
		const scroll = new ScrollView(transcript, { follow: "end", primary: true, scrollbar: "auto" })
		const root = new VStack([{ component: scroll, grow: 1, shrink: 1 }])

		renderLayoutFrame(root, 40, 10, () => {})
		// The container itself is asked once, and its single child once.
		expect(renders).toBe(1)
	})
})

describe("Layout: a hidden footer row frees a conversation row", () => {
	/** A chrome row whose visibility can be flipped without being re-set. */
	class ToggleRow implements Component {
		shown = true
		invalidate(): void {}
		render(): string[] {
			return this.shown ? ["FOOTER"] : []
		}
	}

	test("retracting a bottom row gives its line to the scroll viewport", () => {
		const child = new CountingLines(200)
		const scroll = new ScrollView(child, { follow: "end", primary: true, scrollbar: "auto" })
		const usage = new ToggleRow()
		const root = new VStack([
			{ component: scroll, grow: 1, shrink: 1 },
			{ component: usage, shrink: 0 },
		])

		renderLayoutFrame(root, 40, 12, () => {})
		expect(scroll.viewportHeight).toBe(11)

		// The row hides on its own (a resize, in the application): the viewport
		// must take the freed line, with nothing else re-set.
		usage.shown = false
		renderLayoutFrame(root, 40, 12, () => {})
		expect(scroll.viewportHeight).toBe(12)
	})

	test("restoring the row takes the line back", () => {
		const child = new CountingLines(200)
		const scroll = new ScrollView(child, { follow: "end", primary: true, scrollbar: "auto" })
		const usage = new ToggleRow()
		const root = new VStack([
			{ component: scroll, grow: 1, shrink: 1 },
			{ component: usage, shrink: 0 },
		])
		usage.shown = false
		renderLayoutFrame(root, 40, 12, () => {})
		expect(scroll.viewportHeight).toBe(12)
		usage.shown = true
		renderLayoutFrame(root, 40, 12, () => {})
		expect(scroll.viewportHeight).toBe(11)
	})
})

/**
 * Integration of the windowed content path with the layout engine.
 *
 * A scroll whose child is a `WindowedStack` must be laid out from its logical
 * row count and painted from the visible window, producing exactly the rows the
 * dense path would, while rendering only the children the window overlaps.
 */

/** A stack of fixed-height leaves, each counting its renders, with a settable height. */
function windowedTranscript(counts: number[]): { stack: WindowedStack; leaves: CountingLeaf[] } {
	const stack = new WindowedStack()
	const leaves = counts.map((rows, index) => new CountingLeaf(rows, `c${index}`))
	for (const leaf of leaves) stack.addChild(leaf)
	return { stack, leaves }
}

class CountingLeaf implements Component {
	renders = 0
	constructor(
		public rows: number,
		private readonly tag: string,
	) {}
	invalidate(): void {}
	render(): string[] {
		this.renders += 1
		return Array.from({ length: this.rows }, (_, i) => `${this.tag}-${i}`)
	}
}

function scrollOf(component: Component, width: number, height: number) {
	const scroll = new ScrollView(component, { follow: "end", primary: true, scrollbar: "auto" })
	const root = new VStack([{ component: scroll, grow: 1, shrink: 1 }])
	const frame = renderLayoutFrame(root, width, height, () => {})
	return { scroll, frame }
}

describe("Layout: windowed content", () => {
	test("a windowed scroll paints the visible window and reports the full row count", () => {
		const { stack } = windowedTranscript(Array.from({ length: 50 }, () => 3))
		const { scroll, frame } = scrollOf(stack, 40, 10)
		expect(scroll.viewportHeight).toBe(10)
		// 50 children of 3 rows each.
		const box = getScrollViewBox(frame, scroll)!
		expect(box.scrollContent!.rowCount).toBe(150)
		expect(box.scrollContent!.lineAt(0)).toBe("c0-0")
		expect(box.scrollContent!.lineAt(149)).toBe("c49-2")
		// follow: "end" pins the last viewport at the bottom: rows 140..149.
		expect(scroll.scrollTop).toBe(140)
		expect(frame.lines[0]).toContain("c46-2")
		expect(frame.lines[9]).toContain("c49-2")
	})

	test("an ordinary frame renders only the children the window overlaps", () => {
		const { stack, leaves } = windowedTranscript(Array.from({ length: 300 }, () => 4))
		const { scroll } = scrollOf(stack, 40, 20)
		const measured = leaves.map(l => l.renders)
		// Many more frames: only the window's children render, and only once each.
		for (let i = 0; i < 5; i++) renderLayoutFrame(
			new VStack([{ component: scroll, grow: 1, shrink: 1 }]),
			40, 20, () => {},
		)
		const touched = leaves.filter((l, i) => l.renders > measured[i])
		// A 20-row window over 4-row children covers at most 6 children.
		expect(touched.length).toBeLessThanOrEqual(6)
		expect(touched.length).toBeGreaterThan(0)
		// Never anything close to the whole transcript.
		expect(touched.length).toBeLessThan(leaves.length / 10)
	})

	test("the windowed frame matches a dense container row for row", () => {
		const widths = [40, 60]
		for (const width of widths) {
			const spec = Array.from({ length: 30 }, (_, i) => i % 3 + 1)
			const dense = new Container()
			for (let i = 0; i < spec.length; i++) dense.addChild(new CountingLeaf(spec[i]!, `d${i}`))
			const { frame: denseFrame } = scrollOf(dense, width, 12)

			const wstack = new WindowedStack()
			for (let i = 0; i < spec.length; i++) wstack.addChild(new CountingLeaf(spec[i]!, `d${i}`))
			const { frame: windowedFrame } = scrollOf(wstack, width, 12)
			expect(windowedFrame.lines).toEqual(denseFrame.lines)
		}
	})

	test("a height change above the viewport keeps the absolute scroll offset", () => {
		const { stack, leaves } = windowedTranscript(Array.from({ length: 20 }, () => 3))
		const { scroll } = scrollOf(stack, 40, 10)
		// Scroll up to a fixed absolute offset.
		scroll.scrollTo(10)
		renderLayoutFrame(new VStack([{ component: scroll, grow: 1, shrink: 1 }]), 40, 10, () => {})
		expect(scroll.scrollTop).toBe(10)
		expect(scroll.isFollowingEnd).toBe(false)
		// Grow a child above the viewport.
		leaves[0]!.rows = 10
		stack.invalidateChild(leaves[0]!)
		renderLayoutFrame(new VStack([{ component: scroll, grow: 1, shrink: 1 }]), 40, 10, () => {})
		// The absolute offset is unchanged (no content anchoring), so the content
		// under it moved by the delta — the preserved behaviour.
		expect(scroll.scrollTop).toBe(10)
		expect(scroll.isFollowingEnd).toBe(false)
	})

	test("growing the content keeps follow-end pinned to the bottom", () => {
		const { stack } = windowedTranscript(Array.from({ length: 40 }, () => 5))
		const { scroll, frame } = scrollOf(stack, 40, 10)
		expect(scroll.isFollowingEnd).toBe(true)
		expect(frame.lines[9]).toContain("c39-4")
	})

	test("a width change reflows: the row count follows the new height", () => {
		const leaf: Component = {
			invalidate() {},
			render(w: number) {
				return Array.from({ length: w > 30 ? 2 : 6 }, (_, i) => `w${i}`)
			},
		}
		const stack = new WindowedStack()
		stack.addChild(leaf)
		const { scroll } = scrollOf(stack, 40, 8)
		const box = getScrollViewBox(renderLayoutFrame(new VStack([{ component: scroll, grow: 1, shrink: 1 }]), 40, 8, () => {}), scroll)!
		expect(box.scrollContent!.rowCount).toBe(2)
		const narrow = renderLayoutFrame(new VStack([{ component: scroll, grow: 1, shrink: 1 }]), 20, 8, () => {})
		expect(getScrollViewBox(narrow, scroll)!.scrollContent!.rowCount).toBe(6)
	})
})

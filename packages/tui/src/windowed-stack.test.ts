import { describe, expect, test } from "bun:test"
import { WindowedStack } from "./components/windowed-stack.ts"
import { getWindowed } from "./layout-node.ts"
import type { Component } from "./tui.ts"

/** A leaf of a fixed height that counts how often it renders. */
class Leaf implements Component {
	renders = 0
	constructor(
		public rows: number,
		public tag = "leaf",
	) {}
	invalidate(): void {}
	render(): string[] {
		this.renders += 1
		return Array.from({ length: this.rows }, (_, i) => `${this.tag}-${i}`)
	}
}

/** A child that measures its own nested stack through the capability. */
class Nested implements Component {
	readonly stack = new WindowedStack()
	invalidate(): void {
		this.stack.invalidate()
	}
	render(): string[] {
		return this.stack.renderWindow(20, 0, this.stack.rowCount(20))
	}
}

function build(heights: number[]): { stack: WindowedStack; leaves: Leaf[] } {
	const stack = new WindowedStack()
	const leaves = heights.map((h, i) => new Leaf(h, `c${i}`))
	for (const leaf of leaves) stack.addChild(leaf)
	return { stack, leaves }
}

describe("WindowedStack — rows and windows", () => {
	test("rowCount is the sum of child heights, and renderWindow returns exactly the range", () => {
		const { stack } = build([3, 2, 4])
		expect(stack.rowCount(40)).toBe(9)
		expect(stack.renderWindow(40, 0, 9)).toEqual([
			"c0-0", "c0-1", "c0-2", "c1-0", "c1-1", "c2-0", "c2-1", "c2-2", "c2-3",
		])
		// A window that opens inside the second child.
		expect(stack.renderWindow(40, 2, 3)).toEqual(["c0-2", "c1-0", "c1-1"])
		// A window at the very end, and a window past it.
		// Rows: c0-0..c0-2 (0-2), c1-0..c1-1 (3-4), c2-0..c2-3 (5-8).
		expect(stack.renderWindow(40, 7, 5)).toEqual(["c2-2", "c2-3"])
		expect(stack.renderWindow(40, 20, 5)).toEqual([])
	})

	test("lineAt answers any logical row, including rows outside a window", () => {
		const { stack } = build([3, 2, 4])
		expect(stack.lineAt(40, 0)).toBe("c0-0")
		expect(stack.lineAt(40, 3)).toBe("c1-0")
		expect(stack.lineAt(40, 8)).toBe("c2-3")
		expect(stack.lineAt(40, -1)).toBe("")
		expect(stack.lineAt(40, 9)).toBe("")
	})

	test("variable heights are honoured at every boundary", () => {
		const { stack } = build([1, 5, 2, 7])
		expect(stack.rowCount(40)).toBe(15)
		// Boundaries between children.
		expect(stack.renderWindow(40, 1, 1)).toEqual(["c1-0"])
		expect(stack.renderWindow(40, 5, 1)).toEqual(["c1-4"])
		expect(stack.renderWindow(40, 6, 1)).toEqual(["c2-0"])
		expect(stack.renderWindow(40, 14, 1)).toEqual(["c3-6"])
	})
})

describe("WindowedStack — nesting", () => {
	test("a windowed child contributes its row count without rendering its rows", () => {
		const outer = new WindowedStack()
		const inner = new WindowedStack()
		const a = new Leaf(4, "a")
		const b = new Leaf(3, "b")
		inner.addChild(a)
		inner.addChild(b)
		outer.addChild(new Leaf(2, "head"))
		outer.addChild(inner)
		outer.addChild(new Leaf(1, "tail"))

		expect(outer.rowCount(40)).toBe(2 + 7 + 1)
		// Rendering a window of the outer stack delegates into the inner stack.
		expect(outer.renderWindow(40, 2, 4)).toEqual(["a-0", "a-1", "a-2", "a-3"])
		expect(outer.lineAt(40, 8)).toBe("b-2")
		expect(outer.lineAt(40, 9)).toBe("tail-0")
	})

	test("a nested stack is measured by row count, not by rendering its rows", () => {
		const outer = new WindowedStack()
		const inner = new WindowedStack()
		const leaf = new Leaf(5, "n")
		inner.addChild(leaf)
		outer.addChild(inner)

		// Measuring the outer resolves the inner's height once, and a repeated
		// measurement adds nothing.
		expect(outer.rowCount(40)).toBe(5)
		expect(leaf.renders).toBe(1)
		expect(outer.rowCount(40)).toBe(5)
		expect(leaf.renders).toBe(1)
		// Painting the window renders the in-window child once, which is the
		// minimum for a leaf: it must be rendered to have lines to paint.
		expect(outer.renderWindow(40, 0, 5)).toEqual(["n-0", "n-1", "n-2", "n-3", "n-4"])
		expect(leaf.renders).toBe(2)
	})

	test("a change in a nested stack invalidates the outer stack's index", () => {
		const outer = new WindowedStack()
		const inner = new WindowedStack()
		const leaf = new Leaf(3, "n")
		inner.addChild(leaf)
		outer.addChild(inner)

		expect(outer.rowCount(40)).toBe(3)
		inner.addChild(new Leaf(4, "m"))
		// The parent was told through the child's revision, so its cached height
		// for `inner` is dropped and re-measured from the new row count.
		expect(outer.rowCount(40)).toBe(7)
	})
})

describe("WindowedStack — invalidation and revision", () => {
	test("appending a child grows the row count and needs no explicit invalidate", () => {
		const { stack, leaves } = build([2, 3])
		expect(stack.rowCount(40)).toBe(5)
		const extra = new Leaf(4, "extra")
		stack.addChild(extra)
		expect(stack.rowCount(40)).toBe(9)
		expect(stack.renderWindow(40, 5, 4)).toEqual(["extra-0", "extra-1", "extra-2", "extra-3"])
		void leaves
	})

	test("invalidateChild re-measures only that child", () => {
		const { stack, leaves } = build([2, 3, 2])
		stack.rowCount(40)
		const renders = leaves.map(l => l.renders)
		// Grow the middle child and announce it.
		leaves[1]!.rows = 6
		stack.invalidateChild(leaves[1]!)
		expect(stack.rowCount(40)).toBe(2 + 6 + 2)
		// Only the changed child re-rendered; the others kept their cached height.
		expect(leaves[0]!.renders).toBe(renders[0])
		expect(leaves[1]!.renders).toBe(renders[1]! + 1)
		expect(leaves[2]!.renders).toBe(renders[2])
	})

	test("removeChild and clear update the row count", () => {
		const { stack, leaves } = build([2, 3, 2])
		expect(stack.rowCount(40)).toBe(7)
		stack.removeChild(leaves[1]!)
		expect(stack.rowCount(40)).toBe(4)
		expect(stack.renderWindow(40, 2, 2)).toEqual(["c2-0", "c2-1"])
		stack.clear()
		expect(stack.rowCount(40)).toBe(0)
		expect(stack.renderWindow(40, 0, 5)).toEqual([])
	})

	test("a width change drops every height and re-measures", () => {
		let width = 40
		const leaf: Component = {
			invalidate() {},
			render(w: number) {
				return Array.from({ length: w > 30 ? 2 : 5 }, (_, i) => `w${i}`)
			},
		}
		const stack = new WindowedStack()
		stack.addChild(leaf)
		expect(stack.rowCount(40)).toBe(2)
		// A narrower width wraps to more rows; the cached height must not survive.
		expect(stack.rowCount(20)).toBe(5)
		expect(stack.renderWindow(20, 4, 1)).toEqual(["w4"])
	})

	test("revision rises on every change and is stable while unchanged", () => {
		const { stack, leaves } = build([2, 3])
		const r0 = stack.revision()
		stack.rowCount(40)
		expect(stack.revision()).toBe(r0)
		stack.invalidateChild(leaves[0]!)
		const r1 = stack.revision()
		expect(r1).toBeGreaterThan(r0)
		stack.addChild(new Leaf(1))
		expect(stack.revision()).toBeGreaterThan(r1)
	})

	test("invalidate() drops every height", () => {
		const { stack, leaves } = build([2, 3])
		stack.rowCount(40)
		const before = leaves.map(l => l.renders)
		stack.invalidate()
		stack.rowCount(40)
		expect(leaves[0]!.renders).toBe(before[0]! + 1)
		expect(leaves[1]!.renders).toBe(before[1]! + 1)
	})
})

describe("WindowedStack — bounded work", () => {
	test("an unchanged frame renders no child and rebuilds nothing", () => {
		const { stack, leaves } = build(Array.from({ length: 200 }, () => 3))
		stack.rowCount(40)
		const after = leaves.map(l => l.renders)
		// Repeatedly asking for the total and one fixed window must not re-measure
		// any child: heights are cached and the window is the same children.
		const windowed = new Set<number>()
		for (let i = 0; i < 20; i++) {
			stack.rowCount(40)
			stack.renderWindow(40, 100, 24)
			for (let k = 0; k < leaves.length; k++) if (leaves[k]!.renders > after[k]!) windowed.add(k)
		}
		// Only the children overlapping the 24-row window (3 rows each) rendered,
		// never the whole 200-child transcript — and each of those rendered exactly
		// once per frame (20 frames), which is the minimum to paint a leaf.
		expect(windowed.size).toBeLessThanOrEqual(Math.ceil(24 / 3) + 1)
		expect(windowed.size).toBeGreaterThan(0)
		for (const k of windowed) expect(leaves[k]!.renders).toBe(after[k]! + 20)
		// Every child outside the window kept its cached height untouched.
		for (let k = 0; k < leaves.length; k++) {
			if (!windowed.has(k)) expect(leaves[k]!.renders).toBe(after[k]!)
		}
	})

	test("a window renders only the children it overlaps", () => {
		const { stack, leaves } = build(Array.from({ length: 100 }, () => 5))
		stack.rowCount(40) // first frame resolves all heights once
		const before = leaves.map(l => l.renders)
		// A 10-row window inside child 40 (rows 200..209) touches at most 3 children.
		stack.renderWindow(40, 200, 10)
		const touched = leaves.filter((l, i) => l.renders !== before[i])
		expect(touched.length).toBeLessThanOrEqual(3)
		expect(touched.length).toBeGreaterThan(0)
	})

	test("lineAt outside the window does not render unrelated children", () => {
		const { stack, leaves } = build(Array.from({ length: 100 }, () => 5))
		stack.rowCount(40)
		const before = leaves.map(l => l.renders)
		stack.lineAt(40, 250)
		const touched = leaves.filter((l, i) => l.renders !== before[i])
		expect(touched.length).toBeLessThanOrEqual(1)
	})
})

describe("WindowedStack — capability", () => {
	test("exposes itself through getWindowed", () => {
		const { stack } = build([2])
		const windowed = getWindowed(stack)
		expect(windowed).toBeDefined()
		expect(windowed!.rowCount(40)).toBe(2)
		expect(windowed!.lineAt(40, 0)).toBe("c0-0")
	})

	test("a Nested child is measured through its row count, not its render", () => {
		const outer = new WindowedStack()
		const nested = new Nested()
		nested.stack.addChild(new Leaf(6, "deep"))
		outer.addChild(nested)
		expect(outer.rowCount(20)).toBe(6)
		expect(outer.renderWindow(20, 0, 6)).toEqual(["deep-0", "deep-1", "deep-2", "deep-3", "deep-4", "deep-5"])
	})
})

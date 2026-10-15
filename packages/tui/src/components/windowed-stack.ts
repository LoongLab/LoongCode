import { getWindowed, WINDOWED, type WindowedComponent, type WindowedContent } from "../layout-node.ts"
import { Container, type Component } from "../tui.ts"

/**
 * A vertical stack that can be rendered one window at a time.
 *
 * It keeps a resolved height per child and prefix sums of those heights, so the
 * total row count and the child containing any row are found without laying the
 * children out. Only the children overlapping a requested window are rendered.
 *
 * Heights are resolved lazily and cached as numbers. A child that is itself
 * windowed contributes its own `rowCount` — its rows are never rendered to
 * measure it — so nesting (a transcript holding a header and the chat stack)
 * stays bounded at every level.
 *
 * Invalidation is explicit, matching the rest of this codebase: a mutation
 * calls `invalidateChild` (or the container mutates through `addChild`,
 * `removeChild`, `clear`, which invalidate themselves), and a width change drops
 * every height. An unchanged ordinary frame rebuilds nothing and renders only
 * the visible window.
 */
export class WindowedStack extends Container implements WindowedComponent {
	/** Resolved height per child, or -1 while unresolved. Parallel to `children`. */
	private heights: number[] = []
	/** prefix[i] = sum of heights[0..i-1]; length is `children.length + 1` once built. */
	private prefix: number[] = [0]
	private indexValid = false
	private measuredWidth = Number.NaN
	/** Bumped on any change in this subtree; the parent is notified so its own index drops too. */
	private ownRevision = 0
	private parent?: WindowedStack

	override addChild(component: Component): void {
		super.addChild(component)
		if (component instanceof WindowedStack) component.parent = this
		this.heights.push(-1)
		this.touch()
	}

	override removeChild(component: Component): void {
		const index = this.children.indexOf(component)
		if (index === -1) return
		super.removeChild(component)
		this.heights.splice(index, 1)
		this.touch()
	}

	override clear(): void {
		super.clear()
		this.heights = []
		this.touch()
	}

	/**
	 * Marks one child's cached height as stale and drops the parent's index, so
	 * the next window computation re-measures exactly this child. The child's own
	 * cached render is dropped too: `invalidateChild` means "its output changed".
	 */
	invalidateChild(component: Component): void {
		const index = this.children.indexOf(component)
		if (index !== -1) this.heights[index] = -1
		component.invalidate?.()
		this.touch()
	}

	/** Marks every child's height stale (a width change, a theme change, a rebuild). */
	invalidate(): void {
		this.heights = new Array<number>(this.children.length).fill(-1)
		this.touch()
		// Match Container's contract: a full invalidate reaches the children too,
		// so a caller that invalidates the tree (e.g. a cell-size change) still
		// drops every cached render below this stack.
		for (const child of this.children) child.invalidate?.()
	}

	private touch(): void {
		this.ownRevision += 1
		this.indexValid = false
		this.parent?.onDescendantChanged(this)
	}

	/** A windowed child changed: drop its cached height here and keep propagating. */
	private onDescendantChanged(child: WindowedStack): void {
		const index = this.children.indexOf(child)
		if (index !== -1) this.heights[index] = -1
		this.ownRevision += 1
		this.indexValid = false
		this.parent?.onDescendantChanged(this)
	}

	private ensureIndex(width: number): void {
		if (width !== this.measuredWidth) {
			this.measuredWidth = width
			this.heights = new Array<number>(this.children.length).fill(-1)
			this.indexValid = false
		}
		if (this.heights.length !== this.children.length) {
			this.heights.length = this.children.length
			for (let i = 0; i < this.heights.length; i++) if (this.heights[i] === undefined) this.heights[i] = -1
			this.indexValid = false
		}
		if (this.indexValid) return
		for (let i = 0; i < this.children.length; i++) {
			if (this.heights[i]! < 0) this.heights[i] = this.measureChild(this.children[i]!, width)
		}
		if (this.prefix.length !== this.children.length + 1) {
			this.prefix = new Array<number>(this.children.length + 1)
		}
		this.prefix[0] = 0
		for (let i = 0; i < this.children.length; i++) {
			this.prefix[i + 1] = this.prefix[i]! + Math.max(0, this.heights[i]!)
		}
		this.indexValid = true
	}

	/** A child's height: its own row count when windowed, else its rendered line count. */
	private measureChild(child: Component, width: number): number {
		const windowed = getWindowed(child)
		if (windowed) return Math.max(0, windowed.rowCount(width))
		return Math.max(0, child.render(width).length)
	}

	/** The largest child index whose first row is at or above `row` (binary search). */
	private childAt(row: number): number {
		let low = 0
		let high = this.children.length
		while (low < high) {
			const middle = (low + high) >> 1
			if (this.prefix[middle]! <= row) low = middle + 1
			else high = middle
		}
		return low - 1
	}

	rowCount(width: number): number {
		this.ensureIndex(width)
		return this.prefix[this.children.length] ?? 0
	}

	renderWindow(width: number, start: number, count: number): string[] {
		this.ensureIndex(width)
		const total = this.prefix[this.children.length] ?? 0
		if (count <= 0 || total === 0) return []
		const begin = Math.max(0, Math.min(start, total))
		const end = Math.min(total, begin + count)
		if (end <= begin) return []
		const out: string[] = []
		let index = this.childAt(begin)
		// Rows of the first child before the window opens.
		let skip = begin - (this.prefix[index] ?? 0)
		while (index < this.children.length && out.length < end - begin) {
			const child = this.children[index]!
			const take = end - begin - out.length
			const windowed = getWindowed(child)
			const rows = windowed
				? windowed.renderWindow(width, skip, take)
				: sliceRows(child.render(width), skip, take)
			for (const row of rows) out.push(row)
			skip = 0
			index += 1
		}
		return out.length > end - begin ? out.slice(0, end - begin) : out
	}

	lineAt(width: number, row: number): string {
		this.ensureIndex(width)
		const total = this.prefix[this.children.length] ?? 0
		if (row < 0 || row >= total) return ""
		const index = this.childAt(row)
		const child = this.children[index]
		if (child === undefined) return ""
		const within = row - (this.prefix[index] ?? 0)
		const windowed = getWindowed(child)
		return windowed ? windowed.lineAt(width, within) : (child.render(width)[within] ?? "")
	}

	revision(): number {
		return this.ownRevision
	}

	[WINDOWED](): WindowedContent {
		return this
	}
}

/** Rows `[start, start + count)` of a rendered array, clipped by its length. */
function sliceRows(lines: readonly string[], start: number, count: number): readonly string[] {
	const begin = Math.max(0, Math.min(start, lines.length))
	const end = Math.min(lines.length, begin + count)
	return lines.slice(begin, end)
}

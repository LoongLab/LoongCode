import type { Component } from "./tui.ts";

export const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

export interface LayoutViewport {
	width: number;
	height: number;
}

export interface StackLayoutEntry {
	component: Component;
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

export interface StackLayoutNode {
	type: "vstack" | "hstack";
	entries: readonly StackLayoutEntry[];
	gap: number;
	align: "stretch" | "start" | "center" | "end";
}

export interface ScrollLayoutState {
	readonly scrollTop: number;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly viewportHeight: number;
	getContentWidth(width: number): number;
	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
}

export interface ScrollLayoutNode {
	type: "scroll";
	component: Component;
	state: ScrollLayoutState;
}

export type LayoutNode = StackLayoutNode | ScrollLayoutNode;

export interface LayoutComponent extends Component {
	[LAYOUT_NODE](): LayoutNode;
}

export function getLayoutNode(component: Component): LayoutNode | undefined {
	const candidate = component as Partial<LayoutComponent>;
	return typeof candidate[LAYOUT_NODE] === "function" ? candidate[LAYOUT_NODE]() : undefined;
}

/**
 * Capability symbol for content that can be rendered one window at a time.
 *
 * A scroll view whose child declares this is laid out from its logical row
 * count and the rows of the visible window, instead of from a full render of
 * every row. The layout engine renders only what the viewport can show, so a
 * transcript's cost is bounded by the window rather than by its length.
 *
 * Complexity contract for an implementation:
 * - `rowCount` and every accessor are pure for a given `width`; an unchanged
 *   width with no invalidation is cheap (no per-row work).
 * - `renderWindow` allocates only what the requested range needs.
 * - `lineAt` answers any logical row, including rows outside the window, so
 *   selection, copy, search, and prompt jumping keep working.
 * - `revision` is monotonic and changes whenever the rows or their heights do,
 *   so a consumer that caches derived data can tell when to rebuild.
 */
export const WINDOWED = Symbol.for("@earendil-works/pi-tui/windowed");

export interface WindowedContent {
	/** Total logical rows at `width`. */
	rowCount(width: number): number;
	/** Rows `[start, start + count)`, clipped to the content; bounded by `count`. */
	renderWindow(width: number, start: number, count: number): string[];
	/** One logical row; `""` when out of range. */
	lineAt(width: number, row: number): string;
	/** Monotonic content revision. */
	revision(): number;
}

export interface WindowedComponent extends Component {
	[WINDOWED](): WindowedContent;
}

export function getWindowed(component: Component): WindowedContent | undefined {
	const candidate = component as Partial<WindowedComponent>;
	return typeof candidate[WINDOWED] === "function" ? candidate[WINDOWED]() : undefined;
}

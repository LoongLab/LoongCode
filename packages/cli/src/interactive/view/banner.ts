import type { Component } from "@loongcode/tui"
import { displayWidth } from "../../projection"
import { LOONGCODE_VERSION } from "../../version"
import { truncateVisible, wrapBody } from "./components"
import { theme, type Style } from "./theme"

/**
 * The Masthead: LoongCode's empty-state identity.
 *
 * It is editorial rather than a splash screen: a left-aligned wordmark with the
 * version set against the right edge, a hairline rule, and a workspace line
 * carrying the branch and model. Below it sits the opening guidance — what the
 * agent is, the commands that exist, and the keys that matter. Nothing is
 * vertically centred; the masthead is a header, and the transcript grows beneath
 * it. It holds no lifecycle of its own, never blocks input, and scrolls away
 * with the transcript once a conversation exists.
 *
 * Composition follows the design reference: content is inset two columns, and
 * the rule spans exactly the text column. Every line is measured and padded to
 * the full width, because escape sequences are style, not columns — widths are
 * always taken on plain text and styling applied afterwards.
 */

/** The product wordmark shown in the masthead. */
export const WORDMARK = "LoongCode"

/** The opening line, stated once; the masthead is the empty-workspace state. */
export const READY_LINE = "Ready when you are. Describe a task, or type / for commands."

/** The always-visible keyboard hint. The full set lives behind `/help`. */
export const KEYBOARD_HINTS =
	"enter submit · alt+enter newline · esc interrupt · /help commands"

/** The startup commands worth surfacing, aligned by command column. */
const COMMANDS: ReadonlyArray<readonly [string, string]> = [
	["/help", "all commands and keys"],
	["/model", "switch the active model"],
	["/session", "browse and resume sessions"],
]

/** Command names are padded to this column so their descriptions line up. */
const COMMAND_WIDTH = 10

/** Rows owned by the fixed bottom chrome: composer (3) + two footer rows. */
const FIXED_CHROME_ROWS = 5

/**
 * Transcript rows available at idle: terminal rows minus the fixed bottom
 * chrome. The idle-height budget trimming is measured against.
 */
export function transcriptHeight(terminalRows: number): number {
	return Math.max(0, Math.floor(terminalRows) - FIXED_CHROME_ROWS)
}

/** Content is inset this many columns on both sides of the masthead. */
const EDGE = 2

/** A styled span of one line. Widths are always measured on `text`. */
interface Segment {
	readonly text: string
	readonly style: Style
}

/**
 * Renders one line: segments concatenated, then padded to exactly `width`.
 * Each segment is clipped to the room remaining, so no composition can ever
 * emit a line wider than the terminal however narrow it is.
 */
function renderSegments(width: number, segments: readonly Segment[]): string {
	let plainText = ""
	let out = ""
	for (const segment of segments) {
		const text = clip(segment.text, Math.max(0, width - displayWidth(plainText)))
		out += segment.style(text)
		plainText += text
	}
	return out + " ".repeat(Math.max(0, width - displayWidth(plainText)))
}

/** Clips plain text to `max` columns, marking the cut with a trailing `…`. */
function clip(text: string, max: number): string {
	if (max <= 0) return ""
	return truncateVisible(text, max)
}

/**
 * A line with `left` at the left margin and `right` set against the right
 * margin. The left wins: the right is clipped to what remains after at least
 * one separating column, and dropped entirely when the two cannot share a line.
 */
function spread(width: number, left: string, right: string, leftStyle: Style, rightStyle: Style): string {
	const room = Math.max(0, width - EDGE * 2)
	const l = clip(left, room)
	const budget = room - displayWidth(l)
	const r = budget >= 2 ? clip(right, budget - 1) : ""
	const gap = " ".repeat(Math.max(0, budget - displayWidth(r)))
	return renderSegments(width, [
		{ text: " ".repeat(EDGE), style: (t) => t },
		{ text: l, style: leftStyle },
		{ text: gap, style: (t) => t },
		{ text: r, style: rightStyle },
	])
}

/** The hairline rule spanning the text column. */
function rule(width: number): string {
	return renderSegments(width, [{ text: " ".repeat(EDGE) + "─".repeat(Math.max(0, width - EDGE * 2)), style: theme.structure }])
}

/** A blank line padded to the full width. */
function blank(width: number): string {
	return " ".repeat(Math.max(0, width))
}

/** An inset left-aligned block, wrapped so no guidance is silently cut. */
function inset(width: number, text: string, style: Style): string[] {
	const content = Math.max(1, width - EDGE * 2)
	return wrapBody(text, content).map(line =>
		renderSegments(width, [{ text: " ".repeat(EDGE), style: (t) => t }, { text: line, style }]),
	)
}

export interface HelloHeaderInput {
	readonly width: number
	/** Transcript viewport rows: terminal height minus the fixed bottom chrome. */
	readonly availableHeight: number
	/** Workspace path, or a resumed session id — whatever identifies the session. */
	readonly label: string
	/** The keyboard hint line, unwrapped. */
	readonly hints: string
	/** Product version, set against the masthead's right edge. */
	readonly version?: string
	/** Current git branch, when the workspace is a repository. */
	readonly branch?: string
	/** Active model identity. */
	readonly model?: string
}

/** The masthead block: wordmark, rule, and the workspace/branch/model line. */
function masthead(width: number, input: HelloHeaderInput): string[] {
	const version = input.version ?? LOONGCODE_VERSION
	const context = [input.branch, input.model].filter((v): v is string => v !== undefined && v.length > 0).join("  ·  ")
	return [
		blank(width),
		spread(width, WORDMARK, version, (t) => theme.accentBold(t), theme.faint),
		rule(width),
		spread(width, input.label, context, theme.secondary, theme.muted),
	]
}

/**
 * Renders the empty-state masthead plus the richest opening guidance that fits
 * the viewport. Each fallback drops one layer — the keyboard hints, then the
 * command list, then the spacing — while always keeping the masthead itself.
 */
export function renderHelloHeader(input: HelloHeaderInput): string[] {
	const width = Math.max(1, Math.floor(input.width))
	const height = Math.max(0, Math.floor(input.availableHeight))

	const head = masthead(width, input)
	const ready = inset(width, READY_LINE, theme.primary)
	const commands = COMMANDS.map(([command, description]) =>
		renderSegments(width, [
			{ text: " ".repeat(EDGE), style: (t) => t },
			{ text: command.padEnd(COMMAND_WIDTH), style: theme.accent },
			{ text: description, style: theme.faint },
		]),
	)
	const hintLines = inset(width, input.hints, theme.muted)

	const compositions: string[][] = [
		[...head, blank(width), ...ready, blank(width), ...commands, blank(width), ...hintLines],
		[...head, blank(width), ...ready, blank(width), ...commands],
		[...head, blank(width), ...ready],
		head,
	]
	for (const composition of compositions) {
		if (composition.length <= height) return composition
	}
	// Shorter than even the masthead: anchor it and clip from the bottom.
	return head.slice(0, Math.max(0, height))
}

/**
 * Width- and height-aware masthead component.
 *
 * `visible` is a live empty-state predicate re-read on every render; a false
 * predicate yields zero rows so the masthead is absent from the transcript
 * rather than scrolled out of view. Branch and model are functions because they
 * are resolved after the component is built and can change under a live session.
 */
export class HelloHeader implements Component {
	constructor(
		private readonly options: {
			label: string
			hints: string
			availableHeight: () => number
			version?: string
			branch?: () => string | undefined
			model?: () => string | undefined
			visible?: () => boolean
		},
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const visible = this.options.visible
		if (visible !== undefined && !visible()) return []
		return renderHelloHeader({
			width,
			availableHeight: this.options.availableHeight(),
			label: this.options.label,
			hints: this.options.hints,
			version: this.options.version,
			branch: this.options.branch?.(),
			model: this.options.model?.(),
		})
	}
}

/** Builds the interactive TUI's masthead. */
export function helloHeader(options: {
	label: string
	hints: string
	availableHeight: () => number
	version?: string
	branch?: () => string | undefined
	model?: () => string | undefined
	visible?: () => boolean
}): Component {
	return new HelloHeader(options)
}

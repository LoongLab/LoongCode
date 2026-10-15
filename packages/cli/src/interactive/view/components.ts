import { Markdown, type Component } from "@loongcode/tui"
import type { SessionMessage } from "@loongcode/agent"
import { ansi, markdownTheme, theme, themeScheme } from "./theme"
import { displayWidth, formatDuration } from "../../projection"

/**
 * LoongCode chat components in the Masthead design language.
 *
 * The transcript is a single editorial column with a numbered work-history
 * margin: an iteration is numbered to the left of its content, tools run within
 * that margin as a two-column row (identity and arguments against duration and
 * result), and the user's turn is marked with a chevron in the same margin.
 *
 * Widths are always measured on plain text and styling applied afterwards —
 * escape sequences are not columns. Every component lays its own lines out
 * inside `render(width)` because the framework's generic wrapper drops a line's
 * leading indentation when it wraps; here a continuation keeps its block's
 * indentation and no line exceeds the width it was given.
 */

/** Maximum result lines kept per tool component (expanded rendering caps
 *  here too, so pathological outputs cannot exhaust memory). */
const MAX_RESULT_LINES = 500

/** Body lines are indented under a tool's two-column row. */
const BODY_INDENT = 6

/** Width of the work-history margin: the iteration number. Below this the
 *  margin narrows and the number is dropped, keeping the content column read-
 *  able on a narrow terminal. */
const NARROW_MARGIN = 2
function marginWidth(width: number): number {
	return width >= 52 ? 3 : NARROW_MARGIN
}

type StyleFn = (text: string) => string
const plain: StyleFn = text => text

/** A styled span of one line. Widths are measured on `text`, never on output. */
interface Segment {
	readonly text: string
	readonly style: StyleFn
}

/** Fits text into `max` columns: whitespace is trimmed hard, content is marked. */
function fitSegment(text: string, max: number): string {
	if (/^ *$/.test(text)) return text.slice(0, max)
	return truncateVisible(text, max)
}

/**
 * Renders one line: segments concatenated, then padded to exactly `width`.
 * Each segment is clipped to the room remaining, so no composition can emit a
 * line wider than the width it was given.
 */
function styled(width: number, segments: readonly Segment[]): string {
	let plainText = ""
	let out = ""
	for (const segment of segments) {
		const text = fitSegment(segment.text, Math.max(0, width - displayWidth(plainText)))
		out += segment.style(text)
		plainText += text
	}
	return out + " ".repeat(Math.max(0, width - displayWidth(plainText)))
}

/** Truncates to `width` visible columns, marking the cut with a trailing `…`. */
export function truncateVisible(text: string, width: number): string {
	const w = Math.max(0, Math.floor(width))
	if (displayWidth(text) <= w) return text
	if (w <= 1) return "…".slice(0, w)
	let cut = ""
	let used = 0
	for (const ch of text) {
		const c = displayWidth(ch)
		if (used + c > w - 1) break
		cut += ch
		used += c
	}
	return `${cut}…`
}

/**
 * Greedy word-wrap that never lets a line exceed `width` and never silently
 * drops a character: a token wider than the line is hard-split.
 */
export function wrapBody(text: string, width: number): string[] {
	const w = Math.max(1, Math.floor(width))
	const out: string[] = []
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			out.push("")
			continue
		}
		let line = ""
		let lineW = 0
		for (const token of paragraph.split(/( +)/)) {
			if (token === "") continue
			const tw = displayWidth(token)
			if (lineW + tw <= w) {
				line += token
				lineW += tw
				continue
			}
			if (line.trim() !== "") {
				out.push(line.replace(/\s+$/, ""))
				line = ""
				lineW = 0
			}
			let rest = token.replace(/^ +/, "")
			while (displayWidth(rest) > w) {
				let cut = ""
				let cw = 0
				for (const ch of rest) {
					const c = displayWidth(ch)
					if (cw + c > w) break
					cut += ch
					cw += c
				}
				if (cut === "") cut = rest[0] ?? ""
				out.push(cut)
				rest = rest.slice(cut.length)
			}
			line = rest
			lineW = displayWidth(rest)
		}
		out.push(line.replace(/\s+$/, ""))
	}
	return out
}

/**
 * A per-instance memo of one component's rendered lines.
 *
 * The transcript is re-rendered in full on every frame — a keystroke, a streamed
 * delta, a scroll — so a component whose content, width, and theme are unchanged
 * must not lay itself out again. The cache is owned by the calling component (it
 * lives and dies with it; nothing is shared globally), and it keys on the
 * terminal width and the active theme scheme: a width change reflows the content,
 * and a scheme change — which only requests a frame and never invalidates the
 * tree — must not serve the previous palette's escape sequences.
 *
 * `invalidate` drops the memo for content changes the component cannot infer on
 * its own (a tool's state, a result, an expansion toggle).
 */
function renderMemo(compute: (width: number) => string[]): {
	render: (width: number) => string[]
	invalidate: () => void
} {
	let scheme = themeScheme()
	let width = Number.NaN
	let lines: string[] | undefined
	return {
		render(w: number): string[] {
			const current = themeScheme()
			if (lines === undefined || w !== width || current !== scheme) {
				scheme = current
				width = w
				lines = compute(w)
			}
			return lines
		},
		invalidate(): void {
			lines = undefined
		},
	}
}

/**
 * A submitted user task: the chevron sits in the work-history margin, so the
 * user's turn reads as the prompt that opened the history, never as one of the
 * numbered iterations. Wrapped continuation lines hold the same margin.
 *
 * The layout is memoized per instance: the text is fixed when the message is
 * built, so an unchanged message at an unchanged width is a cache hit on every
 * later frame rather than a re-wrap.
 */
export function userMessage(text: string): Component {
	const trimmed = text.trim()
	const memo = renderMemo(width => {
		const first = width >= 52 ? ` ${"❯"} ` : "❯ "
		const cont = " ".repeat(displayWidth(first))
		const cw = Math.max(1, width - displayWidth(first))
		const lines = wrapBody(trimmed, cw)
		const rendered = lines.map((line, index) =>
			styled(width, [
				{ text: index === 0 ? first : cont, style: index === 0 ? theme.accent : plain },
				{ text: line, style: text => ansi.bold(text) },
			]),
		)
		return [styled(width, [{ text: "", style: plain }]), ...rendered]
	})
	return {
		invalidate() {
			memo.invalidate()
		},
		render(width: number): string[] {
			return memo.render(width)
		},
	}
}

/**
 * An assistant response as Markdown, laid out at the iteration's content column.
 *
 * One `Markdown` renderer is held per message and reused across frames. The
 * transcript is re-rendered in full on every frame — a keystroke, a streamed
 * delta, a scroll — and `Markdown` caches its output by `(text, width)`, so a
 * stable instance turns every frame after the first into a cache hit. Building
 * a renderer inside `render()` (and a theme with it) defeated that cache and
 * re-parsed every assistant message on every frame, which is what made a long
 * conversation lag. The renderer is per message, so no two messages share a
 * cache and nothing lives beyond the component.
 */
export function assistantMessage(text: string): Component {
	const trimmed = text.trim()
	// The rendered rows carry the active scheme's colors. A scheme change only
	// requests a frame (`setThemeScheme`), it never invalidates the tree, so the
	// scheme is re-read here: without it a reused renderer would serve the
	// previous scheme's escape sequences until the text or width changed.
	let scheme = themeScheme()
	let markdown: Markdown | undefined
	return {
		invalidate() {
			markdown = undefined
		},
		render(width: number): string[] {
			if (trimmed.length === 0) return []
			const current = themeScheme()
			if (markdown === undefined || current !== scheme) {
				scheme = current
				markdown = new Markdown(trimmed, 0, 0, markdownTheme())
			}
			return markdown.render(width)
		},
	}
}

/** A muted system line (compaction, recovery, abort notices). */
export function notice(text: string): Component {
	return noticeLine(text, false)
}

/** An error notice — visually distinct from ordinary output. */
export function errorNotice(text: string): Component {
	return noticeLine(`error: ${text}`, true)
}

function noticeLine(text: string, isError: boolean): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			const style = isError ? theme.failure : theme.muted
			const lead = "  "
			const cw = Math.max(1, width - displayWidth(lead))
			return wrapBody(text, cw).map(line =>
				styled(width, [{ text: lead, style: plain }, { text: line, style }]),
			)
		},
	}
}

/**
 * One model iteration: the run's number in the work-history margin, with the
 * turn's assistant text and tool calls laid out at the content column.
 *
 * The number is the runtime's `iteration`, shown only while the run is live. On
 * replay the durable history holds none, so the margin is left blank rather than
 * fabricating a historical number.
 */
export class IterationBlock implements Component {
	private readonly children: Component[] = []

	constructor(private readonly iteration: number | undefined) {}

	addChild(component: Component): void {
		this.children.push(component)
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate?.()
	}

	render(width: number): string[] {
		const mw = marginWidth(width)
		const numbered = width >= 52 && this.iteration !== undefined
		const first = numbered ? `${String(this.iteration).padStart(mw - 1)} ` : " ".repeat(mw)
		const gutter = Math.max(mw, displayWidth(first))
		const cont = " ".repeat(gutter)
		if (width <= gutter) {
			return [styled(width, [{ text: truncateVisible(first.trimEnd(), width), style: plain }])]
		}
		const inner = width - gutter
		const lines: string[] = [styled(width, [{ text: "", style: plain }])]
		let firstContent = true
		for (const child of this.children) {
			for (const line of child.render(inner)) {
				// Child lines are already styled and sized to `inner`, so the margin
				// is prepended verbatim. Measuring them here would count their escape
				// sequences as columns and corrupt the row.
				const margin = firstContent ? (numbered ? theme.faint(first) : first) : cont
				lines.push(margin + line)
				firstContent = false
			}
		}
		return lines
	}
}

/** Summarizes a tool's input into a short, human-readable argument hint. */
export function toolArgumentSummary(name: string, input: Record<string, unknown>): string {
	const summarize = (value: unknown, max: number): string => {
		const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""
		const flat = text.replace(/\s+/g, " ").trim()
		return flat.length > max ? `${flat.slice(0, max)}…` : flat
	}
	switch (name) {
		case "bash":
			return summarize(input.command, 80)
		case "read":
		case "write":
		case "edit":
			return summarize(input.filePath, 60)
		case "grep":
		case "find":
			return summarize(input.pattern, 60)
		case "ls":
			return typeof input.path === "string" ? input.path : ""
		default:
			return summarize(input, 60)
	}
}

type ToolState = "running" | "success" | "error" | "interrupted"

/**
 * The leading symbol for each state. It is the state signal: color confirms it,
 * and the design carries no state word beside it, so the glyph is what makes
 * running, success, failure and interruption distinguishable without color.
 */
const STATE_GLYPH: Record<ToolState, string> = {
	running: "⠿",
	success: "✓",
	error: "✗",
	interrupted: "⊘",
}

function glyphStyle(state: ToolState, text: string): string {
	switch (state) {
		case "running":
			return theme.running(text)
		case "success":
			return theme.success(text)
		case "error":
			return theme.failure(text)
		case "interrupted":
			return theme.warning(text)
	}
}

/** How the result lines are shaped, decided from their own content. */
type ResultKind = "diff" | "read" | "grep" | "plain"

function classify(lines: readonly string[]): ResultKind {
	if (lines.length === 0) return "plain"
	if (lines.some(line => line.startsWith("@@ "))) return "diff"
	const readish = lines.filter(line => /^\s*\d+:/.test(line)).length
	if (readish >= Math.ceil(lines.length * 0.6)) return "read"
	const grepish = lines.filter(line => /^.+?:\d+:/.test(line)).length
	if (grepish >= Math.ceil(lines.length * 0.6)) return "grep"
	return "plain"
}

function diffLineStyle(line: string): StyleFn {
	// A hunk header is metadata, so it stays on the monochrome ramp; only the
	// `+`/`-` change lines carry the diff colour exception.
	if (line.startsWith("@@")) return theme.secondary
	if (line.startsWith("+")) return theme.diffAdd
	if (line.startsWith("-")) return theme.diffRemove
	return theme.muted
}

/**
 * `read` wraps its content in protocol framing (`<path>`, `<type>`, `<content>`).
 * The file is already named by the tool row's argument, so the framing is not
 * part of what the user is reading: it is dropped once, at ingestion, so it
 * neither appears in the preview nor skews the result's classification and
 * metric. Content lines are prefixed with their line number, so a real content
 * line never starts with `<`.
 */
function stripReadFraming(lines: readonly string[]): string[] {
	return lines.filter(line => !/^<\/?(path|type|content)\b/.test(line))
}

const DIFF_PREVIEW = 6
const PLAIN_PREVIEW = 3
const ERROR_PREVIEW = 6

/** The two-column grid: the glyph, the tool name, and the argument column. */
const NAME_COLUMN = 6
const HEAD_WIDTH = 1 + 1 + NAME_COLUMN

/**
 * One tool call: a two-column row — state glyph, name and arguments on the
 * left; duration and a result metric on the right — followed by its result.
 * The result is classified from its own content, so a diff shows its changed
 * lines when collapsed and a `read` keeps its line-number gutter.
 */
export class ToolExecutionComponent implements Component {
	private state: ToolState = "running"
	private readonly input: Record<string, unknown>
	private fullLines: string[] = []
	private expanded = false
	private durationMs: number | undefined
	private progressLines: string[] = []
	/**
	 * The last render, keyed by width and scheme. Everything the output depends
	 * on is mutable through the methods below and none of them is inferable from
	 * the arguments to `render`, so each mutation drops the memo explicitly.
	 */
	private readonly memo = renderMemo(width => [this.nodeLine(width), ...this.bodyLines(width)])

	constructor(
		readonly toolCallId: string,
		readonly name: string,
		input: Record<string, unknown>,
		readonly iteration?: number,
	) {
		this.input = input
	}

	/** Drops the memo so the next render reflects the component's current state. */
	invalidate(): void {
		this.memo.invalidate()
	}

	/** Live partial output while the tool is still running. */
	setProgress(text: string): void {
		if (this.state !== "running") return
		const plainText = text.replace(/\x1b\[[0-9;]*m/g, "")
		this.progressLines = plainText.split("\n").filter(line => line.trim().length > 0)
		this.memo.invalidate()
	}

	/** Records the outcome; replaces the running row with the final one. */
	setResult(ok: boolean, result: string, durationMs?: number): void {
		this.state = ok ? "success" : "error"
		this.durationMs = durationMs
		this.progressLines = []
		const plainText = result.replace(/\x1b\[[0-9;]*m/g, "")
		const lines = plainText
			.split("\n")
			.filter(line => line.trim().length > 0)
		this.fullLines = (this.name === "read" ? stripReadFraming(lines) : lines)
			.slice(0, MAX_RESULT_LINES)
			.map(line => (line.length > 200 ? `${line.slice(0, 200)}…` : line))
		this.memo.invalidate()
	}

	/**
	 * Marks a tool whose result never arrived because the run terminated under
	 * it. Only unresolved calls reach this; a call that received its result is
	 * already removed by the caller, so a completed tool is never relabelled.
	 */
	setInterrupted(): void {
		this.state = "interrupted"
		this.progressLines = []
		this.memo.invalidate()
	}

	/** Ctrl-O toggles full output for every tool component. */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded
		this.memo.invalidate()
	}

	/** A truthful metric derived from the result's own content, or "". */
	private resultMetric(): string {
		if (this.state !== "success") return ""
		const lines = this.fullLines
		switch (classify(lines)) {
			case "diff": {
				const added = lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length
				const removed = lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length
				return added === 0 && removed === 0 ? "" : `+${added} −${removed}`
			}
			case "read": {
				// The file's own line count: the numbered content lines, not the
				// protocol framing that wraps them.
				const count = lines.filter(line => /^\s*\d+:/.test(line)).length
				return count === 0 ? "" : `${count} ${count === 1 ? "line" : "lines"}`
			}
			case "grep": {
				const count = lines.filter(line => /^.+?:\d+:/.test(line)).length
				return count === 0 ? "" : `${count} ${count === 1 ? "hit" : "hits"}`
			}
			default:
				return ""
		}
	}

	/** The right column: the runtime's own duration, then the result metric. */
	private metaColumn(): string {
		const duration = this.durationMs === undefined ? "" : formatDuration(this.durationMs)
		const metric = this.resultMetric()
		return [duration, metric].filter(part => part.length > 0).join("  ")
	}

	private nodeLine(width: number): string {
		const glyph = STATE_GLYPH[this.state]
		const name = truncateVisible(this.name, NAME_COLUMN).padEnd(NAME_COLUMN)
		if (width < HEAD_WIDTH + 1) {
			// Too narrow for two columns: the glyph and the name survive.
			return styled(width, [
				{ text: glyph, style: text => glyphStyle(this.state, text) },
				{ text: " ", style: plain },
				{ text: truncateVisible(this.name, Math.max(0, width - 2)), style: text => ansi.bold(text) },
			])
		}
		const args = toolArgumentSummary(this.name, this.input)
		let right = this.metaColumn()
		if (HEAD_WIDTH + displayWidth(right) > width) right = ""
		const rightWidth = displayWidth(right)
		// Reserve a separating column so a clipped argument never runs into the
		// duration and metric on the right.
		const reserve = rightWidth > 0 ? rightWidth + 1 : 0
		const argText = truncateVisible(args, Math.max(0, width - HEAD_WIDTH - reserve))
		const argWidth = displayWidth(argText)
		const gap = Math.max(0, width - HEAD_WIDTH - argWidth - rightWidth)
		return styled(width, [
			{ text: glyph, style: text => glyphStyle(this.state, text) },
			{ text: " ", style: plain },
			{ text: name, style: text => ansi.bold(text) },
			{ text: argText, style: theme.muted },
			{ text: " ".repeat(gap), style: plain },
			{ text: right, style: this.state === "error" ? theme.failure : theme.faint },
		])
	}

	private renderDiff(width: number, cw: number, indent: string): string[] {
		const lines = this.fullLines
		const body = (source: readonly string[], suffix: string | null): string[] => {
			const out: string[] = []
			for (const line of source) {
				const wrapped = wrapBody(line, cw)
				wrapped.forEach((piece, index) => {
					out.push(styled(width, [
						{ text: index === 0 ? indent : " ".repeat(indent.length), style: plain },
						{ text: piece, style: diffLineStyle(line) },
					]))
				})
			}
			if (suffix !== null) {
				out.push(styled(width, [{ text: indent, style: plain }, { text: suffix, style: theme.faint }]))
			}
			return out
		}
		if (this.expanded) {
			const display = lines.filter(
				line => !line.startsWith("Index:") && !line.startsWith("===") && !line.startsWith("--- ") && !line.startsWith("+++ "),
			)
			return body(display, null)
		}
		const changed = lines.filter(
			line => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")),
		)
		const shown = changed.slice(0, DIFF_PREVIEW)
		const remaining = lines.length - shown.length
		return body(shown, remaining > 0 ? `… ${remaining} more ${remaining === 1 ? "line" : "lines"} · ctrl+o` : null)
	}

	private renderNumbered(width: number, cw: number, indent: string): string[] {
		const collapsed = !this.expanded
		const content = this.fullLines
		const lines = collapsed ? content.slice(0, PLAIN_PREVIEW) : content
		const out: string[] = []
		for (const line of lines) {
			const match = /^(\s*)(\d+):\s?(.*)$/.exec(line)
			if (match === null) {
				for (const wrapped of wrapBody(line, cw)) {
					out.push(styled(width, [{ text: indent, style: plain }, { text: wrapped, style: theme.muted }]))
				}
				continue
			}
			const prefix = `${match[2]!.padStart(3)} │ `
			const prefixW = displayWidth(prefix)
			const body = wrapBody(match[3]!, Math.max(1, cw - prefixW))
			out.push(styled(width, [
				{ text: indent, style: plain },
				{ text: prefix, style: theme.faint },
				{ text: body[0] ?? "", style: theme.primary },
			]))
			for (const extra of body.slice(1)) {
				out.push(styled(width, [
					{ text: indent + " ".repeat(prefixW), style: plain },
					{ text: extra, style: theme.primary },
				]))
			}
		}
		if (collapsed && content.length > lines.length) {
			out.push(styled(width, [
				{ text: indent, style: plain },
				{ text: `… ${content.length - lines.length} more ${content.length - lines.length === 1 ? "line" : "lines"} · ctrl+o`, style: theme.faint },
			]))
		}
		return out
	}

	private renderLocation(width: number, cw: number, indent: string): string[] {
		const collapsed = !this.expanded
		const lines = collapsed ? this.fullLines.slice(0, PLAIN_PREVIEW) : this.fullLines
		// The location column is a fixed gutter, but it yields to the match text:
		// it never takes so much of a narrow line that the content hard-splits.
		const locW = Math.max(8, Math.min(30, cw - 16, Math.floor(cw * 0.55)))
		const out: string[] = []
		for (const line of lines) {
			const match = /^(.+?):(\d+):(.*)$/.exec(line)
			if (match === null) {
				for (const wrapped of wrapBody(line, cw)) {
					out.push(styled(width, [{ text: indent, style: plain }, { text: wrapped, style: theme.muted }]))
				}
				continue
			}
			const loc = truncateVisible(`${match[1]}:${match[2]}`, locW).padEnd(locW)
			const content = wrapBody(match[3]!.replace(/^\s?/, ""), Math.max(1, cw - locW - 2))
			out.push(styled(width, [
				{ text: indent, style: plain },
				{ text: loc + "  ", style: theme.faint },
				{ text: content[0] ?? "", style: theme.primary },
			]))
			for (const extra of content.slice(1)) {
				out.push(styled(width, [
					{ text: indent + " ".repeat(locW + 2), style: plain },
					{ text: extra, style: theme.primary },
				]))
			}
		}
		if (collapsed && this.fullLines.length > lines.length) {
			out.push(styled(width, [
				{ text: indent, style: plain },
				{ text: `… ${this.fullLines.length - lines.length} more ${this.fullLines.length - lines.length === 1 ? "line" : "lines"} · ctrl+o`, style: theme.faint },
			]))
		}
		return out
	}

	private renderPlain(width: number, cw: number, indent: string, style: StyleFn, preview: number): string[] {
		const collapsed = !this.expanded
		const lines = collapsed ? this.fullLines.slice(0, preview) : this.fullLines
		const out = lines.flatMap(line =>
			wrapBody(line, cw).map(wrapped => styled(width, [{ text: indent, style: plain }, { text: wrapped, style }])),
		)
		if (collapsed && this.fullLines.length > lines.length) {
			out.push(styled(width, [
				{ text: indent, style: plain },
				{ text: `… ${this.fullLines.length - lines.length} more ${this.fullLines.length - lines.length === 1 ? "line" : "lines"} · ctrl+o`, style: theme.faint },
			]))
		}
		return out
	}

	private bodyLines(width: number): string[] {
		const indent = " ".repeat(BODY_INDENT)
		const cw = Math.max(1, width - BODY_INDENT)
		if (this.state === "running") {
			return this.progressLines.flatMap(line =>
				wrapBody(line, cw).map(wrapped => styled(width, [{ text: indent, style: plain }, { text: wrapped, style: theme.muted }])),
			)
		}
		if (this.state === "error") {
			return this.renderPlain(width, cw, indent, theme.failure, ERROR_PREVIEW)
		}
		switch (classify(this.fullLines)) {
			case "diff":
				return this.renderDiff(width, cw, indent)
			case "read":
				return this.renderNumbered(width, cw, indent)
			case "grep":
				return this.renderLocation(width, cw, indent)
			default:
				return this.renderPlain(width, cw, indent, theme.muted, PLAIN_PREVIEW)
		}
	}

	render(width: number): string[] {
		return this.memo.render(width)
	}
}

/** Replays one persisted history message into chat components. */
export function replayMessage(
	message: SessionMessage,
	resultsByCallId: Map<string, { ok: boolean; result: string }>,
): Component[] {
	if (message.role === "user") return [userMessage(message.content)]
	if (message.role !== "assistant") return []

	// No iteration number: the durable history records none. The block keeps a
	// blank margin, but never a fabricated number.
	const block = new IterationBlock(undefined)
	let hasContent = false
	for (const part of message.content) {
		if (part.type === "text") {
			if (part.text.trim().length > 0) {
				block.addChild(assistantMessage(part.text))
				hasContent = true
			}
			continue
		}
		if (part.type === "tool_call") {
			const component = new ToolExecutionComponent(
				part.toolCallId,
				part.toolName,
				part.input as Record<string, unknown>,
			)
			const recorded = resultsByCallId.get(part.toolCallId)
			if (recorded !== undefined) component.setResult(recorded.ok, recorded.result)
			block.addChild(component)
			hasContent = true
		}
	}
	return hasContent ? [block] : []
}

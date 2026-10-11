import { Container, Text, type Component } from "@loongcode/tui"
import { displayWidth, truncatePlain } from "../../projection"
import { ansi } from "./theme"

/**
 * The frame the mandatory model setup is presented in.
 *
 * It is the whole of what the user sees while the gate is closed: a title, the
 * step's own lines, whatever input the step needs, and the keys that work —
 * with no transcript, no startup banner, no composer and no run statistics
 * behind it. The interactive part is a child rather than a fixed component, so
 * the same panel hosts a list on one step and a text field on the next.
 *
 * Rendering is done here rather than by a layout component because the frame
 * is drawn from text: every line is measured and padded to the terminal width,
 * so nothing downstream can wrap and break the border.
 */

const TITLE = "Model Setup"

/** A horizontal rule with the frame's corner glyphs. */
function rule(left: string, right: string, inner: number, label?: string): string {
	if (label === undefined) return left + "─".repeat(inner) + right
	const text = `─ ${label} `
	const fill = Math.max(0, inner - displayWidth(text))
	return left + text + "─".repeat(fill) + right
}

/**
 * A content line between the frame's vertical edges.
 *
 * The width is measured on PLAIN text and the styling is applied afterwards:
 * measuring a string that already carries escape sequences counts the escapes
 * as columns and leaves the right edge ragged by exactly their length.
 */
function edged(content: string, inner: number, style: (value: string) => string): string {
	const clipped = displayWidth(content) > inner ? truncatePlain(content, inner) : content
	const padded = `│${clipped}${" ".repeat(Math.max(0, inner - displayWidth(clipped)))}│`
	return style(padded)
}

/** A held task, flattened to one line. */
function truncateForRow(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim()
	return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`
}

export interface SetupPanelContent {
	/** Progress line, e.g. `Step 2/5`. Omitted on the steps that carry none. */
	readonly step?: string
	/** The step's heading lines. */
	readonly heading: readonly string[]
	/** A description under the input, when the step has one. */
	readonly note?: string
	/** What is wrong with the value the user just gave, shown in place. */
	readonly problem?: string
	/** The keys that work on this step. */
	readonly hints: string
}

export class SetupPanel implements Component {
	private readonly body = new Container()
	private input: Component | null = null
	private content: SetupPanelContent = { heading: [], hints: "" }
	private pendingTask: string | null = null

	/** Replaces the step's text. */
	setContent(content: SetupPanelContent): void {
		this.content = content
	}

	/**
	 * The task held back by the gate, when there is one.
	 *
	 * It is shown on every step: a task the user typed must be visibly kept,
	 * not silently stashed, and the setup screen is the only place they can see
	 * it while the workspace is closed.
	 */
	setPendingTask(task: string | null): void {
		this.pendingTask = task
	}

	/**
	 * Places the step's interactive component, or clears it. A component can
	 * only be rendered once, so the caller removes it from wherever it was
	 * before handing it here.
	 */
	setInput(component: Component | null): void {
		this.input = component
	}

	invalidate(): void {
		this.body.invalidate()
		this.input?.invalidate?.()
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2)
		const lines: string[] = [ansi.gray(rule("┌", "┐", inner, TITLE))]

		const push = (text: string, style: (value: string) => string = ansi.gray): void => {
			lines.push(edged(text.length === 0 ? "" : ` ${text}`, inner, style))
		}

		if (this.content.step !== undefined) push(this.content.step)
		for (const line of this.content.heading) push(line, ansi.bold)
		if (this.content.note !== undefined) push(this.content.note)
		// The problem belongs to the field it names, so it is shown on the step
		// that is asking for it rather than in the transcript.
		if (this.content.problem !== undefined) push(this.content.problem, ansi.red)

		// The input is rendered at the inner width so its own frame lines up
		// with the panel's.
		this.body.clear()
		if (this.input !== null) this.body.addChild(this.input)
		if (this.input !== null) {
			push("")
			for (const line of this.body.render(inner)) {
				lines.push(ansi.gray(`│`) + line + ansi.gray(`│`))
			}
		}

		if (this.pendingTask !== null) {
			push(`Your task is saved: ${truncateForRow(this.pendingTask)}`)
		}

		lines.push(ansi.gray(rule("├", "┤", inner)))
		for (const hint of this.content.hints.split("\n")) push(hint)
		lines.push(ansi.gray(rule("└", "┘", inner)))
		return lines
	}
}

/** A plain line inside the panel (used for the states that take no input). */
export function panelLine(text: string): Component {
	return new Text(text, 0, 0)
}

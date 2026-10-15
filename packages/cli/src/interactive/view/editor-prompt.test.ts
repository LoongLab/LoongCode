import { describe, expect, test } from "bun:test"
import { TuiHarness } from "./testing"
import { composerGhostText } from "../input/argument-placeholder"

/**
 * The composer's prompt gutter and its placeholder.
 *
 * The composer draws `❯ ` in a left gutter on the buffer's first line and spaces
 * on every continuation, so wrapped input aligns under the text column. The
 * placeholder shares that text column, and neither is ever part of the buffer.
 */

const PROMPT = "❯ "
const PLACEHOLDER = "Type a message…"

/** The production placeholder policy: shown only while the input is empty. */
const idlePolicy = (state: { lines: string[]; cursorLine: number; cursorCol: number }): string | undefined =>
	composerGhostText(state, [], PLACEHOLDER)

/** The harness screen with trailing padding kept (columns are meaningful). */
function rows(h: TuiHarness): string[] {
	return h.screen()
}

/** The composer's visible content rows (between its two border rules). */
function contentRows(h: TuiHarness): string[] {
	const all = rows(h)
	// The composer is the rule/content/rule block above the two footer rows.
	const bottom = all.length - 3
	let top = bottom - 1
	while (top >= 0 && !/^─+$/.test(all[top]!.trim())) top -= 1
	return all.slice(top + 1, bottom)
}

function composer(h: TuiHarness): TuiHarness {
	h.editor.setPrompt(PROMPT)
	return h
}

describe("Composer prompt gutter", () => {
	test("the prompt is drawn on the first line and is not part of the buffer", () => {
		const h = composer(new TuiHarness({ width: 80, height: 24 }).start())
		h.editor.setText("fix the token refresh")
		const content = contentRows(h)
		expect(content[0]).toBe("❯ fix the token refresh")
		expect(h.editor.getText()).toBe("fix the token refresh")
	})

	test("continuation lines align under the text, not under the prompt", () => {
		const h = composer(new TuiHarness({ width: 80, height: 24 }).start())
		h.editor.setText("first line\nsecond line\nthird")
		const content = contentRows(h)
		expect(content[0]).toBe("❯ first line")
		// Two spaces: the gutter width, with no repeated glyph.
		expect(content[1]).toBe("  second line")
		expect(content[2]).toBe("  third")
	})

	test("the placeholder starts at the text column so the first keystroke does not shift it", () => {
		const h = composer(new TuiHarness({ width: 80, height: 24 }).start())
		h.editor.setGhostTextProvider(idlePolicy)
		// Empty input: the placeholder begins exactly where typed text will.
		expect(contentRows(h)[0]).toBe(`❯ ${PLACEHOLDER}`)
		h.editor.setText("Type")
		// Typing the first character replaces the placeholder at the same column —
		// the text column does not move.
		expect(contentRows(h)[0]).toBe("❯ Type")
	})

	test("clearing the prompt returns the text to the first column", () => {
		const h = composer(new TuiHarness({ width: 80, height: 24 }).start())
		h.editor.setText("hello")
		expect(contentRows(h)[0]).toBe("❯ hello")
		h.editor.setPrompt(undefined)
		expect(h.editor.isPrompted()).toBe(false)
		expect(contentRows(h)[0]).toBe("hello")
	})

	test("the prompt is render-only: it does not change the buffer or the cursor", () => {
		const h = composer(new TuiHarness({ width: 80, height: 24 }).start())
		h.editor.setText("abc")
		const cursor = h.editor.getCursor()
		contentRows(h)
		expect(h.editor.getText()).toBe("abc")
		expect(h.editor.getCursor()).toEqual(cursor)
	})

	test("a narrow terminal never emits a row wider than the width", () => {
		for (const width of [20, 12, 8, 4]) {
			const h = composer(new TuiHarness({ width, height: 24 }).start())
			h.editor.setGhostTextProvider(() => PLACEHOLDER)
			h.editor.setText("a rather long line of input that must wrap somewhere")
			for (const row of rows(h)) {
				expect(row.length).toBeLessThanOrEqual(width)
			}
		}
	})

	test("a prompt that cannot fit is dropped rather than overflowing the row", () => {
		// Below four columns the 2-cell prompt plus its one reserved cursor column
		// no longer fit; the gutter yields and the text starts at column 0.
		for (const width of [3, 2, 1]) {
			const h = composer(new TuiHarness({ width, height: 24 }).start())
			h.editor.setText("ab")
			for (const row of rows(h)) {
				expect(row.length).toBeLessThanOrEqual(width)
			}
			// At width 3 the prompt fits; at 2 and 1 it does not.
			const content = contentRows(h)
			if (width === 3) expect(content[0]).toBe("❯ a")
			else expect(content[0]!.startsWith("a")).toBe(true)
		}
	})

	test("the gutter reduces the wrap width, so a long line wraps sooner", () => {
		const width = 24
		// 22 columns: fits on one line without the gutter (wrap width 23), and
		// needs two with it (wrap width 21).
		const text = "x".repeat(22)
		const plain = new TuiHarness({ width, height: 24 }).start()
		plain.editor.setText(text)
		const plainRows = contentRows(plain).length

		const prompted = composer(new TuiHarness({ width, height: 24 }).start())
		prompted.editor.setText(text)
		const promptedRows = contentRows(prompted).length
		expect(plainRows).toBe(1)
		expect(promptedRows).toBe(2)
	})
})

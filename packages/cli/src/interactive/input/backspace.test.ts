import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { matchesKey } from "@loongcode/tui"
import { TuiHarness } from "../view/testing"

/**
 * Backspace must delete, in every terminal environment.
 *
 * The reported failure: a raw `0x08` (the byte Windows consoles and some
 * legacy terminals send for plain Backspace) was decoded as `ctrl+backspace`
 * whenever `WT_SESSION` was set, and nothing binds that key, so the editor
 * discarded the byte. The first test below is that exact condition; the matrix
 * keeps every other combination honest.
 */

const ENV_NAMES = ["WT_SESSION", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
	saved = {}
	for (const name of ENV_NAMES) saved[name] = process.env[name]
})

afterEach(() => {
	// Restore the environment so one case cannot leak into the next.
	for (const name of ENV_NAMES) {
		const value = saved[name]
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
})

/** Applies exactly the named variables; everything else in ENV_NAMES is cleared. */
function terminalEnv(vars: Partial<Record<(typeof ENV_NAMES)[number], string>>): void {
	for (const name of ENV_NAMES) delete process.env[name]
	for (const [name, value] of Object.entries(vars)) process.env[name] = value
}

/** Types "abc" through the real editor, feeds `bytes`, returns the buffer. */
function typeThenFeed(bytes: string): string {
	const h = new TuiHarness({ width: 60, height: 24, chatLines: 0 }).start()
	h.feed("abc")
	h.feed(bytes)
	return h.editor.getText()
}

const BACKSPACE_BYTES = [
	["0x7f (DEL, POSIX Backspace)", "\x7f"],
	["0x08 (BS, Windows/legacy)", "\x08"],
] as const

const ENVIRONMENTS = [
	["no terminal variables", {}],
	["WT_SESSION set (Windows Terminal)", { WT_SESSION: "session-id" }],
	["WT_SESSION + SSH_CONNECTION", { WT_SESSION: "session-id", SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 2" }],
	["SSH only", { SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 2" }],
] as const

describe("Backspace deletes through the real editor", () => {
	test("the reported failure: raw 0x08 with WT_SESSION set deletes a character", () => {
		terminalEnv({ WT_SESSION: "session-id" })
		expect(typeThenFeed("\x08")).toBe("ab")
	})

	for (const [byteName, bytes] of BACKSPACE_BYTES) {
		for (const [envName, vars] of ENVIRONMENTS) {
			test(`${byteName} with ${envName}`, () => {
				terminalEnv(vars)
				expect(typeThenFeed(bytes)).toBe("ab")
			})
		}
	}

	test("Backspace on an empty input is a no-op", () => {
		terminalEnv({ WT_SESSION: "session-id" })
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 0 }).start()
		h.feed("\x08")
		h.feed("\x7f")
		expect(h.editor.getText()).toBe("")
	})

	test("Backspace deletes before the cursor, not at the end of the line", () => {
		terminalEnv({ WT_SESSION: "session-id" })
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 0 }).start()
		h.feed("abc")
		h.feed("\x1b[D") // left: cursor now before "c"
		h.feed("\x08")
		expect(h.editor.getText()).toBe("ac")
	})

	test("Backspace at the start of a line merges it with the previous line", () => {
		terminalEnv({ WT_SESSION: "session-id" })
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 0 }).start()
		h.editor.setText("first\n") // cursor is on the empty second line
		h.feed("\x08")
		expect(h.editor.getText()).toBe("first")
	})
})

describe("Ctrl+Backspace where the terminal can express it", () => {
	test("the Kitty CSI-u sequence is still Ctrl+Backspace, not plain Backspace", () => {
		terminalEnv({ WT_SESSION: "session-id" })
		expect(matchesKey("\x1b[127;5u", "ctrl+backspace")).toBe(true)
		expect(matchesKey("\x1b[127;5u", "backspace")).toBe(false)
	})

	test("Ctrl+Backspace deletes a word through the editor", () => {
		terminalEnv({ WT_SESSION: "session-id" })
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 0 }).start()
		h.feed("one two")
		h.feed("\x1b[127;5u")
		expect(h.editor.getText()).toBe("one ")
	})

	test("a raw 0x08 is never Ctrl+Backspace, in any environment", () => {
		for (const [, vars] of ENVIRONMENTS) {
			terminalEnv(vars)
			expect(matchesKey("\x08", "backspace")).toBe(true)
			expect(matchesKey("\x08", "ctrl+backspace")).toBe(false)
		}
	})
})

describe("the escape-prefixed variants keep their meaning", () => {
	const ALT_BACKSPACE = [
		["ESC 0x7f", "\x1b\x7f"],
		["ESC 0x08", "\x1b\x08"],
	] as const

	for (const [name, bytes] of ALT_BACKSPACE) {
		test(`${name} is Alt+Backspace`, () => {
			terminalEnv({ WT_SESSION: "session-id" })
			expect(matchesKey(bytes, "alt+backspace")).toBe(true)
			expect(matchesKey(bytes, "backspace")).toBe(false)
		})
	}

	test("Alt+Backspace deletes a word through the editor", () => {
		terminalEnv({ WT_SESSION: "session-id" })
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 0 }).start()
		h.feed("one two")
		h.feed("\x1b\x08")
		expect(h.editor.getText()).toBe("one ")
	})
})

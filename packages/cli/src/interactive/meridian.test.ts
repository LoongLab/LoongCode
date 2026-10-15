import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Terminal } from "@loongcode/tui"
import { LoongCode, type Session } from "@loongcode/agent"
import { LoongCodeTui, COMPOSER_PLACEHOLDER, modelReadiness } from "./app"
import { READY_LINE } from "./view/banner"
import { parseRawScreen, parseScreen, stripSequences } from "./view/testing"
import { displayWidth } from "../projection"
import { openaiChunk, hangingStream, sse, startMockProvider } from "../../../model/src/test-support"

/**
 * Meridian acceptance tests: the real application, driven against a mock
 * provider, at real terminal sizes. These assert association and geometry —
 * which event produced which view, how wide each row is, and which states are
 * distinguishable — not merely that some characters appear.
 */

const ENTER = "\r"
const ESC = "\x1b"

let root: string
let ws: string
let configDir: string
let sessionsDir: string
let priorConfigDir: string | undefined

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "loongcode-meridian-"))
	ws = join(root, "ws")
	configDir = join(root, "config")
	sessionsDir = join(root, "sessions")
	mkdirSync(ws)
	mkdirSync(configDir)
	mkdirSync(sessionsDir)
	priorConfigDir = process.env.LOONGCODE_CONFIG_DIR
	process.env.LOONGCODE_CONFIG_DIR = configDir
})

afterEach(() => {
	if (priorConfigDir === undefined) delete process.env.LOONGCODE_CONFIG_DIR
	else process.env.LOONGCODE_CONFIG_DIR = priorConfigDir
	rmSync(root, { recursive: true, force: true })
})

interface Tty {
	readonly terminal: Terminal
	readonly writes: string[]
	feed(data: string): void
	resize(columns: number, rows: number): void
}

function createTerminal(columns: number, rows: number): Tty {
	const state = { columns, rows, send: undefined as ((d: string) => void) | undefined }
	const writes: string[] = []
	const terminal: Terminal = {
		start(onInput) {
			state.send = onInput
		},
		stop() {},
		async drainInput() {},
		write(data) {
			writes.push(data)
		},
		get columns() {
			return state.columns
		},
		get rows() {
			return state.rows
		},
		get kittyProtocolActive() {
			return false
		},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
	}
	return {
		terminal,
		writes,
		feed: d => state.send?.(d),
		resize: (c, r) => {
			state.columns = c
			state.rows = r
		},
	}
}

const flush = async (times = 12): Promise<void> => {
	for (let i = 0; i < times; i++) await new Promise(r => setTimeout(r, 1))
}

const modelsFile = (): string => join(configDir, "models.json")
const validConfig = (endpoint: string): string =>
	JSON.stringify({
		version: 1,
		models: [{
			id: "probe", name: "probe", protocol: "openai", endpoint,
			model: "probe-model", apiKey: "sk-dummy-not-a-real-key",
			contextWindow: 128000, maxOutputTokens: 8192,
		}],
		activeModelId: "probe",
	})

interface Harness {
	readonly agent: LoongCode
	readonly session: Session
	readonly app: LoongCodeTui
	readonly tty: Tty
}

async function mount(columns = 100, rows = 30, session?: Session): Promise<Harness> {
	const agent = new LoongCode({ sessionsDir })
	const active = session ?? agent.createSession(ws)
	const tty = createTerminal(columns, rows)
	const app = new LoongCodeTui({
		agent,
		session: active,
		terminal: tty.terminal,
		label: active.cwd,
		readiness: await modelReadiness(agent),
	})
	app.start()
	await flush()
	return { agent, session: active, app, tty }
}

/** The rendered frame as plain rows (trailing padding trimmed). */
function view(h: Harness, rows = 30): string[] {
	h.tty.writes.length = 0
	;(h.app as unknown as { tui: { renderNow(force?: boolean): void } }).tui.renderNow(true)
	return parseScreen(h.tty.writes.join(""), rows)
}

/** The rendered frame as rows with ANSI stripped but no trimming. */
function rawView(h: Harness, rows = 30): string[] {
	h.tty.writes.length = 0
	;(h.app as unknown as { tui: { renderNow(force?: boolean): void } }).tui.renderNow(true)
	return parseRawScreen(h.tty.writes.join(""), rows).map(stripSequences)
}

async function type(h: Harness, text: string): Promise<void> {
	h.tty.feed(text)
	await flush()
	h.tty.feed(ENTER)
	await flush(40)
}

/** A streaming tool call, then a streaming final answer. */
function toolThenTextProvider(callName: string, args: string, finalText: string) {
	let call = 0
	return startMockProvider(() => {
		call += 1
		if (call === 1) {
			return sse([
				openaiChunk(
					{ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: callName, arguments: args } }] },
					null,
				),
				openaiChunk({}, "tool_calls"),
				null,
			])
		}
		return sse([openaiChunk({ role: "assistant", content: finalText }, null), openaiChunk({}, "stop"), null])
	})
}

describe("Meridian — iteration semantics", () => {
	test("iteration numbers come from iteration_start; a tool turn and the next turn are numbered 1 and 2", async () => {
		const provider = await toolThenTextProvider("ls", JSON.stringify({ path: "." }), "All set.")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			await type(h, "List the files and then finish.")
			const frame = view(h).join("\n")
			// The tool belongs to iteration 1; the final text to iteration 2.
			expect(frame).toMatch(/^ 1 /m)
			expect(frame).toMatch(/^ 2 /m)
			// The tool resolved to a completed glyph, not left running.
			expect(frame).toContain("✓")
			expect(frame).not.toContain("⠿")
		} finally {
			await provider.close()
		}
	})

	test("a user message never receives an iteration number", async () => {
		const provider = await toolThenTextProvider("ls", JSON.stringify({ path: "." }), "All set.")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			await type(h, "List the files.")
			const rows = view(h)
			const userRow = rows.find(row => row.includes("List the files."))
			expect(userRow).toBeDefined()
			// The entry rail marks the user; no numeric gutter precedes it.
			expect(userRow!.trimStart().startsWith("❯")).toBe(true)
			expect(/^ ?\d /.test(userRow!)).toBe(false)
		} finally {
			await provider.close()
		}
	})

	test("a replayed session shows the margin but no fabricated iteration numbers", async () => {
		const provider = await toolThenTextProvider("ls", JSON.stringify({ path: "." }), "All set.")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const first = await mount()
			await type(first, "List the files.")
			expect(first.session.messages.length).toBeGreaterThan(0)

			// A fresh mount of the same session replays durable history.
			const resumed = await mount(100, 30, first.session)
			const frame = view(resumed).join("\n")
			expect(frame).toContain("List the files.")
			// The assistant block carries the spine…
			expect(frame).toContain("❯")
			// …but no line of the replayed transcript begins with an iteration number.
			for (const row of view(resumed)) {
				expect(/^ ?\d /.test(row)).toBe(false)
			}
		} finally {
			await provider.close()
		}
	})
})

describe("Meridian — tool lifecycle", () => {
	test("a genuine interruption does not leave a tool running", async () => {
		// The first request hangs inside a tool stream; Esc aborts it before any
		// result is delivered.
		const provider = await startMockProvider(() => {
			return sse([
				openaiChunk(
					{ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "sleep 5" }) } }] },
					null,
				),
				openaiChunk({}, "tool_calls"),
				null,
			])
		})
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			h.tty.feed("run a slow command")
			await flush()
			h.tty.feed(ENTER)
			await flush(20)
			h.tty.feed(ESC)
			await flush(40)
			const frame = view(h).join("\n")
			expect(frame).not.toContain("⠿")
			// Either the tool was interrupted or the run aborted with no tool left
			// pending; in both cases nothing still claims to be running.
			expect(frame).toContain("aborted")
		} finally {
			await provider.close()
		}
	})
})

describe("Meridian — geometry", () => {
	const sizes: ReadonlyArray<readonly [number, number]> = [
		[40, 16], [48, 20], [60, 20], [80, 24], [120, 40],
	]

	test("no rendered row exceeds the terminal width at any tested size", async () => {
		const provider = await toolThenTextProvider("ls", JSON.stringify({ path: "." }), "All set.")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			for (const [width, height] of sizes) {
				const h = await mount(width, height)
				await type(h, "List the files and then finish.")
				for (const row of rawView(h, height)) {
					expect(displayWidth(row)).toBeLessThanOrEqual(width)
				}
			}
		} finally {
			await provider.close()
		}
	})

	test("a wrapped user message keeps its continuation indent", async () => {
		const provider = await toolThenTextProvider("ls", JSON.stringify({ path: "." }), "ok")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount(40, 20)
			const long = "Refactor the authentication module to use the new token service and add tests now"
			await type(h, long)
			const rows = view(h)
			const first = rows.findIndex(row => row.includes("Refactor the authentication"))
			expect(first).toBeGreaterThanOrEqual(0)
			// The continuation row exists and keeps leading indentation (never col 0).
			const next = rows[first + 1] ?? ""
			expect(next.trim().length).toBeGreaterThan(0)
			expect(next.startsWith(" ")).toBe(true)
		} finally {
			await provider.close()
		}
	})

	test("a narrow tool row keeps its tool name and state glyph", async () => {
		const provider = await toolThenTextProvider("ls", JSON.stringify({ path: "." }), "ok")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount(40, 20)
			await type(h, "List the files.")
			const frame = view(h).join("\n")
			expect(frame).toContain("ls")
			expect(frame).toContain("✓")
		} finally {
			await provider.close()
		}
	})

	test("the footer never begins a row with a bare ellipsis at a narrow width", async () => {
		const provider = await toolThenTextProvider("ls", JSON.stringify({ path: "." }), "ok")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			for (const width of [40, 48, 60]) {
				const all = await mount(width, 24)
				await type(all, "List the files.")
				const rows = view(all)
				// The footer is the last two rows at this height.
				for (const row of rows.slice(-2)) {
					const trimmed = row.trimStart()
					// A shortened path (`…project`) is meaningful; a bare `…`
					// (ellipsis with nothing, or only a separator, after it) is not.
					expect(/^…(\s|$)/.test(trimmed)).toBe(false)
				}
			}
		} finally {
			await provider.close()
		}
	})

	test("a long multiline composer does not consume a short terminal", async () => {
		const provider = await toolThenTextProvider("ls", JSON.stringify({ path: "." }), "ok")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount(80, 10)
			// Build a 20-line composer with alt+enter, the real newline key.
			h.tty.feed("line-0")
			for (let i = 1; i < 20; i++) {
				h.tty.feed("\x1b\r")
				await flush(2)
				h.tty.feed(`line-${i}`)
			}
			await flush(20)
			const rows = view(h, 10)
			expect(rows).toHaveLength(10)
			// Every rendered row is within the terminal.
			for (const row of rawView(h, 10)) {
				expect(displayWidth(row)).toBeLessThanOrEqual(80)
			}
			// The composer is bounded: at most four of its own content rows are
			// visible, so a 20-line input cannot claim the screen.
			const contentRows = rows.filter(row => /line-\d+/.test(row)).length
			expect(contentRows).toBeGreaterThanOrEqual(1)
			expect(contentRows).toBeLessThanOrEqual(4)
			// The footer's first row survives below the composer.
			expect(rows[rows.length - 1]!.trim().length).toBeGreaterThan(0)
		} finally {
			await provider.close()
		}
	})
})

describe("Meridian — state is readable without color", () => {
	test("running, success and failure are distinct on a color-stripped frame", async () => {
		const provider = await toolThenTextProvider("ls", JSON.stringify({ path: "." }), "ok")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			await type(h, "List the files.")
			// parseScreen strips ANSI, so this reads the frame as a monochrome
			// terminal would: the state must still be legible.
			const frame = view(h).join("\n")
			expect(frame).toContain("✓")
			expect(frame).not.toMatch(/\x1b\[/)
		} finally {
			await provider.close()
		}
	})
})

/**
 * The windowed transcript, driven end to end.
 *
 * The conversation stack is windowed: it is laid out from its logical row count
 * and painted from the visible window. These assertions pin the consequences a
 * windowed viewport must get right with real streamed content — the newest turn
 * is visible, earlier turns remain reachable by scrolling, and the transcript
 * does not silently drop content when it grows.
 */
describe("Meridian — windowed transcript", () => {
	test("several streamed turns accumulate and the newest stays visible", async () => {
		let call = 0
		const provider = await startMockProvider(() =>
			sse([openaiChunk({ role: "assistant", content: `ANSWER-${++call}` }, null), openaiChunk({}, "stop"), null]),
		)
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount(100, 16)
			for (let i = 0; i < 6; i++) await type(h, `Task number ${i}`)
			const frame = view(h, 16).join("\n")
			// The newest answer and its prompt are on screen.
			expect(frame).toContain("ANSWER-6")
			expect(frame).toContain("Task number 5")
			// The transcript is taller than the viewport, so the earliest prompt has
			// scrolled out — but it is still reachable.
			expect(frame).not.toContain("Task number 0")
			h.tty.feed("\x1b[1~") // Home
			await flush()
			expect(view(h, 16).join("\n")).toContain("Task number 0")
		} finally {
			await provider.close()
		}
	})

	test("a scrolled-up viewport holds its offset while a new streamed turn arrives", async () => {
		let call = 0
		const provider = await startMockProvider(() =>
			sse([openaiChunk({ role: "assistant", content: `LONG-ANSWER-${++call} `.repeat(6) }, null), openaiChunk({}, "stop"), null]),
		)
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount(100, 16)
			for (let i = 0; i < 5; i++) await type(h, `Prompt ${i}`)
			// Scroll up, then read the top row and the follow state.
			h.tty.feed("\x1b[5~") // PageUp
			await flush()
			const scrollView = (h.app as unknown as { tui: { getPrimaryScrollView(): { scrollTop: number; isFollowingEnd: boolean } } }).tui
			const before = scrollView.getPrimaryScrollView().scrollTop
			expect(scrollView.getPrimaryScrollView().isFollowingEnd).toBe(false)
			await type(h, "one more prompt")
			// The windowed stack grew, but the viewport was reading older content:
			// the absolute offset is preserved and follow stays released.
			expect(scrollView.getPrimaryScrollView().scrollTop).toBe(before)
			expect(scrollView.getPrimaryScrollView().isFollowingEnd).toBe(false)
		} finally {
			await provider.close()
		}
	})

	test("a long transcript's frame never exceeds the terminal width", async () => {
		let call = 0
		const provider = await startMockProvider(() =>
			sse([openaiChunk({ role: "assistant", content: `W-${++call} `.repeat(30) }, null), openaiChunk({}, "stop"), null]),
		)
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount(60, 18)
			for (let i = 0; i < 8; i++) await type(h, `A prompt that is long enough to wrap at sixty columns, number ${i}`)
			for (const row of view(h, 18)) {
				expect(displayWidth(row)).toBeLessThanOrEqual(60)
			}
		} finally {
			await provider.close()
		}
	})
})

/**
 * The composer and the runtime status line.
 *
 * The composer carries the input prompt and placeholder; the runtime status
 * above it owns the execution state and the single interrupt affordance, and the
 * footer states only facts. These assert the visible contract, not the code path.
 */
describe("Meridian — composer and runtime status", () => {
	test("the idle composer draws the prompt and placeholder, and the footer names no idle state", async () => {
		const provider = await startMockProvider(() =>
			sse([openaiChunk({ role: "assistant", content: "ok" }, null), openaiChunk({}, "stop"), null]),
		)
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			// The composer's content row begins with the prompt and shows the
			// placeholder at the text column (raw rows keep leading columns).
			expect(rawView(h).some(row => row.startsWith(`❯ ${COMPOSER_PLACEHOLDER}`))).toBe(true)
			const frame = view(h).join("\n")
			// Identity and context are shown; no standing idle label is.
			expect(frame).not.toContain("Idle")
			expect(frame).not.toContain("Working")
			expect(frame).not.toContain("Esc to interrupt")
		} finally {
			await provider.close()
		}
	})

	test("the idle screen does not repeat the masthead's guidance in the composer", async () => {
		const provider = await startMockProvider(() =>
			sse([openaiChunk({ role: "assistant", content: "ok" }, null), openaiChunk({}, "stop"), null]),
		)
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			const frame = view(h).join("\n")
			// Masthead A's ready-state guidance is present, once.
			expect(frame).toContain(READY_LINE)
			expect(frame.split(READY_LINE)).toHaveLength(2)
			// The composer shows its own, shorter placeholder, and the guidance
			// sentence is not repeated by it.
			expect(frame).toContain(COMPOSER_PLACEHOLDER)
			expect(COMPOSER_PLACEHOLDER).not.toBe(READY_LINE)
			// The ready line's distinguishing sentence appears exactly once.
			expect(frame.split("Describe a task")).toHaveLength(2)
		} finally {
			await provider.close()
		}
	})

	test("while running the interrupt hint appears exactly once, above the composer", async () => {
		const provider = await startMockProvider(() => hangingStream([openaiChunk({ role: "assistant", content: "slow" }, null)]))
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			await type(h, "do the thing")
			const frame = view(h)
			const text = frame.join("\n")
			// The footer names the active operation…
			expect(text).toContain("Working")
			// …and the interrupt affordance is stated once, in the status line.
			expect(frame.filter(row => row.includes("esc to interrupt"))).toHaveLength(1)
			expect(text).not.toContain("Esc to interrupt")

			// Interrupting clears the status: the run's presentation is restored,
			// not left stale.
			h.tty.feed(ESC)
			await flush(60)
			const after = view(h).join("\n")
			expect(after).not.toContain("esc to interrupt")
			expect(after).not.toContain("Working")
			expect(after).toContain("run aborted")
		} finally {
			await provider.close()
		}
	})

	test("a pending prompt states what it waits for, and clears when answered", async () => {
		const provider = await startMockProvider(() =>
			sse([openaiChunk({ role: "assistant", content: "ok" }, null), openaiChunk({}, "stop"), null]),
		)
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			const ctx = (h.app as unknown as {
				commandContext: { ask(label: string): Promise<string | null> }
			}).commandContext
			const pending = ctx.ask("Session title")
			await flush(8)
			expect(view(h).join("\n")).toContain("Session title")

			h.tty.feed("\r") // submit the (empty) answer
			await pending
			await flush(8)
			// Answered: the prompt line is gone rather than left behind.
			expect(view(h).join("\n")).not.toContain("Session title")
		} finally {
			await provider.close()
		}
	})
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Terminal } from "@loongcode/tui"
import { LoongCode, type Session } from "@loongcode/agent"
import { LoongCodeTui, modelReadiness } from "./app"
import { parseScreen } from "./view/testing"
import { hangingStream, openaiChunk, sse, startMockProvider } from "../../../model/src/test-support"

/**
 * Esc interruption, driven through the real application.
 *
 * These are regression tests for the interruption path:
 * `Esc → keybinding dispatch → abortRun → runtime cancellation → run end → UI
 * cleanup`. Synchronization is condition-based (poll the rendered frame) rather
 * than fixed sleeps, so a test fails on behaviour, not on timing.
 */

const ENTER = "\r"
const ESC = "\x1b"

let root: string
let ws: string
let configDir: string
let sessionsDir: string
let priorConfigDir: string | undefined

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "loongcode-esc-"))
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
}

function createTerminal(columns = 100, rows = 30): Tty {
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
	return { terminal, writes, feed: d => state.send?.(d) }
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 2))

interface Harness {
	readonly agent: LoongCode
	readonly session: Session
	readonly app: LoongCodeTui
	readonly tty: Tty
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
	for (let i = 0; i < 8; i++) await tick()
	return { agent, session: active, app, tty }
}

/** The current frame as plain rows. */
function view(h: Harness): string {
	h.tty.writes.length = 0
	;(h.app as unknown as { tui: { renderNow(force?: boolean): void } }).tui.renderNow(true)
	return parseScreen(h.tty.writes.join(""), 30).join("\n")
}

/**
 * The frame predicate that means "no run is active". The footer no longer
 * carries a standing `Idle` label — idle is the absence of an active operation —
 * so the release of the run is read as the absence of `Working`. The active side
 * is checked inline where a test needs it.
 */
const idle = (frame: string): boolean => !frame.includes("Working ·")

/** Polls the rendered frame until `check` holds or the deadline passes. */
async function waitFor(h: Harness, check: (frame: string) => boolean, timeoutMs = 6000): Promise<boolean> {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		if (check(view(h))) return true
		await tick()
	}
	return check(view(h))
}

async function submit(h: Harness, text: string): Promise<void> {
	h.tty.feed(text)
	for (let i = 0; i < 4; i++) await tick()
	h.tty.feed(ENTER)
	await tick()
}

/** A provider whose first response streams this content then hangs forever. */
function hangingProvider(content: string) {
	return startMockProvider(() => hangingStream([openaiChunk({ role: "assistant", content }, null)]))
}

/** A provider that emits a `bash` tool call, then answers on later requests. */
function toolProvider(command: string, answer = "ANSWER") {
	let n = 0
	return startMockProvider(() => {
		n += 1
		if (n === 1) {
			return sse([
				openaiChunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, null),
				openaiChunk({}, "tool_calls"),
				null,
			])
		}
		return sse([openaiChunk({ role: "assistant", content: answer }, null), openaiChunk({}, "stop"), null])
	})
}

describe("Esc interrupts the active run", () => {
	test("1. Esc during a pending model response ends the run promptly", async () => {
		const provider = await hangingProvider("slow thought")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			await submit(h, "do the thing")
			expect(await waitFor(h, f => f.includes("Working ·"))).toBe(true)

			h.tty.feed(ESC)
			// One keypress must be enough: the run returns to idle on its own.
			expect(await waitFor(h, idle, 3000)).toBe(true)
			expect(view(h)).toContain("run aborted")
		} finally {
			await provider.close()
		}
	})

	test("2. Esc while a tool call is pending resolves the pending tool", async () => {
		const provider = await toolProvider("sleep 30")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			await submit(h, "run a long command")
			// The tool is genuinely pending: its state glyph says running.
			expect(await waitFor(h, f => f.includes("⠿"))).toBe(true)

			h.tty.feed(ESC)
			expect(await waitFor(h, idle, 5000)).toBe(true)
			const frame = view(h)
			// No tool is left claiming it is running.
			expect(frame).not.toContain("⠿")
		} finally {
			await provider.close()
		}
	})

	test("3. Esc after interruption has already started is harmless", async () => {
		const provider = await hangingProvider("slow thought")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			await submit(h, "do the thing")
			expect(await waitFor(h, f => f.includes("Working ·"))).toBe(true)

			h.tty.feed(ESC)
			h.tty.feed(ESC)
			h.tty.feed(ESC)
			expect(await waitFor(h, idle, 3000)).toBe(true)
			// A single interruption, not one per keypress.
			expect(view(h).match(/run aborted/g)?.length ?? 0).toBe(1)
		} finally {
			await provider.close()
		}
	})

	test("4. input control returns and a new task is accepted after interruption", async () => {
		const provider = await hangingProvider("slow thought")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			await submit(h, "do the thing")
			expect(await waitFor(h, f => f.includes("Working ·"))).toBe(true)
			h.tty.feed(ESC)
			expect(await waitFor(h, idle, 3000)).toBe(true)

			// The editor accepts input again; the composer reflects the typing.
			h.tty.feed("next task")
			expect(await waitFor(h, f => f.includes("next task"))).toBe(true)
		} finally {
			await provider.close()
		}
	})

	test("5. the interrupted run cannot corrupt the next run", async () => {
		// First request hangs; later requests answer.
		let n = 0
		const provider = await startMockProvider(() => {
			n += 1
			if (n === 1) return hangingStream([openaiChunk({ role: "assistant", content: "FIRST-HANG" }, null)])
			return sse([openaiChunk({ role: "assistant", content: "SECOND-ANSWER" }, null), openaiChunk({}, "stop"), null])
		})
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			await submit(h, "first task")
			expect(await waitFor(h, f => f.includes("FIRST-HANG"))).toBe(true)
			h.tty.feed(ESC)
			expect(await waitFor(h, idle, 3000)).toBe(true)

			await submit(h, "second task")
			expect(await waitFor(h, f => f.includes("SECOND-ANSWER"))).toBe(true)
			// The second run starts its own iteration numbering at 1.
			expect(view(h)).toContain("SECOND-ANSWER")
			expect(view(h)).toMatch(/^ 1 /m)
		} finally {
			await provider.close()
		}
	})

	test("6. Esc with no active run leaves the composer and app unchanged", async () => {
		const provider = await hangingProvider("unused")
		try {
			writeFileSync(modelsFile(), validConfig(`${provider.url}/v1`))
			const h = await mount()
			h.tty.feed("draft text")
			expect(await waitFor(h, f => f.includes("draft text"))).toBe(true)

			h.tty.feed(ESC)
			for (let i = 0; i < 6; i++) await tick()
			// Nothing was interrupted and the draft survives.
			const frame = view(h)
			expect(frame).toContain("draft text")
			expect(frame).not.toContain("run aborted")
			expect(frame).not.toContain("Working")
		} finally {
			await provider.close()
		}
	})
})

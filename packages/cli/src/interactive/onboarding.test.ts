/**
 * First-run onboarding through the real TUI.
 *
 * These tests mount the actual `LoongCodeTui` against a mock terminal, with the
 * configuration directory redirected to a temporary directory, and drive the
 * real submission, command and setup paths. Nothing here reimplements the
 * application: the pickers are the application's pickers, the wizard is the
 * registered `/model` command, and the assertions read the rendered screen,
 * the composer and the filesystem.
 *
 * An unhandled rejection is the failure this suite exists to prevent — Bun
 * terminates the process on one, which is exactly how an unreadable
 * configuration used to kill the TUI. Collecting them turns that crash into a
 * readable assertion.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Terminal } from "@loongcode/tui"
import { LoongCode, type Session } from "@loongcode/agent"
import { LoongCodeTui, modelReadiness } from "./app"
import { parseScreen } from "./view/testing"
import { openaiChunk, sse, startMockProvider } from "../../../model/src/test-support"

const ENTER = "\r"
const ESC = "\x1b"

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

let root: string
let ws: string
let configDir: string
let sessionsDir: string
let priorConfigDir: string | undefined

const rejections: unknown[] = []
const recordRejection = (reason: unknown): void => {
	rejections.push(reason)
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "loongcode-onboarding-"))
	ws = join(root, "ws")
	configDir = join(root, "config")
	sessionsDir = join(root, "sessions")
	mkdirSync(ws)
	mkdirSync(configDir)
	mkdirSync(sessionsDir)
	priorConfigDir = process.env.LOONGCODE_CONFIG_DIR
	process.env.LOONGCODE_CONFIG_DIR = configDir
	rejections.length = 0
	process.on("unhandledRejection", recordRejection)
})

afterEach(() => {
	process.off("unhandledRejection", recordRejection)
	if (priorConfigDir === undefined) delete process.env.LOONGCODE_CONFIG_DIR
	else process.env.LOONGCODE_CONFIG_DIR = priorConfigDir
	rmSync(root, { recursive: true, force: true })
})

interface Harness {
	readonly agent: LoongCode
	readonly session: Session
	readonly app: LoongCodeTui
	readonly tty: Tty
}

const flush = async (times = 8): Promise<void> => {
	for (let i = 0; i < times; i++) await new Promise(r => setTimeout(r, 1))
}

/** Mounts the app the way `runCli` does: readiness resolved before construction. */
async function mount(options: { workspace?: string } = {}): Promise<Harness> {
	const agent = new LoongCode({ sessionsDir })
	const session = agent.createSession(options.workspace ?? ws)
	const tty = createTerminal()
	const app = new LoongCodeTui({
		agent,
		session,
		terminal: tty.terminal,
		label: session.cwd,
		readiness: await modelReadiness(agent),
	})
	app.start()
	await flush()
	return { agent, session, app, tty }
}

/** Forces a frame and returns it as plain text rows. */
function screen(h: Harness): string {
	h.tty.writes.length = 0
	;(h.app as unknown as { tui: { renderNow(force?: boolean): void } }).tui.renderNow(true)
	return parseScreen(h.tty.writes.join(""), 30).join("\n")
}

/** The composer's current text. */
function composer(h: Harness): string {
	return (h.app as unknown as { editor: { getText(): string } }).editor.getText()
}

/** Submits a line the way a user does: type it, then press Enter. */
async function type(h: Harness, text: string): Promise<void> {
	h.tty.feed(text)
	await flush()
	h.tty.feed(ENTER)
	await flush(16)
}

const modelsFile = (): string => join(configDir, "models.json")

function writeModels(content: string): void {
	writeFileSync(modelsFile(), content)
}

/** One configured model, in the shape the wizard persists. */
const configuredModel = (id = "probe", endpoint = "http://127.0.0.1:9/v1"): Record<string, unknown> => ({
	id, name: id, protocol: "openai", endpoint,
	model: "probe-model", apiKey: "sk-dummy-not-a-real-key",
	contextWindow: 128000, maxOutputTokens: 8192,
})

const validConfig = (endpoint: string): string => JSON.stringify({
	version: 1,
	models: [configuredModel("probe", endpoint)],
	activeModelId: "probe",
})

// ---------------------------------------------------------------------------
// AC1 / AC4 — what the first frame says
// ---------------------------------------------------------------------------

describe("startup readiness", () => {
	test("an unconfigured installation is told how to get a model", async () => {
		const h = await mount()
		const view = screen(h)
		expect(view).toContain("No model is active — use /model to choose or add one.")
		// The footer states the same fact where a configured user reads a model id.
		expect(view).toContain("no model")
		// Nothing failed, so nothing is reported as a failure.
		expect(view).not.toContain("error:")
		expect(rejections).toEqual([])
	})

	test("a configured installation is told nothing about first-run setup", async () => {
		writeModels(validConfig("http://127.0.0.1:9/v1"))
		const h = await mount()
		const view = screen(h)
		expect(view).not.toContain("No model is active")
		expect(view).not.toContain("no model")
		expect(view).toContain("probe")
		expect(view).toContain("128k window")
		expect(rejections).toEqual([])
	})

	test("configured models with none selected are not described as unconfigured", async () => {
		// `ModelManager` accepts this state — models exist and none is active —
		// and the notice must not claim the configuration is empty.
		writeModels(JSON.stringify({ version: 1, models: [configuredModel()], activeModelId: null }))
		const h = await mount()
		const view = screen(h)
		expect(view).toContain("No model is active")
		expect(view).toContain("no model")
		expect(rejections).toEqual([])

		// And the configured model is genuinely on offer: `/model` lists it.
		await type(h, "/model")
		const picker = screen(h)
		expect(picker).toContain("probe")
		expect(picker).toContain("Add model…")
		expect(rejections).toEqual([])
	})

	test("a workspace that does not exist is reported without blocking startup", async () => {
		const missing = join(root, "gone")
		const h = await mount({ workspace: missing })
		const view = screen(h)
		expect(view).toContain("working directory does not exist")
		expect(view).toContain(missing)
		// Reported, not enforced: the footer still renders and the TUI works.
		expect(view).toContain("Idle")
		expect(rejections).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// AC2 / AC13 — a task submitted without a model
// ---------------------------------------------------------------------------

describe("a task submitted without a model", () => {
	test("opens the existing setup flow and keeps the task on cancellation", async () => {
		const h = await mount()
		await type(h, "fix the failing test")

		// The setup flow is the /model picker, not a second wizard.
		expect(screen(h)).toContain("Add model…")

		h.tty.feed(ESC)
		await flush(24)

		// Exactly the task: not lost, not doubled.
		expect(composer(h)).toBe("fix the failing test")
		// Nothing ran, and no orphan message was left in the transcript.
		expect(h.session.messages.length).toBe(0)
		expect(rejections).toEqual([])
	})

	test("keeps the task when the wizard is cancelled at one of its prompts", async () => {
		const h = await mount()
		await type(h, "fix the failing test")
		h.tty.feed(ENTER) // Add model…
		await flush(16)
		h.tty.feed(ENTER) // the protocol
		await flush(16)
		expect(screen(h)).toContain("endpoint (default")

		h.tty.feed(ESC)
		await flush(24)

		expect(composer(h)).toBe("fix the failing test")
		// Cancelling writes nothing at all.
		expect(existsSync(modelsFile())).toBe(false)
		expect(h.session.messages.length).toBe(0)
		expect(rejections).toEqual([])
	})

	test("setup then submission: the model is saved, the task is kept, the task runs", async () => {
		const provider = await startMockProvider(() => sse([
			openaiChunk({ role: "assistant", content: "All tests pass now." }, null),
			openaiChunk({}, "stop"),
			null,
		]))
		try {
			const h = await mount()
			await type(h, "fix the failing test")

			h.tty.feed(ENTER) // Add model…
			await flush(16)
			h.tty.feed(ENTER) // the protocol
			await flush(16)
			h.tty.feed(`${provider.url}/v1`)
			await flush()
			h.tty.feed(ENTER)
			await flush(16)
			h.tty.feed("probe-model")
			await flush()
			h.tty.feed(ENTER)
			await flush(16)
			h.tty.feed("sk-dummy-not-a-real-key")
			await flush()
			h.tty.feed(ENTER)
			await flush(16)
			h.tty.feed(ENTER) // commit: Add model
			await flush(24)

			// The model is on disk, and the task is back in the composer,
			// untouched — nothing runs by itself.
			expect(existsSync(modelsFile())).toBe(true)
			expect(JSON.parse(readFileSync(modelsFile(), "utf-8")).activeModelId).toBe("probe-model")
			expect(composer(h)).toBe("fix the failing test")
			expect(h.session.messages.length).toBe(0)

			// The user submits it, and it runs against the configured model.
			h.tty.feed(ENTER)
			await flush(80)
			expect(h.session.messages.length).toBeGreaterThan(0)
			expect(screen(h)).toContain("All tests pass now.")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("a cancelled api-key prompt leaves no secret in the composer", async () => {
		const h = await mount()
		await type(h, "/model")
		h.tty.feed(ENTER) // Add model…
		await flush(16)
		h.tty.feed(ENTER) // the protocol
		await flush(16)
		h.tty.feed("http://127.0.0.1:9/v1")
		await flush()
		h.tty.feed(ENTER)
		await flush(16)
		h.tty.feed("probe-model")
		await flush()
		h.tty.feed(ENTER)
		await flush(16)
		expect(screen(h)).toContain("api key:")

		// While the prompt is open the value is masked, never echoed.
		h.tty.feed("sk-dummy-secret-value")
		await flush(16)
		expect(screen(h)).not.toContain("sk-dummy-secret-value")

		h.tty.feed(ESC)
		await flush(24)

		// The prompt's content belongs to the prompt: cancelling must not leave
		// it sitting in the composer, unmasked, for the next screenshot.
		expect(composer(h)).toBe("")
		expect(screen(h)).not.toContain("sk-dummy-secret-value")
		expect(existsSync(modelsFile())).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// AC5 / AC6 — configurations that cannot be read
// ---------------------------------------------------------------------------

describe("an unusable configuration", () => {
	const cases: Array<{ name: string; content: string; expect: RegExp; unreadable?: boolean }> = [
		{ name: "malformed JSON", content: "{ this is not json", expect: /malformed JSON/ },
		{
			name: "a file that cannot be read",
			content: validConfig("http://127.0.0.1:9/v1"),
			expect: /cannot read model configuration file/,
			unreadable: true,
		},
		{
			name: "an active model that does not exist",
			content: '{"version":1,"models":[],"activeModelId":"ghost"}',
			expect: /activeModelId/,
		},
		{
			name: "an unsupported version",
			content: '{"version":2,"models":[],"activeModelId":null}',
			expect: /unsupported version/,
		},
	]

	for (const testCase of cases) {
		test(`${testCase.name}: reported, preserved, and not mistaken for an empty installation`, async () => {
			// Permissions do not restrain root, so the unreadable case cannot be
			// staged there. Every other assertion in this suite still applies.
			const isRoot = typeof process.getuid === "function" && process.getuid() === 0
			if (testCase.unreadable && isRoot) return

			writeModels(testCase.content)
			if (testCase.unreadable === true) chmodSync(modelsFile(), 0o000)
			const before = statSync(modelsFile()).size

			try {
				const h = await mount()
				const view = screen(h)
				// Explained, with the file named...
				expect(view).toContain("error:")
				expect(view).toMatch(testCase.expect)
				expect(view).toContain("models.json")
				// ...and NOT presented as an installation that simply has no
				// model: that would invite setup the unreadable file blocks.
				expect(view).not.toContain("No model is active")
				expect(rejections).toEqual([])

				// Still responsive: a command is accepted and answered.
				await type(h, "/help")
				expect(screen(h)).toContain("/compact")
				expect(rejections).toEqual([])
			} finally {
				if (testCase.unreadable === true) chmodSync(modelsFile(), 0o600)
			}

			// The user's file is exactly as they left it.
			expect(readFileSync(modelsFile(), "utf-8")).toBe(testCase.content)
			expect(statSync(modelsFile()).size).toBe(before)
		})
	}

	test("a task submitted against an unreadable configuration reports it and keeps the task", async () => {
		writeModels("{ this is not json")
		const h = await mount()
		await type(h, "fix the failing test")

		const view = screen(h)
		expect(view).toContain("malformed JSON")
		// No setup is offered: it could not save.
		expect(view).not.toContain("Add model…")
		expect(composer(h)).toBe("fix the failing test")
		expect(h.session.messages.length).toBe(0)
		expect(rejections).toEqual([])
		// Untouched, byte for byte.
		expect(readFileSync(modelsFile(), "utf-8")).toBe("{ this is not json")
	})
})

// ---------------------------------------------------------------------------
// AC9 — a run that cannot be prepared
// ---------------------------------------------------------------------------

describe("recovery", () => {
	test("a failure while preparing a run restores idle, and the next task runs", async () => {
		const provider = await startMockProvider(() => sse([
			openaiChunk({ role: "assistant", content: "done" }, null),
			openaiChunk({}, "stop"),
			null,
		]))
		try {
			writeModels(validConfig(`${provider.url}/v1`))
			const h = await mount()

			// The check in `submit` passes; the refresh inside the run's own
			// prelude throws. That is the failure that used to leave the TUI
			// marked as running forever, swallowing every later task as steering.
			const agent = h.agent as unknown as { currentModel(): Promise<unknown> }
			const real = agent.currentModel.bind(h.agent)
			let failIn = -1
			agent.currentModel = async () => {
				if (failIn === 0) throw new Error("probe: run prelude failure")
				if (failIn > 0) failIn -= 1
				return real()
			}
			failIn = 1

			await type(h, "do the thing")
			const view = screen(h)
			expect(view).toContain("probe: run prelude failure")
			expect(view).toContain("Idle")
			expect(view).not.toContain("Working")

			// And the next task is a task, not a steering instruction.
			failIn = -1
			await type(h, "do the thing again")
			await flush(40)
			expect(h.session.messages.filter(m => m.role === "user").length).toBe(1)
			expect(screen(h)).toContain("done")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})
})

// ---------------------------------------------------------------------------
// AC11 — the model key
// ---------------------------------------------------------------------------

describe("Ctrl+P", () => {
	test("with nothing configured it points at /model rather than miscounting", async () => {
		const h = await mount()
		h.tty.feed("\x10") // ctrl+p
		await flush(16)
		const view = screen(h)
		expect(view).toContain("No model is active")
		expect(view).not.toContain("only one model configured")
		expect(rejections).toEqual([])
	})

	test("with one model configured it says so", async () => {
		writeModels(validConfig("http://127.0.0.1:9/v1"))
		const h = await mount()
		h.tty.feed("\x10")
		await flush(16)
		expect(screen(h)).toContain("only one model configured")
		expect(rejections).toEqual([])
	})

	test("a switch that cannot be persisted is reported, not thrown", async () => {
		// Two models is the only configuration in which a switch is attempted.
		writeModels(JSON.stringify({
			version: 1,
			models: [configuredModel("first"), configuredModel("second")],
			activeModelId: "first",
		}))
		const h = await mount()

		// The keypress runs on a promise nobody awaits: an escaping rejection
		// would end the process rather than the switch. No production seam is
		// added for this — the failure is injected at the agent boundary the
		// application already calls.
		const agent = h.agent as unknown as { activateModel(id: string): Promise<void> }
		const real = agent.activateModel.bind(h.agent)
		let fail = true
		agent.activateModel = async (id: string) => {
			if (fail) throw new Error("probe: the switch could not be persisted")
			return real(id)
		}

		h.tty.feed("\x10")
		await flush(16)
		const view = screen(h)
		expect(view).toContain("probe: the switch could not be persisted")
		// No switch is claimed, and the footer still names the model in use.
		expect(view).not.toContain("switched model: second")
		expect(view).toContain("first")
		expect(rejections).toEqual([])

		// Still usable, and a switch that works still works.
		fail = false
		h.tty.feed("\x10")
		await flush(24)
		expect(screen(h)).toContain("switched model: second")
		expect(rejections).toEqual([])
	})
})

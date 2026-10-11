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
import { LoongCodeTui, SETUP_TEST_TIMEOUT_MS, modelReadiness } from "./app"
import { parseScreen } from "./view/testing"
import {
	anthropicTextResponse,
	openaiChunk,
	openaiTextResponse,
	sse,
	startMockProvider,
} from "../../../model/src/test-support"

/**
 * What a provider answers.
 *
 * The setup sequence probes with a complete request (no streaming), while a
 * task run streams — one mock serves both, so a test can configure a model and
 * then use it. The non-streaming body is shaped for the protocol the request
 * was made on, which is also how a test tells the two adapters apart.
 */
function providerReply(path: string, body: unknown): Response {
	const streamed = typeof body === "object" && body !== null &&
		(body as { stream?: unknown }).stream === true
	if (streamed) {
		return sse([
			openaiChunk({ role: "assistant", content: "All tests pass now." }, null),
			openaiChunk({}, "stop"),
			null,
		])
	}
	return path.endsWith("/messages") ? anthropicTextResponse("pong") : openaiTextResponse("pong")
}

const ENTER = "\r"
const ESC = "\x1b"
const DOWN = "\x1b[B"
const UP = "\x1b[A"
/** Delete to line start — the editor's own key for clearing a seeded field. */
const CTRL_U = "\x15"

interface SetupInput {
	readonly protocol?: "openai" | "anthropic"
	readonly endpoint: string
	readonly apiKey?: string
	readonly model?: string
}

/**
 * Walks the approved sequence: protocol, address, key, model identifier, and
 * the connection test that follows — stopping on the screen the test produced.
 */
async function driveSetupToTest(h: Harness, input: SetupInput): Promise<void> {
	// Step 1 — protocol. The first row is `OpenAI-compatible`.
	if (input.protocol === "anthropic") {
		h.tty.feed(DOWN)
		await flush(8)
	}
	h.tty.feed(ENTER)
	await flush(16)
	// Step 2 — the address, seeded with the protocol's own default.
	h.tty.feed(CTRL_U)
	await flush(4)
	h.tty.feed(input.endpoint)
	await flush()
	h.tty.feed(ENTER)
	await flush(16)
	// Step 3 — the key.
	h.tty.feed(input.apiKey ?? "sk-dummy-not-a-real-key")
	await flush()
	h.tty.feed(ENTER)
	await flush(16)
	// Step 4 — the model identifier, and the test it triggers.
	h.tty.feed(input.model ?? "probe-model")
	await flush()
	h.tty.feed(ENTER)
	await flush(80)
}

/** The whole sequence, through the explicit save. */
async function driveSetupToSaved(h: Harness, input: SetupInput): Promise<void> {
	await driveSetupToTest(h, input)
	h.tty.feed(ENTER) // `Save and Enter Workspace`, the first row
	await flush(60)
}

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
async function mount(options: { workspace?: string; session?: Session } = {}): Promise<Harness> {
	const agent = new LoongCode({ sessionsDir })
	const session = options.session ?? agent.createSession(options.workspace ?? ws)
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

/** Which interface the application is in: `normal` or `setup`. */
function phaseOf(h: Harness): string {
	return (h.app as unknown as { phase: string }).phase
}

/** Whether the composer is the component the bottom slot renders. */
function slotHoldsEditor(h: Harness): boolean {
	const app = h.app as unknown as { editorSlot: { children: unknown[] }; editor: unknown }
	return app.editorSlot.children.includes(app.editor)
}

/**
 * Records `process.exit` and stderr instead of performing them, so a test can
 * drive a path that leaves the session. The exit is still requested — only the
 * process is not ended — and what the caller would have seen is captured.
 */
function trapExit(): { codes: number[]; errors: string[]; restore: () => void } {
	const codes: number[] = []
	const errors: string[] = []
	const originalExit = process.exit
	const originalWrite = process.stderr.write
	process.exit = ((code?: number) => {
		codes.push(code ?? 0)
	}) as never
	process.stderr.write = ((chunk: unknown) => {
		errors.push(String(chunk))
		return true
	}) as never
	return {
		codes,
		errors,
		restore: () => {
			process.exit = originalExit
			process.stderr.write = originalWrite
		},
	}
}

/** A command or shortcut that must do nothing while the gate is closed. */
async function attemptBypass(h: Harness, input: string): Promise<void> {
	h.tty.feed(input)
	await flush()
	h.tty.feed(ENTER)
	await flush(16)
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

describe("the gate", () => {
	test("an unconfigured installation opens the setup screen, not the workspace", async () => {
		const h = await mount()
		const view = screen(h)
		// The gate is open, and what it shows is the first step of the sequence.
		expect(phaseOf(h)).toBe("setup")
		expect(view).toContain("Model Setup")
		expect(view).toContain("Configure your model")
		expect(view).toContain("Select API protocol")
		expect(slotHoldsEditor(h)).toBe(false)
		// No banner, no composer, no idle state: none of the workspace is here.
		expect(view).not.toContain("an opinionated coding agent")
		expect(view).not.toContain("Idle")
		// The footer states the one fact that matters, and nothing it measured.
		expect(view).toContain("no model")
		expect(view).toContain("Model setup in progress")
		expect(view).not.toContain("error:")
		expect(rejections).toEqual([])
	})

	test("the protocol menu is exactly the two compatible protocols", async () => {
		const h = await mount()
		const view = screen(h)
		expect(view).toContain("OpenAI-compatible")
		expect(view).toContain("Anthropic-compatible")
		// No vendor-name choices, and no third protocol.
		expect(view).not.toContain("OpenAI API")
		expect(view).not.toContain("Anthropic API")
		expect(view).not.toContain("Google")
		expect(rejections).toEqual([])
	})

	test("a configured installation is told nothing about first-run setup", async () => {
		writeModels(validConfig("http://127.0.0.1:9/v1"))
		const h = await mount()
		const view = screen(h)
		expect(phaseOf(h)).toBe("normal")
		expect(view).not.toContain("No model is active")
		expect(view).not.toContain("no model")
		expect(view).not.toContain("Select API protocol")
		expect(slotHoldsEditor(h)).toBe(true)
		// Suppression belongs to setup alone: a configured user still gets the
		// startup banner they always had.
		expect(view).toContain("an opinionated coding agent")
		expect(view).toContain("probe")
		expect(view).toContain("128k window")
		expect(rejections).toEqual([])
	})

	test("configured models with none active still require the sequence", async () => {
		// `ModelManager` accepts this state — models exist and none is active.
		// The gate is shut either way, and what it shows is protocol selection:
		// the approved sequence has no "pick an existing one" step.
		const config = JSON.stringify({ version: 1, models: [configuredModel()], activeModelId: null })
		writeModels(config)
		const h = await mount()
		const view = screen(h)
		expect(phaseOf(h)).toBe("setup")
		expect(view).toContain("Select API protocol")
		expect(view).toContain("no model")
		expect(rejections).toEqual([])

		// The configuration the user already had is not touched by looking at it.
		expect(readFileSync(modelsFile(), "utf-8")).toBe(config)
	})

	test("a workspace that does not exist is reported without blocking startup", async () => {
		const missing = join(root, "gone")
		const h = await mount({ workspace: missing })
		const view = screen(h)
		expect(view).toContain("working directory does not exist")
		expect(view).toContain(missing)
		// Reported, not enforced: the footer still renders — with the path and
		// the setup state, not a workspace that is not open.
		expect(view).toContain("no model")
		expect(view).toContain("Model setup in progress")
		expect(rejections).toEqual([])
	})

	test("a resumed session's history stays out of sight while the gate is closed", async () => {
		const provider = await startMockProvider(() => sse([
			openaiChunk({ role: "assistant", content: "HISTORY-MARKER" }, null),
			openaiChunk({}, "stop"),
			null,
		]))
		try {
			writeModels(validConfig(`${provider.url}/v1`))
			const first = await mount()
			await type(first, "the earlier task")
			await flush(40)
			expect(screen(first)).toContain("HISTORY-MARKER")

			// The model goes away and the same session is mounted again, as a
			// restart would: the transcript must not come with it.
			rmSync(modelsFile(), { force: true })
			const resumed = await mount({ session: first.session })
			const view = screen(resumed)
			expect(resumed.session.messages.length).toBeGreaterThan(0)
			expect(view).not.toContain("HISTORY-MARKER")
			expect(view).not.toContain("the earlier task")
			// No banner either: the setup screen is composed instead of the
			// empty-workspace hero, not on top of it.
			expect(view).not.toContain("an opinionated coding agent")
			expect(view).toContain("Select API protocol")
			expect(phaseOf(resumed)).toBe("setup")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("a previous session's run statistics stay out of the setup footer", async () => {
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
		try {
			// A session that has genuinely run: its figures are on the footer
			// while the workspace is open...
			writeModels(validConfig(`${provider.url}/v1`))
			const working = await mount()
			await type(working, "the earlier task")
			await flush(40)
			expect(screen(working)).toContain("last run")

			// ...and must not follow it into setup.
			rmSync(modelsFile(), { force: true })
			const resumed = await mount({ session: working.session })
			const view = screen(resumed)
			expect(phaseOf(resumed)).toBe("setup")
			expect(view).not.toContain("last run")
			expect(view).not.toContain("no run yet")
			expect(view).not.toContain("Context")
			expect(view).not.toContain("auto-compact")
			expect(view).not.toContain("Idle")
			// What is left is neutral and true.
			expect(view).toContain("Model setup in progress")
			expect(view).toContain("no model")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("the workspace's footer information returns with the transition", async () => {
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
		try {
			writeModels(validConfig(`${provider.url}/v1`))
			const h = await mount()
			// A real run first, so there are figures to withhold.
			await type(h, "the earlier task")
			await flush(40)
			expect(screen(h)).toContain("last run")

			// The model goes away, and the next task is held by the gate.
			rmSync(modelsFile(), { force: true })
			await type(h, "a held task")
			expect(phaseOf(h)).toBe("setup")
			expect(screen(h)).toContain("Model setup in progress")
			expect(screen(h)).not.toContain("last run")

			// Complete setup: the figures the working session showed are back,
			// because they were never erased — only withheld.
			await driveSetupToSaved(h, { endpoint: `${provider.url}/v1` })

			const after = screen(h)
			expect(phaseOf(h)).toBe("normal")
			expect(after).toContain("last run")
			expect(after).not.toContain("Model setup in progress")
			expect(after).toContain("Idle")
			expect(after).toContain("Context")
			// And the task that was held comes back with it, unrun.
			expect(composer(h)).toBe("a held task")
			expect(h.session.messages.filter(m => m.role === "user").length).toBe(1)
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("the composer is not there to type into while the gate is closed", async () => {
		const h = await mount()
		expect(slotHoldsEditor(h)).toBe(false)

		// Typing lands nowhere: no transcript line, no submission, no run.
		await type(h, "a task with nowhere to go")
		expect(screen(h)).not.toContain("a task with nowhere to go")
		expect(h.session.messages.length).toBe(0)
		expect(phaseOf(h)).toBe("setup")
		expect(rejections).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// AC2 / AC13 — a task submitted without a model
// ---------------------------------------------------------------------------

describe("a model that goes away under a running session", () => {
	/** A session that started with a working model, whose configuration is then
	 *  removed — the only way to reach a submission without one now. */
	async function lostModel(): Promise<Harness> {
		writeModels(validConfig("http://127.0.0.1:9/v1"))
		const h = await mount()
		rmSync(modelsFile(), { force: true })
		return h
	}

	test("closes the gate again and holds the task, without running it", async () => {
		const h = await lostModel()
		await type(h, "fix the failing test")

		expect(phaseOf(h)).toBe("setup")
		// The task is held and visibly so — it is not in a composer the user
		// cannot see.
		expect(screen(h)).toContain("Your task is saved: fix the failing test")
		expect(composer(h)).toBe("")
		expect(h.session.messages.length).toBe(0)
		expect(rejections).toEqual([])
	})

	test("completing setup restores the task, and only the user runs it", async () => {
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
		try {
			const h = await lostModel()
			await type(h, "fix the failing test")
			expect(phaseOf(h)).toBe("setup")

			await driveSetupToSaved(h, { endpoint: `${provider.url}/v1` })

			// The gate is open and the task is back in the composer — not run.
			expect(phaseOf(h)).toBe("normal")
			expect(slotHoldsEditor(h)).toBe(true)
			expect(composer(h)).toBe("fix the failing test")
			expect(h.session.messages.length).toBe(0)
			expect(existsSync(modelsFile())).toBe(true)

			// The user submits it, and only then does it run.
			h.tty.feed(ENTER)
			await flush(80)
			expect(h.session.messages.length).toBeGreaterThan(0)
			expect(screen(h)).toContain("All tests pass now.")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("cancelling exits, and says the held task was neither run nor saved", async () => {
		const trap = trapExit()
		try {
			const h = await lostModel()
			await type(h, "fix the failing test")
			expect(phaseOf(h)).toBe("setup")

			h.tty.feed(ESC) // cancel the setup flow
			await flush(24)
			// The setup flow does not reopen on its own: the user chooses.
			expect(screen(h)).toContain("Exit")

			h.tty.feed(DOWN)
			await flush()
			h.tty.feed(ENTER)
			await flush(24)

			expect(trap.codes).toEqual([0])
			expect(trap.errors.join("")).toContain("your task was not run and has not been saved")
			// Never admitted to the normal interface.
			expect(phaseOf(h)).toBe("setup")
			expect(h.session.messages.length).toBe(0)
			expect(rejections).toEqual([])
		} finally {
			trap.restore()
		}
	})
})

// ---------------------------------------------------------------------------
// AC3 — the first-run path through the gate
// ---------------------------------------------------------------------------

describe("first-run setup through the gate", () => {
	test("the sequence is offered unasked, and the normal interface follows it", async () => {
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
		try {
			const h = await mount()
			// The sequence is already open on its first step.
			expect(phaseOf(h)).toBe("setup")
			expect(screen(h)).toContain("Select API protocol")

			await driveSetupToSaved(h, { endpoint: `${provider.url}/v1` })

			expect(phaseOf(h)).toBe("normal")
			expect(slotHoldsEditor(h)).toBe(true)
			expect(composer(h)).toBe("")
			expect(JSON.parse(readFileSync(modelsFile(), "utf-8")).activeModelId).toBe("probe-model")
			expect(h.session.messages.length).toBe(0)

			// The user types their first task into a composer that now exists.
			await type(h, "fix the failing test")
			await flush(80)
			expect(h.session.messages.length).toBeGreaterThan(0)
			expect(screen(h)).toContain("All tests pass now.")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("the API key is masked, and never left behind", async () => {
		const h = await mount()
		h.tty.feed(ENTER) // step 1: OpenAI-compatible
		await flush(16)
		h.tty.feed(CTRL_U)
		await flush(4)
		h.tty.feed("http://127.0.0.1:9/v1")
		await flush()
		h.tty.feed(ENTER)
		await flush(16)
		expect(screen(h)).toContain("Step 3/5")
		expect(screen(h)).toContain("API Key")

		// While the field is open the value is masked, never echoed.
		h.tty.feed("sk-dummy-secret-value")
		await flush(16)
		expect(screen(h)).not.toContain("sk-dummy-secret-value")
		expect(screen(h)).toContain("***")

		h.tty.feed(ESC) // back to the address step
		await flush(24)

		// The field's content belongs to the field: leaving it must not leave
		// the key sitting anywhere, unmasked, for the next screenshot...
		expect(screen(h)).not.toContain("sk-dummy-secret-value")
		expect(composer(h)).not.toContain("sk-dummy-secret-value")
		// ...while what the user did enter earlier comes back with the step.
		expect(composer(h)).toBe("http://127.0.0.1:9/v1")
		expect(existsSync(modelsFile())).toBe(false)
		expect(rejections).toEqual([])
	})
})

/**
 * Runs `body` with the probe's own timeout fired immediately.
 *
 * The timeout is what is under test, and waiting its real duration would make
 * the suite unusable. Only that one delay is compressed — every other timer in
 * the process keeps its real duration — and the timers it created are counted
 * so a test can prove they were also cleared.
 */
async function withImmediateProbeTimeout<T>(
	body: () => Promise<T>,
): Promise<{ result: T; created: number; cleared: number }> {
	const realSetTimeout = globalThis.setTimeout
	const realClearTimeout = globalThis.clearTimeout
	const probeTimers = new Set<unknown>()
	let created = 0
	let cleared = 0
	globalThis.setTimeout = ((fn: () => void, ms?: number) => {
		if (ms !== SETUP_TEST_TIMEOUT_MS) return realSetTimeout(fn, ms)
		created += 1
		const id = realSetTimeout(fn, 0)
		probeTimers.add(id)
		return id
	}) as unknown as typeof setTimeout
	globalThis.clearTimeout = ((id?: unknown) => {
		if (probeTimers.has(id)) cleared += 1
		realClearTimeout(id as never)
	}) as typeof clearTimeout
	try {
		return { result: await body(), created, cleared }
	} finally {
		globalThis.setTimeout = realSetTimeout
		globalThis.clearTimeout = realClearTimeout
	}
}

// ---------------------------------------------------------------------------
// The connection test — a real request, or no way forward
// ---------------------------------------------------------------------------

describe("the model test", () => {
	test("sends a real request through the selected protocol's adapter", async () => {
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
		try {
			const h = await mount()
			await driveSetupToTest(h, { endpoint: `${provider.url}/v1` })

			// A request actually arrived, shaped like the protocol chosen.
			expect(provider.requests.length).toBeGreaterThan(0)
			expect(provider.requests.at(-1)!.path).toBe("/v1/chat/completions")
			expect(screen(h)).toContain("✓ Model test succeeded")
			expect(screen(h)).toContain("OpenAI-compatible")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("uses the Anthropic adapter when Anthropic is chosen", async () => {
		// The label is not the evidence: the path the request lands on is, and
		// the two adapters speak different wire protocols.
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
		try {
			const h = await mount()
			await driveSetupToTest(h, { protocol: "anthropic", endpoint: `${provider.url}/v1` })

			expect(provider.requests.at(-1)!.path).toBe("/v1/messages")
			expect(screen(h)).toContain("✓ Model test succeeded")
			expect(screen(h)).toContain("Anthropic-compatible")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("a passing test saves nothing until the user confirms", async () => {
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
		try {
			const h = await mount()
			await driveSetupToTest(h, { endpoint: `${provider.url}/v1` })
			expect(screen(h)).toContain("✓ Model test succeeded")
			// A successful call is not a save.
			expect(existsSync(modelsFile())).toBe(false)

			// Nor is declining to save: choosing to edit leaves nothing behind.
			h.tty.feed(DOWN)
			await flush(8)
			h.tty.feed(ENTER) // Return to Edit Configuration
			await flush(24)
			expect(screen(h)).toContain("Step 4/5")
			expect(composer(h)).toBe("probe-model")
			expect(existsSync(modelsFile())).toBe(false)
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("a failed test offers no way to save, and keeps the configuration", async () => {
		const provider = await startMockProvider(() =>
			new Response(
				JSON.stringify({ error: { message: "Incorrect API key provided: sk-dummy-not-a-real-key." } }),
				{ status: 401, headers: { "content-type": "application/json" } },
			))
		try {
			const h = await mount()
			await driveSetupToTest(h, { endpoint: `${provider.url}/v1` })

			const view = screen(h)
			expect(view).toContain("✗ Model test failed")
			expect(view).toContain("Authentication failed")
			// The save action does not exist on this screen.
			expect(view).not.toContain("Save and Enter Workspace")
			// The credential the provider echoed back is nowhere on screen.
			expect(view).not.toContain("sk-dummy-not-a-real-key")
			expect(existsSync(modelsFile())).toBe(false)

			// The configuration is retained: editing returns to the field.
			h.tty.feed(ENTER) // Return to Edit Configuration, the first row
			await flush(24)
			expect(screen(h)).toContain("Step 4/5")
			expect(composer(h)).toBe("probe-model")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("a cancelled test is a failure, never a success", async () => {
		// A provider that accepts the request and never answers.
		const provider = await startMockProvider(() => new Promise<Response>(() => {}))
		try {
			const h = await mount()
			h.tty.feed(ENTER) // step 1
			await flush(16)
			h.tty.feed(CTRL_U)
			await flush(4)
			h.tty.feed(`${provider.url}/v1`)
			await flush()
			h.tty.feed(ENTER)
			await flush(16)
			h.tty.feed("sk-dummy-not-a-real-key")
			await flush()
			h.tty.feed(ENTER)
			await flush(16)
			h.tty.feed("probe-model")
			await flush()
			h.tty.feed(ENTER) // the test starts, and hangs
			await flush(40)
			expect(screen(h)).toContain("Testing model…")

			h.tty.feed(ESC) // cancel it
			await flush(40)

			const view = screen(h)
			expect(view).toContain("✗ Model test failed")
			expect(view).toContain("cancelled")
			expect(view).not.toContain("Save and Enter Workspace")
			expect(existsSync(modelsFile())).toBe(false)
			expect(phaseOf(h)).toBe("setup")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("a probe that outlives the timeout fails, and a late answer cannot revive it", async () => {
		// The provider answers, but well after the timeout has already fired.
		const provider = await startMockProvider(() =>
			new Promise<Response>(resolve => {
				setTimeout(() => resolve(openaiTextResponse("late")), 400)
			}))
		try {
			const h = await mount()
			const { created, cleared } = await withImmediateProbeTimeout(() =>
				driveSetupToTest(h, { endpoint: `${provider.url}/v1` }))

			const view = screen(h)
			expect(view).toContain("✗ Model test failed")
			expect(view).toContain("timed out")
			expect(view).not.toContain("Save and Enter Workspace")
			// The timer that carried the deadline is not left behind.
			expect(created).toBe(1)
			expect(cleared).toBe(1)

			// The response that arrives afterwards is not a result: the request
			// was aborted, and a success screen cannot appear late.
			await flush(200)
			const after = screen(h)
			expect(after).toContain("✗ Model test failed")
			expect(after).not.toContain("Save and Enter Workspace")
			expect(existsSync(modelsFile())).toBe(false)
			expect(phaseOf(h)).toBe("setup")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("the provider's own words reach the user", async () => {
		// A rejected model identifier comes back as a failed request — the
		// adapter does not have a code for it — so the detail line is where the
		// difference between a wrong model and an unreachable host survives.
		const provider = await startMockProvider(() =>
			new Response(
				JSON.stringify({ error: { message: "The model `nope-9000` does not exist", type: "invalid_request_error" } }),
				{ status: 400, headers: { "content-type": "application/json" } },
			))
		try {
			const h = await mount()
			await driveSetupToTest(h, { endpoint: `${provider.url}/v1`, model: "nope-9000" })

			const view = screen(h)
			expect(view).toContain("✗ Model test failed")
			expect(view).toContain("does not exist")
			expect(view).not.toContain("Save and Enter Workspace")
			expect(existsSync(modelsFile())).toBe(false)
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("a configuration that cannot be persisted keeps the user in setup", async () => {
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
		try {
			const h = await mount()
			await driveSetupToTest(h, { endpoint: `${provider.url}/v1` })

			const agent = h.agent as unknown as { configureModel(config: unknown): Promise<void> }
			agent.configureModel = async () => {
				throw new Error("probe: could not write models.json")
			}
			h.tty.feed(ENTER) // Save and Enter Workspace
			await flush(40)

			const view = screen(h)
			expect(view).toContain("✗ Could not save the configuration")
			expect(view).toContain("probe: could not write models.json")
			// No success is claimed, and the workspace is not entered.
			expect(phaseOf(h)).toBe("setup")
			expect(view).not.toContain("Idle")
			expect(existsSync(modelsFile())).toBe(false)
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})
})

// ---------------------------------------------------------------------------
// The other way in: /model → Add model…
// ---------------------------------------------------------------------------

describe("adding a model from the workspace", () => {
	test("runs the same sequence, and the workspace comes back", async () => {
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
		try {
			writeModels(validConfig(`${provider.url}/v1`))
			const h = await mount()
			expect(phaseOf(h)).toBe("normal")

			// `/model` → `Add model…` — the workspace command takes over the
			// screen with the one configuration sequence there is.
			await type(h, "/model")
			h.tty.feed(DOWN)
			await flush(8)
			h.tty.feed(ENTER)
			await flush(24)
			expect(phaseOf(h)).toBe("setup")
			expect(screen(h)).toContain("Select API protocol")

			// A model name that is not already configured, so no id conflict.
			await driveSetupToSaved(h, { endpoint: `${provider.url}/v1`, model: "second-model" })

			expect(phaseOf(h)).toBe("normal")
			expect(slotHoldsEditor(h)).toBe(true)
			const saved = JSON.parse(readFileSync(modelsFile(), "utf-8"))
			expect(saved.models.map((m: { id: string }) => m.id)).toEqual(["probe", "second-model"])
			expect(saved.activeModelId).toBe("second-model")
			expect(screen(h)).toContain("second-model")
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
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
				// model: that would invite the setup flow the unreadable file
				// would then block.
				expect(view).not.toContain("No model is active")

				// The gate is closed, and the recovery on offer is retry-or-exit.
				// The wizard is never opened here: every write path loads the
				// file first, so it could not save.
				expect(phaseOf(h)).toBe("setup")
				const recovery = screen(h)
				expect(recovery).toContain("LoongCode cannot read your model configuration.")
				expect(recovery).toContain("Retry")
				expect(recovery).toContain("Exit")
				// The setup sequence is never offered here: it could not save.
				expect(recovery).not.toContain("Select API protocol")
				expect(rejections).toEqual([])
			} finally {
				if (testCase.unreadable === true) chmodSync(modelsFile(), 0o600)
			}

			// The user's file is exactly as they left it.
			expect(readFileSync(modelsFile(), "utf-8")).toBe(testCase.content)
			expect(statSync(modelsFile()).size).toBe(before)
		})
	}

	test("a configuration that breaks under a running session holds the task", async () => {
		// The session started with a working model, which is then corrupted —
		// the file is reported and preserved, never repaired.
		writeModels(validConfig("http://127.0.0.1:9/v1"))
		const h = await mount()
		writeModels("{ this is not json")
		await type(h, "fix the failing test")

		const view = screen(h)
		expect(view).toContain("malformed JSON")
		expect(phaseOf(h)).toBe("setup")
		// The task is held, not run and not lost.
		expect(view).toContain("Your task is saved: fix the failing test")
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
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
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
			expect(screen(h)).toContain("All tests pass now.")
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
	test("with nothing configured it changes nothing while the gate is closed", async () => {
		const h = await mount()
		const before = screen(h)
		h.tty.feed("\x10") // ctrl+p
		await flush(16)
		const view = screen(h)
		expect(view).not.toContain("only one model configured")
		expect(view).not.toContain("switched model")
		// The setup screen is still the setup screen.
		expect(view).toContain("Select API protocol")
		expect(view).toBe(before)
		expect(phaseOf(h)).toBe("setup")
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

// ---------------------------------------------------------------------------
// The gate has no bypass
// ---------------------------------------------------------------------------

describe("no bypass", () => {
	test("every slash command is refused while the gate is closed", async () => {
		const h = await mount()
		for (const command of ["/help", "/session", "/rewind", "/new", "/copy", "/compact", "/model"]) {
			await attemptBypass(h, command)
			expect(phaseOf(h)).toBe("setup")
			expect(h.session.messages.length).toBe(0)
		}
		// None of them produced its answer.
		const view = screen(h)
		expect(view).not.toContain("Commands:")
		expect(view).not.toContain("nothing to rewind to")
		expect(view).not.toContain("started a new session")
		expect(view).not.toContain("no agent response to copy")
		expect(rejections).toEqual([])
	})

	test("submit refuses tasks from any caller, not just the composer", async () => {
		// The composer is not even rendered, so the callers that matter are the
		// other two: a prompt template, and the command surface's `submitTask`.
		const h = await mount()
		const app = h.app as unknown as { submit(text: string): Promise<void> }
		await app.submit("/help")
		await app.submit("fix the failing test")
		await flush(16)

		expect(screen(h)).not.toContain("Commands:")
		expect(h.session.messages.length).toBe(0)
		expect(phaseOf(h)).toBe("setup")
		expect(rejections).toEqual([])
	})

	test("the shortcuts that act on the workspace are consumed and do nothing", async () => {
		// Two models and none active: the gate is closed, and a switch is
		// possible — so this is a state where acting would be visible. Both
		// shortcuts return `consume` whether or not they act, so the assertion
		// has to be about the effect.
		writeModels(JSON.stringify({
			version: 1,
			models: [configuredModel("first"), configuredModel("second")],
			activeModelId: null,
		}))
		const h = await mount()
		// Past the protocol list into the address field, which is the one state
		// where no selector owns the keyboard and the application's own
		// listener decides.
		h.tty.feed(ENTER) // step 1: OpenAI-compatible
		await flush(16)
		expect(screen(h)).toContain("Step 2/5")

		const app = h.app as unknown as {
			handleGlobalInput(data: string): { consume?: boolean } | undefined
			toolsExpanded: boolean
		}
		expect(app.handleGlobalInput("\x10")).toEqual({ consume: true }) // ctrl+p
		expect(app.handleGlobalInput("\x0f")).toEqual({ consume: true }) // ctrl+o
		await flush(16)

		const view = screen(h)
		expect(view).not.toContain("switched model")
		expect(view).not.toContain("only one model configured")
		expect(app.toolsExpanded).toBe(false)
		expect(phaseOf(h)).toBe("setup")
		expect(rejections).toEqual([])
	})

	test("the interactions setup itself needs still work", async () => {
		const config = JSON.stringify({ version: 1, models: [configuredModel()], activeModelId: null })
		writeModels(config)
		const h = await mount()

		// Navigation: down to the second protocol, and choosing it moves on.
		h.tty.feed(DOWN)
		await flush(8)
		h.tty.feed(ENTER)
		await flush(16)
		expect(screen(h)).toContain("Step 2/5")

		// Escape goes back a step without answering it.
		h.tty.feed(ESC)
		await flush(24)
		expect(screen(h)).toContain("Select API protocol")
		expect(phaseOf(h)).toBe("setup")
		expect(readFileSync(modelsFile(), "utf-8")).toBe(config)
		expect(rejections).toEqual([])
	})

	test("Ctrl+D still leaves the session from inside a field", async () => {
		const trap = trapExit()
		try {
			const h = await mount()
			h.tty.feed(ENTER) // step 1: OpenAI-compatible
			await flush(16)
			expect(screen(h)).toContain("Step 2/5")
			// The field is seeded with the protocol's default, and Ctrl+D only
			// leaves an empty composer — so clear it first, as a user would.
			h.tty.feed(CTRL_U)
			await flush(8)

			h.tty.feed("\x04") // ctrl+d — leaves rather than answering
			await flush(16)
			expect(trap.codes).toEqual([0])
			expect(phaseOf(h)).toBe("setup")
			expect(rejections).toEqual([])
		} finally {
			trap.restore()
		}
	})
})

// ---------------------------------------------------------------------------
// Opening the gate is all-or-nothing
// ---------------------------------------------------------------------------

describe("opening the gate", () => {
	test("a failure while building the workspace view keeps the application in setup", async () => {
		const provider = await startMockProvider(({ path, body }) => providerReply(path, body))
		try {
			writeModels(validConfig(`${provider.url}/v1`))
			const h = await mount()
			// A run first, so the footer has figures that must stay hidden.
			await type(h, "the earlier task")
			await flush(40)
			expect(screen(h)).toContain("last run")

			// The model goes away, so the gate closes; then the workspace view
			// becomes unbuildable.
			rmSync(modelsFile(), { force: true })
			const app = h.app as unknown as { buildTranscript(): unknown[] }
			const real = app.buildTranscript.bind(h.app)
			let fail = true
			app.buildTranscript = () => {
				if (fail) throw new Error("probe: workspace view failure")
				return real()
			}

			await type(h, "fix the failing test")
			expect(phaseOf(h)).toBe("setup")
			expect(screen(h)).not.toContain("last run")

			// Setup succeeds — the model is active — but the interface cannot be
			// restored. The gate stays shut.
			await driveSetupToTest(h, { endpoint: `${provider.url}/v1` })
			h.tty.feed(ENTER) // Save and Enter Workspace
			await flush(60)

			const failed = screen(h)
			expect(failed).toContain("probe: workspace view failure")
			expect(phaseOf(h)).toBe("setup")
			expect(slotHoldsEditor(h)).toBe(false)
			// The footer stays isolated through the failed transition: the model
			// is active, but nothing the workspace produced is reported.
			expect(failed).toContain("Model setup in progress")
			expect(failed).not.toContain("last run")
			expect(failed).not.toContain("Idle")
			expect(h.session.messages.filter(m => m.role === "user").length).toBe(1)
			expect(rejections).toEqual([])

			// And it is recoverable rather than fatal: with the failure gone,
			// retrying opens the gate and hands the held task back.
			fail = false
			h.tty.feed(ENTER) // Retry, the first row
			await flush(30)
			expect(phaseOf(h)).toBe("normal")
			expect(slotHoldsEditor(h)).toBe(true)
			expect(composer(h)).toBe("fix the failing test")
			// The footer comes back with the transition.
			expect(screen(h)).toContain("last run")
			expect(screen(h)).toContain("Idle")
			expect(h.session.messages.filter(m => m.role === "user").length).toBe(1)
			expect(rejections).toEqual([])
		} finally {
			await provider.close()
		}
	})

	test("the gate cannot be opened by a configuration that is not ready", async () => {
		// The flow re-reads on every pass: a retry after an external fix goes
		// through, and a still-broken file does not.
		writeModels("{ this is not json")
		const h = await mount()
		expect(phaseOf(h)).toBe("setup")
		expect(screen(h)).toContain("Retry")

		// Repair the file behind the application's back, then retry.
		writeModels(validConfig("http://127.0.0.1:9/v1"))
		h.tty.feed(ENTER) // Retry, the first row
		await flush(30)

		expect(phaseOf(h)).toBe("normal")
		expect(slotHoldsEditor(h)).toBe(true)
		expect(rejections).toEqual([])
	})
})

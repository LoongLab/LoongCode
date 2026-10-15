import {
	Container,
	Editor,
	Loader,
	Markdown,
	Text,
	TuiAltScreen,
	WindowedStack,
	ProcessTerminal,
	type Terminal,
	matchesKey,
	type Component,
} from "@loongcode/tui"
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { ModelError, testModelConnection } from "@loongcode/model"
import type { Model, ModelConfig, ModelLimits, ModelMessage, ModelProtocol } from "@loongcode/model"
import type { Checkpoint, LoongCode, RewindNote, RunEvent, Session, SessionMessage } from "@loongcode/agent"
import { CheckpointStore } from "@loongcode/agent"
import { discardTurns, liveCheckpoints, recordRewind, rewindSession, summarizeRange, turnIndexOf, type CheckpointAdvance } from "@loongcode/agent"
import { configDir, listPromptTemplates, loadSettings } from "@loongcode/agent"
import { ansi, initTheme, markdownTheme, setThemeScheme, theme } from "./view/theme"
import {
	NO_RUN_DISPLAY,
	compactionNoticeText,
	compactionSkippedNoticeText,
	footerRows,
	projectionReducedNoticeText,
	reduceRunDisplay,
	runSummaryLines,
	type RunDisplay,
} from "../projection"
import { FooterLineView } from "./view/footer"
import { SetupPanel } from "./view/setup-panel"
import { KEYBOARD_HINTS, helloHeader } from "./view/banner"
import { buildTuiLayout, fixedChromeRows } from "./view/layout"
import { runCompaction } from "./compaction"
import { Selector, PickerSlot, pickerVisibleItems, type SelectorItem } from "./view/selector"
import { SessionManager, type SessionManagerAction } from "./view/session-manager"
import { workspaceSessions, type ScopedSessionSummary } from "./session/scope"
import { cloneSession, forkCandidates, forkSession } from "./session/operations"
import { LoongCodeAutocomplete } from "./input/autocomplete"
import { composerGhostText } from "./input/argument-placeholder"
import { altEnterAsNewline } from "./input/alt-enter"
import { expandFileReferences } from "./input/expand"
import { COMMANDS, findCommand, type Command, type CommandContext, type CompactResult } from "./commands"
import {
	IterationBlock,
	ToolExecutionComponent,
	assistantMessage,
	errorNotice,
	notice,
	replayMessage,
	userMessage,
} from "./view/components"

export interface LoongCodeTuiOptions {
	agent: LoongCode
	session: Session
	/** Window title / header label (typically the workspace path). */
	label?: string
	/**
	 * Model readiness resolved before the TUI was built, so the first frame
	 * already reflects it and no asynchronous notice has to correct it later.
	 * Absent means "not resolved yet": the transcript stays silent and the
	 * footer fills in once the first refresh completes.
	 */
	readiness?: ModelReadiness
	/**
	 * Terminal to render onto. Defaults to the process terminal; tests supply a
	 * mock so the real application can be driven without a PTY.
	 */
	terminal?: Terminal
}

/**
 * How a slash input resolves after the leading `/`. Registered commands take
 * precedence over prompt templates of the same name.
 */
export type SlashInput =
	| { kind: "command"; command: Command }
	| { kind: "template"; content: string }
	| { kind: "unknown" }

/**
 * Reads a prompt template's content from disk. Project templates take
 * precedence over user templates, matching the historical behavior. Content is
 * always read fresh, so edits apply on the next invocation.
 */
function readPromptTemplate(cwd: string, name: string): string | null {
	const userDir = join(configDir(), "prompts")
	for (const dir of [join(cwd, ".loongcode", "prompts"), userDir]) {
		try {
			return readFileSync(join(dir, `${name}.md`), "utf-8")
		} catch {
			// Try the next location.
		}
	}
	return null
}

/**
 * Resolves a slash input to the command or prompt template it names. Templates
 * are discovered live from disk, so a newly added one works without any
 * refresh command; a removed one stops resolving.
 */
export function resolveSlashInput(cwd: string, name: string): SlashInput {
	const command = findCommand(name)
	if (command !== undefined) return { kind: "command", command }
	const content = readPromptTemplate(cwd, name)
	if (content !== null) return { kind: "template", content }
	return { kind: "unknown" }
}

/**
 * The editor's autocomplete source: registered commands plus prompt templates
 * discovered live from disk, so added/removed templates appear (and disappear)
 * without a manual refresh.
 */
export function autocompleteItems(cwd: string): Array<{ name: string; description: string }> {
	return [
		...COMMANDS.map(c => ({ name: c.name, description: c.description })),
		...listPromptTemplates(cwd).map(t => ({ name: t.name, description: `template · ${t.source}` })),
	]
}

interface AskState {
	label: string
	resolve: (value: string | null) => void
}

/**
 * The LoongCode fullscreen TUI.
 * The runtime is the source of truth: `RunEvent`s map 1:1 onto component
 * updates and the editor submits through the existing `LoongCode.run()`.
 *
 * The conversation lives in an application-owned `ScrollView` (the only
 * scrolling region); the status, composer, and two footer rows are fixed to the
 * bottom. The header is the first item of the scroll content, so it scrolls away.
 *
 * Keys: Enter submits — and steers while a task runs; Alt+Enter inserts a
 * newline; Esc interrupts; Ctrl-C clears (twice exits); Ctrl-D exits empty;
 * Ctrl-O toggles tool output; Ctrl-P cycles models; PageUp/PageDown/Home/End and
 * the mouse wheel scroll the conversation.
 */
/** A one-line rendering of a restore outcome, spelling out every refusal. */
function describeFiles(outcome: { restored: readonly string[]; removed: readonly string[]; failed: readonly { path: string; reason: string }[]; skipped: readonly { path: string; reason: string }[] } | null): string {
	if (outcome === null) return "files unchanged"
	const parts: string[] = []
	if (outcome.restored.length > 0) parts.push(`restored ${outcome.restored.length} file(s)`)
	if (outcome.removed.length > 0) parts.push(`removed ${outcome.removed.length} file(s) the agent created`)
	if (outcome.skipped.length > 0) parts.push(`skipped ${outcome.skipped.length}: ${outcome.skipped.map(f => `${f.path} (${f.reason})`).join(", ")}`)
	if (outcome.failed.length > 0) parts.push(`could not restore ${outcome.failed.length}: ${outcome.failed.map(f => `${f.path} (${f.reason})`).join(", ")}`)
	// A turn that touched no file has nothing to restore and nothing to
	// disclaim: the tracking note belongs with a result it qualifies, not on
	// its own where it reads as an unexplained caveat.
	if (parts.length === 0) return "files unchanged"
	parts.push("note: only files the agent edited through its own tools are tracked; shell commands are not")
	return parts.join(" · ")
}

/** `3 messages`, `1 message` — the codebase's plural convention. */
function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`
}

/**
 * The session's standing warning, in one line.
 *
 * It states what is known — commands ran and were not reversed — and never
 * what they did, which nothing here can determine.
 */
function shellWarningText(note: RewindNote): string {
	const commands = plural(note.shellCommands, "shell command", "shell commands")
	const turns = plural(note.shellTurns, "rewound turn", "rewound turns")
	return `⚠ ${commands} in ${turns} not undone — effects may extend beyond this workspace`
}

/**
 * What a rewind's discarded turns ran that it cannot undo.
 *
 * Printed in the transcript beside the file results, so the three distinct
 * facts — conversation, tracked files, shell — are each stated once.
 */
function describeShell(discarded: readonly Checkpoint[]): string {
	const shellTurns = discarded.filter(c => (c.shell ?? 0) > 0)
	const commands = shellTurns.reduce((total, c) => total + (c.shell ?? 0), 0)
	if (shellTurns.length === 0) {
		// An unrecorded count is not a zero: a turn whose invocations were never
		// recorded cannot be reported as having run none.
		return discarded.some(c => c.shell === undefined)
			? "shell: not recorded for these turns — whether a command ran, and what it did, is unknown"
			: "shell: none invoked by the discarded turns"
	}
	return `shell: NOT reversed — ${plural(commands, "command", "commands")} ran in ${plural(shellTurns.length, "discarded turn", "discarded turns")}; they may have written files, left processes running, or changed state outside this workspace`
}

/**
 * The footer's run figures for a session with no run live in this process.
 *
 * The last run's record is read back from disk so a reloaded or switched-to
 * session describes its own history instead of claiming nothing ever ran. The
 * context reading is deliberately absent: it is never persisted, and no figure
 * is reconstructed from retained messages, which cannot reproduce what a
 * provider actually billed.
 */
function seededDisplay(session: Session): RunDisplay {
	const lastRun = session.runs.at(-1)
	if (lastRun === undefined) return NO_RUN_DISPLAY
	return {
		lastCallUsage: undefined,
		runUsage: lastRun.usage,
		runRequests: lastRun.modelCalls ?? 0,
		lastRun,
		compactedMessages: undefined,
	}
}

/** A checkpoint's prompt, short enough for a selector row. */
function truncateForRow(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim()
	return flat.length <= 72 ? flat : `${flat.slice(0, 71)}…`
}

/**
 * The one line that tells the user how to get a model. Shared by every place
 * that reports the state, so the startup notice, the footer and the model key
 * cannot describe the same situation three different ways.
 *
 * It says no model is ACTIVE rather than none is configured, because the
 * readiness reading covers both: `ModelManager.load` also yields no active
 * model when a configuration holds models and none is selected. The remedy is
 * the same either way — `/model` offers what exists and the way to add more —
 * but claiming nothing is configured would be false for a user who has models
 * and only needs to choose one.
 */
const NO_MODEL_NOTICE = "No model is active — use /model to choose or add one."

/**
 * The composer's prompt gutter. The same chevron the transcript uses for a
 * submitted task, so the input reads as where a task is written and its
 * continuation lines align under the text column rather than repeating it.
 */
export const COMPOSER_PROMPT = "❯ "

/**
 * The composer's placeholder, shown while the input is empty. It names the one
 * affordance the empty input area has — that it accepts a message — and is
 * otherwise inert (render-only; never submitted). It deliberately does not
 * repeat the ready-state guidance the masthead states: while the transcript is
 * empty the two are on screen together, and the same sentence twice reads as a
 * defect rather than emphasis.
 */
export const COMPOSER_PLACEHOLDER = "Type a message…"

/**
 * Below this many terminal rows the footer's usage row is retracted. It is the
 * same threshold the row has always used; what changed is that it is now read at
 * render time, so a resize enforces it immediately.
 */
export const FOOTER_ROW2_MIN_ROWS = 14

/**
 * The two answers the gate's recovery picker can give. Control-character
 * prefixed, so neither can collide with a value the selector carries for a
 * model id — the same convention `/model` uses for its own actions.
 */
const SETUP_AGAIN = "\u0000setup:again"
const SETUP_EXIT = "\u0000setup:exit"

/**
 * The two protocols a connection can be configured for. The labels name the
 * wire protocol, not a vendor: any service that speaks one of them is
 * configured by choosing it.
 */
const SETUP_PROTOCOLS: readonly { value: ModelProtocol; label: string }[] = [
	{ value: "openai", label: "OpenAI-compatible" },
	{ value: "anthropic", label: "Anthropic-compatible" },
]

/** The official base URL of each protocol — the default the address step offers. */
const SETUP_ENDPOINTS: Record<ModelProtocol, string> = {
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com/v1",
}

/**
 * The limits a new model starts with, offered at the limits sub-step as
 * `Continue with defaults (128000 / 8192)`.
 *
 * They are the values the first configuration flow used, so a model created
 * without touching the sub-step is shaped exactly as before. Limits live in
 * each saved configuration, so an existing installation's models are unaffected
 * either way.
 */
const SETUP_DEFAULT_CONTEXT_WINDOW = 128000
const SETUP_DEFAULT_MAX_OUTPUT_TOKENS = 8192

/**
 * How long the connection test may take before it is reported as timed out.
 *
 * Exported so the test that proves the timeout can fire the real one rather
 * than a second, different number.
 */
export const SETUP_TEST_TIMEOUT_MS = 30_000

/** A protocol's user-facing label, for the screens that report the choice. */
function protocolLabel(protocol: ModelProtocol): string {
	return SETUP_PROTOCOLS.find(choice => choice.value === protocol)?.label ?? protocol
}

/**
 * The local configuration id for a provider model identifier, so the user is
 * never asked for a second, internal name. Control characters are stripped —
 * the selector reserves a control-character prefix for its own action values —
 * and a name that reduces to nothing falls back to `"model"`.
 */
function deriveModelId(model: string): string {
	const cleaned = model.trim().replace(/[\u0000-\u001f\u007f]/g, "").trim()
	return cleaned.length > 0 ? cleaned : "model"
}

/** Why a connection test did not succeed, in the user's terms. */
interface TestFailure {
	readonly reason: string
	readonly details: string
}

/** The values the setup sequence collects. One record, edited in place. */
interface SetupDraft {
	protocol: ModelProtocol
	endpoint: string
	apiKey: string
	model: string
	contextWindow: number
	maxOutputTokens: number
}

/** Where the sequence is. Back moves to the previous step; the values stay. */
type SetupStep =
	| "protocol"
	| "endpoint"
	| "apiKey"
	| "model"
	/** The limits sub-step: unnumbered, so the sequence the user walks is the
	 *  numbered five it always was. */
	| "limits"
	| "test"
	| "tested"
	| "failed"
	| "saved"
	| "exit"

/**
 * One run of the setup sequence.
 *
 * Creation and editing differ in exactly three places — the values the fields
 * start with, who persists the verified result, and what the commit choice
 * says — and nowhere else. Everything between them (validation, the connection
 * test, cancellation) is the same sequence, which is the point.
 */
interface SetupRunOptions {
	/** The values every field starts from. */
	readonly draft: SetupDraft
	/** Persists the verified draft. Resolves `null` on success, `"cancelled"`
	 *  when the user backed out of an id conflict, or the failure message. */
	readonly commit: (draft: SetupDraft) => Promise<string | null>
	/** The commit choice on the tested screen. */
	readonly saveLabel: string
	/** The first screen's heading, for a run that is about a known model. */
	readonly heading?: string
	/** Text before the values in the limits sub-step's "leave them alone"
	 *  choice: creating continues with the defaults, editing keeps what the
	 *  model already has. */
	readonly keepLimitsLabel: string
	/** Offer the key step as keep-or-replace instead of prompting, for a draft
	 *  that already carries a key. */
	readonly keepExistingKey?: boolean
	/** The run is an edit started from the workspace, so the first step's escape
	 *  cancels back to it rather than offering to leave LoongCode — a user who
	 *  opened an edit has somewhere to return to. */
	readonly cancelEdit?: boolean
}

/** The sequence's starting values for an existing configuration: every saved
 *  field, including the key — which the key step never displays and only
 *  replaces on request. */
function draftFromConfig(config: ModelConfig): SetupDraft {
	return {
		protocol: config.protocol,
		endpoint: config.endpoint,
		apiKey: config.apiKey,
		model: config.model,
		contextWindow: config.contextWindow,
		maxOutputTokens: config.maxOutputTokens,
	}
}

type SetupFieldName = "endpoint" | "apiKey" | "model"

interface SetupFieldSpec {
	readonly step: string
	readonly heading: string
	readonly note?: string
	readonly hints: string
	readonly secret: boolean
	/** Where Escape goes from this field. */
	readonly back: SetupStep
	/** Where a valid value goes. */
	readonly next: SetupStep
	/** The problem with a value, or null when it is fine. */
	readonly validate: (value: string) => string | null
}

/** The three text fields of the sequence, in the approved order. */
const SETUP_FIELDS: Record<SetupFieldName, SetupFieldSpec> = {
	endpoint: {
		step: "Step 2/5",
		heading: "Service address (Base URL)",
		hints: "Enter Next · Esc Back",
		secret: false,
		back: "protocol",
		next: "apiKey",
		validate: value => {
			if (value.length === 0) return "Enter the service address."
			let url: URL
			try {
				url = new URL(value)
			} catch {
				return "That is not a valid URL."
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				return "The address must start with http:// or https://."
			}
			return null
		},
	},
	apiKey: {
		step: "Step 3/5",
		heading: "API Key",
		note: "The API key is masked.",
		hints: "Enter Next · Esc Back",
		secret: true,
		back: "endpoint",
		next: "model",
		validate: value => (value.length === 0 ? "Enter the API key." : null),
	},
	model: {
		step: "Step 4/5",
		heading: "Model ID",
		note: "Enter the model identifier supported by the selected model service.",
		hints: "Enter Next · Esc Back",
		secret: false,
		back: "apiKey",
		next: "limits",
		validate: value => (value.length === 0 ? "Enter the model identifier." : null),
	},
}

/**
 * Turns a failed probe into a reason and a safe detail line.
 *
 * The detail comes from the model package, which scrubs the API key out of
 * every message it raises; nothing here re-derives it from the request, so
 * there is no second path for a credential to reach the screen.
 */
function describeTestFailure(error: unknown, cancelled: boolean, timedOut: boolean): TestFailure {
	if (cancelled) {
		return { reason: "The test was cancelled.", details: "No model response was received." }
	}
	if (timedOut) {
		return {
			reason: "The request timed out.",
			details: `No response within ${Math.round(SETUP_TEST_TIMEOUT_MS / 1000)} seconds.`,
		}
	}
	if (error instanceof ModelError) {
		switch (error.code) {
			case "authentication_failed":
				return { reason: "Authentication failed.", details: "The service rejected the API key." }
			case "rate_limited":
				return { reason: "The service is rate limiting requests.", details: error.message }
			case "invalid_response":
				return { reason: "The service returned a response that could not be used.", details: error.message }
			case "context_exceeded":
				return { reason: "The request exceeded the model's context window.", details: error.message }
			case "cancelled":
				return { reason: "The request was cancelled.", details: "No model response was received." }
			case "configuration_error":
				return { reason: "The configuration is not valid.", details: error.message }
			default:
				// The provider's own message is what tells a wrong model id from
				// an unreachable host; the adapter classifies both as a failed
				// request, so the detail carries the difference.
				return { reason: "The model request failed.", details: error.message }
		}
	}
	return { reason: "The model request failed.", details: "The service could not be reached." }
}

/**
 * Whether a model is ready to run.
 *
 * Three outcomes, never two. "Nothing is configured" and "the configuration
 * could not be read" have different remedies, and the model layer already
 * distinguishes them: `ModelManager.load` yields empty state only for a
 * missing file and throws for everything else. Collapsing them would offer a
 * broken installation the first-run setup flow — which could not save either,
 * because every write path loads the file first — and would misreport a
 * configuration that still holds the user's credentials as an empty one.
 */
export type ModelReadiness =
	| { readonly kind: "ready"; readonly model: Model }
	| { readonly kind: "missing" }
	| { readonly kind: "error"; readonly message: string }

/**
 * The single place the TUI asks whether a model is available.
 *
 * Total by construction: an unreadable configuration is an answer to render,
 * not an exception to escape. Two callers depend on that — the constructor
 * refreshes the footer without awaiting it, and the run path refreshes inside
 * its own protected region — so a rejection here would either crash the
 * process (an unhandled rejection) or strand the UI as running.
 *
 * This is presentation and guidance only. Enforcement stays in the agent
 * layer, where `run` resolves the model itself and refuses to start without
 * one; a wrong answer here can only mis-word a failure, never cause a run.
 */
export async function modelReadiness(agent: LoongCode): Promise<ModelReadiness> {
	try {
		const model = await agent.currentModel()
		return model === undefined ? { kind: "missing" } : { kind: "ready", model }
	} catch (err) {
		return { kind: "error", message: err instanceof Error ? err.message : String(err) }
	}
}

/**
 * Why the workspace path is unusable, or `null` when it is a directory.
 *
 * Reported, never enforced: startup is not blocked, no directory is
 * substituted, and the filesystem tools keep their existing behavior (the
 * write tool still creates missing parents, the shell still runs).
 */
function workspaceIssue(cwd: string): string | null {
	try {
		return statSync(cwd).isDirectory() ? null : `working directory is not a directory: ${cwd}`
	} catch {
		return `working directory does not exist: ${cwd}`
	}
}

export class LoongCodeTui {
	private readonly tui: TuiAltScreen
	/**
	 * The conversation stack. Windowed: the viewport is laid out from the
	 * logical row count and only the visible window is rendered, so a long
	 * conversation costs the window rather than its whole length. Its content
	 * changes are announced with `invalidateChild` (see the run-event adapter),
	 * because the stack cannot see a child's mutation on its own.
	 */
	private readonly chat = new WindowedStack()
	/** The transcript stack (header + chat) inside the scroll view, for header invalidation. */
	private transcript: WindowedStack | null = null
	/**
	 * The masthead header. Its height is not fixed: it renders the empty-state
	 * banner while the session holds no messages and zero rows afterwards, so
	 * its cached height is invalidated when that visibility flips.
	 */
	private header: Component | null = null
	/** File checkpoints for `/rewind`, stored beside the session. */
	private readonly checkpointStore: CheckpointStore
	private readonly status = new Container()
	/**
	 * The persistent session warning row, above the picker. It renders zero
	 * rows while the session has nothing to warn about, and holds its row for
	 * as long as it does — the state it reports outlives the message that
	 * announced it.
	 */
	private readonly warning = new Container()
	private readonly editor: Editor
	/**
	 * The layout's composer slot.
	 *
	 * It holds the editor in the normal phase, and the setup state in its place
	 * while the gate is closed — so there is no composer to type a task into
	 * before a model exists. The editor is put back for the duration of a
	 * prompt, because the credential prompts are typed into it, and it is
	 * swapped out again the moment the prompt resolves.
	 */
	private readonly editorSlot = new Container()
	private readonly footerRow1 = new FooterLineView()
	/**
	 * The usage row retracts on a short terminal so the transcript and composer
	 * keep usable space. Visibility is decided at render time from the live
	 * terminal height, so a resize alone retracts it and the conversation
	 * immediately regains the row (see {@link FooterLineView}).
	 */
	private readonly footerRow2 = new FooterLineView(() => this.tui.terminal.rows > FOOTER_ROW2_MIN_ROWS)
	/** Bottom-attached transient picker, rendered directly above the composer. */
	private readonly picker: PickerSlot

	private readonly loader: Loader
	private session: Session
	/**
	 * The last resolved model readiness, or undefined while none has been
	 * resolved. Drives the footer's model group and nothing else: the decision
	 * to run is taken from a fresh reading at submission time, never from this
	 * cached one.
	 */
	private readiness: ModelReadiness | undefined
	/**
	 * Which interface this application is in.
	 *
	 * `setup` is the gate: the normal working interface — transcript, composer,
	 * commands, shortcuts — is not reachable while it is open, and only a
	 * FRESH readiness check that returns `ready` closes it. Two phases and one
	 * loop; no state-machine framework.
	 */
	private phase: "normal" | "setup" = "normal"
	/**
	 * Why the gate is closed — for COPY only. No decision reads it: every pass
	 * of the setup loop re-derives the state from a fresh reading, so a stale
	 * value here can mis-word a sentence and nothing else.
	 */
	private setupReason: "missing" | "error" | "view" = "missing"
	/**
	 * A task that was typed while a model was available and held back because
	 * the model stopped being available. Its full text is kept here — never in
	 * durable storage — and it is restored to the composer only once the normal
	 * interface is genuinely back. It is never run automatically.
	 */
	private pendingTask: string | null = null
	/** Set once the user has chosen to leave setup; stops the setup loop. */
	private exiting = false
	/**
	 * The setup screen itself. It is the entire visible interface while the
	 * gate is closed — the step's text, the input it needs, and the keys that
	 * work — and it is never rendered outside setup.
	 */
	private readonly setupPanel = new SetupPanel()
	/** The list the current setup step is offering, when it offers one. */
	private setupSelector: Selector | null = null
	/** Aborts an in-flight connection test. Present only while one is running. */
	private testAbort: AbortController | null = null
	/** Why the last connection test failed, for the failure screen. */
	private lastTestFailure: TestFailure | null = null
	private running = false
	/**
	 * True for exactly the lifetime of a manual `/compact`. Application-owned:
	 * the compaction has no runtime event, so this transient drives both the
	 * footer ("Compacting", not "Idle") and the spinner.
	 */
	private compacting = false
	/** Runtime facts the footer reads, folded from the run's own events. */
	private display: RunDisplay = NO_RUN_DISPLAY
	/**
	 * The context reading was dropped by a rewind rather than never taken.
	 * Both leave the number unknown; only this says which.
	 */
	private contextCleared = false
	/** The displayed run's turns are no longer all in the conversation. */
	private runBeforeRewind = false
	private abort: AbortController | null = null
	private lastCtrlC = 0
	private toolsExpanded = false
	private modelId: string | undefined
	private modelLimits: ModelLimits | undefined
	private compactThresholdPct: number | undefined
	private gitBranch: string | undefined
	/**
	 * A pending tool, with the block that holds it. The block is kept so a
	 * progress update, a result, or an interruption can announce the height
	 * change to the windowed conversation stack.
	 */
	private readonly pendingTools = new Map<string, { component: ToolExecutionComponent; block: IterationBlock }>()
	private streaming: Container | null = null
	private streamingText = ""
	/**
	 * The renderer for the message currently streaming, held so each delta can
	 * update it in place rather than rebuild it. Present only while `streaming`
	 * is, and dropped with it when the message is finalized.
	 */
	private streamingMarkdown: Markdown | null = null
	/** The iteration block the live run is currently filling, if any. */
	private currentBlock: IterationBlock | null = null
	/**
	 * The live model iteration number, from `iteration_start`. Undefined between
	 * runs and after replay: it is never invented to fill a gap the runtime did
	 * not report.
	 */
	private currentIteration: number | undefined = undefined
	private selector: Selector | null = null
	/** The open `/session` manager, which owns input while present. */
	private manager: SessionManager | null = null
	private askState: AskState | null = null
	private reasoning: Container | null = null
	private readonly commandContext: CommandContext

	constructor(private readonly options: LoongCodeTuiOptions) {
		this.checkpointStore = new CheckpointStore(options.agent.sessionsDir)
		// The setup panel changes its own content while it is hosted in the
		// windowed conversation stack, so it announces its changes there.
		this.setupPanel.onChange = () => this.chat.invalidateChild(this.setupPanel)
		// A fullscreen viewport owns the screen: the conversation scrolls in-app
		// while the composer/status/footer stay pinned to the bottom.
		this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), false, undefined, { mouse: true })
		// The theme resolves its depth from the real terminal and follows the
		// terminal's own light/dark reports. A terminal that never reports keeps
		// the dark default; the flag is enabled so a mid-session theme switch is
		// honoured without a restart.
		initTheme()
		this.tui.setTerminalColorSchemeNotifications(true)
		this.tui.onTerminalColorSchemeChange(scheme => {
			setThemeScheme(scheme)
			this.tui.requestRender()
		})
		this.session = options.session

		// The header is the transcript's true empty state: the hello banner is
		// rendered only while the session holds no conversation messages. Once
		// the first message exists the hero contributes zero rows, so the user's
		// message — not the banner — is the first transcript item, and the banner
		// can never be reached again through scrollback. `/new` and a switch to an
		// empty session satisfy the same predicate, so the hero returns without
		// any dedicated lifecycle flag. The live predicate reads the current
		// session (never a captured one) and the synchronous `running` flag, which
		// is already set when a submission begins, closing the window between
		// appending the user's message and the session recording it. The hero is
		// centered as a group inside the transcript viewport, measured live from
		// the fixed bottom chrome; it never blocks the composer.
		const header = helloHeader({
			label: options.label ?? this.session.cwd,
			hints: KEYBOARD_HINTS,
			availableHeight: () => this.transcriptViewportHeight(),
			// The masthead carries the workspace's identity. Branch and model are
			// read live and may be unresolved on the first frame; an absent value
			// simply drops out of the context line rather than printing a blank.
			branch: () => this.gitBranch,
			model: () => this.modelId,
			// The hero is the empty *workspace* state, so it is decided here,
			// where the frame is composed — not rendered and then hidden. While
			// the gate is closed there is no workspace to be empty, and the
			// setup screen is what the user is looking at.
			visible: () => this.phase === "normal" && this.session.messages.length === 0 && !this.running,
		})

		this.editor = this.createEditor()
		// The picker is a fixed VStack entry directly above the composer; it
		// renders zero rows until a selector is opened, and caps its own height
		// from the live terminal size so it can never push the composer or
		// footer off-screen.
		this.picker = new PickerSlot(() => pickerVisibleItems(this.tui.terminal.rows))
		const layout = buildTuiLayout({
			header,
			chat: this.chat,
			status: this.status,
			warning: this.warning,
			picker: this.picker,
			editor: this.editorSlot,
			footerRow1: this.footerRow1,
			footerRow2: this.footerRow2,
		})
		this.tui.setLayoutRoot(layout.root)
		this.transcript = layout.transcript
		this.header = header

		this.loader = new Loader(this.tui, theme.running, (text) => ansi.bold(text), "working… (esc to interrupt)")
		this.tui.addInputListener(data => this.handleGlobalInput(data))

		this.commandContext = this.buildCommandContext()

		// The startup state, stated once and only when there is something to
		// state. It is never re-emitted: the footer carries the fact from here
		// on, and a notice repeated at every refresh would be noise. An absent
		// readiness means the caller did not resolve one — which is not a fact
		// about the model, so it neither closes the gate nor says anything.
		this.readiness = options.readiness
		this.phase = options.readiness !== undefined && options.readiness.kind !== "ready" ? "setup" : "normal"
		if (options.readiness?.kind === "error") this.setupReason = "error"

		if (this.phase === "setup") {
			// The gate is closed, so the workspace view is never built: no
			// resumed history is replayed, no session warning is rendered, and
			// no startup banner is composed (its visibility predicate excludes
			// this phase). The setup screen is the whole of what is shown.
			this.chat.addChild(this.setupPanel)
		} else {
			this.replaySession()
			this.updateWarning()
		}
		// A path that cannot be used is reported before the first tool call
		// rather than discovered by it. Nothing is blocked and nothing is
		// substituted: the session keeps the directory it was given.
		const workspace = workspaceIssue(this.session.cwd)
		if (workspace !== null) this.chat.addChild(errorNotice(workspace))

		// The composer slot is filled before the first frame: the editor in the
		// normal phase, the setup state while the gate is closed.
		this.updateEditorSlot()

		// The footer describes the session that is open, including the runs it
		// recorded in an earlier process; nothing here is invented to fill a
		// gap the persisted record does not cover.
		this.display = seededDisplay(this.session)
		void this.refreshFooterData()
		this.updateFooter()
	}

	/**
	 * The live transcript viewport height: the terminal minus every fixed bottom
	 * region (status, picker, composer, and the two footer rows). It is measured
	 * from the real components — not assumed to be a constant — so a multiline
	 * composer, an open picker, or a status row shrinks the area the centered
	 * hero is centered in, rather than letting the hero overlap the chrome.
	 */
	private transcriptViewportHeight(): number {
		const chromeRows = fixedChromeRows(
			[this.status, this.warning, this.picker, this.editorSlot, this.footerRow1, this.footerRow2],
			this.tui.terminal.columns,
		)
		return Math.max(0, this.tui.terminal.rows - chromeRows)
	}

	private buildCommandContext(): CommandContext {
		return {
			agent: () => this.options.agent,
			session: () => this.session,
			setSession: session => {
				this.setActiveSession(session)
			},
			notify: (text, isError) => {
				this.chat.addChild(isError === true ? errorNotice(text) : notice(text))
				this.tui.requestRender()
			},
			pick: async (title, items, options) => {
				const selector = new Selector(
					title,
					items as SelectorItem[],
					options?.selectedValue,
				)
				return new Promise<string | null>(resolve => {
					// The selector fills the bottom-attached picker slot so it owns
					// input while open: viewport keys are deferred to the focused
					// selector, and closing restores the composer's focus.
					const close = (): void => {
						if (this.selector !== selector) return
						this.selector = null
						this.picker.setSelector(null)
						this.tui.setFocus(this.editor)
						this.tui.requestRender()
					}
					selector.onSelect = value => {
						close()
						resolve(value)
					}
					selector.onCancel = () => {
						close()
						resolve(null)
					}
					this.selector = selector
					this.picker.setSelector(selector)
					this.tui.setFocus(selector)
					this.tui.requestRender()
				})
			},
			ask: async (label, options) => {
				const secret = options?.secret === true
				// A caller already showing the prompt elsewhere — the setup
				// panel, above the field it is asking for — does not need it
				// repeated in the status row at the other end of the screen.
				const quiet = options?.quiet === true
				return new Promise<string | null>(resolve => {
					this.askState = { label, resolve: value => {
						this.status.clear()
						// The composer holds the prompt's text, never the user's
						// own: a command is only reachable after the editor has
						// cleared itself, so whatever is here was typed into this
						// prompt. Clear it before lifting the mask — rendering is
						// batched, so clearing first means no frame can ever show
						// a secret in the clear.
						this.editor.setText("")
						this.editor.setMasked(false)
						// The prompt is over: while the gate is closed the editor
						// leaves the layout again with it.
						this.updateEditorSlot()
						this.tui.setFocus(this.editor)
						resolve(value)
					} }
					// Secret prompts mask the composer so the typed value is never
					// echoed; every resolution path (submit or Escape) clears it.
					this.editor.setMasked(secret)
					// A rename is seeded with the current title so the user edits
					// rather than retypes it; other prompts start empty.
					this.editor.setText(options?.initialValue ?? "")
					// A prompt is typed into the editor, so the editor is in the
					// layout for exactly as long as the prompt is open.
					this.updateEditorSlot()
					if (!quiet) this.status.addChild(new Text(ansi.bold(label), 1, 0))
					this.tui.setFocus(this.editor)
					this.tui.requestRender()
				})
			},
			manageSessions: async (): Promise<void> => {
				await this.runSessionManager()
			},
			rewind: async (): Promise<void> => {
				await this.runRewind()
			},
			compact: async (): Promise<CompactResult> => {
				// A manual compaction must not run concurrently with another
				// compaction or an active run: both mutate the same durable history,
				// and the run owns the shared spinner. Refuse rather than start a
				// second mutator; the in-flight owner keeps its transient state.
				const busy: "compacting" | "running" | undefined =
					this.compacting ? "compacting" : this.running ? "running" : undefined
				if (busy !== undefined) return { status: "busy", reason: busy }
				const model = await this.options.agent.currentModel()
				if (model === undefined) return { status: "no-model" }
				const { Compactor } = await import("@loongcode/agent")
				const compactor = new Compactor(model, model.limits.contextWindow)
				// `runCompaction` brackets the awaited model call; its `finally`
				// guarantees the state and spinner are cleared on success, failure,
				// or an unexpected throw.
				const outcome = await runCompaction(this.session, compactor, {
					begin: () => {
						this.compacting = true
						// No interrupt hint: Esc aborts a run, not a manual compaction.
						this.showSpinner("Compacting context…")
						this.updateFooter()
					},
					end: () => {
						this.compacting = false
						this.hideSpinner()
						this.updateFooter()
					},
				})
				if (outcome.status === "compacted") {
					this.chat.clear()
					this.replaySession()
					// Manual compaction is not a runtime event; record its message
					// count here so the footer reports it like an automatic one.
					this.display = { ...this.display, compactedMessages: outcome.removed }
					this.updateFooter()
					this.tui.requestRender()
				}
				return outcome
			},
			configureModel: async (): Promise<boolean> => {
				// One configuration flow, wherever it is entered from: the
				// workspace command shows the same sequence the mandatory gate
				// does, so no path can save a model that was never called.
				if (this.phase === "setup") {
					return (await this.runSetupSequence(this.creationRun())) === "saved"
				}
				this.enterSetupPhase(null)
				const outcome = await this.runSetupSequence(this.creationRun())
				// Back to the workspace through the same fresh check that governs
				// entry, so a save that did not take cannot re-open it on a
				// reading taken before the attempt.
				void this.runSetup()
				return outcome === "saved"
			},
			editModel: async (id: string): Promise<boolean> => {
				const config = (await this.commandContext.agent().modelManager()).config(id)
				if (config === undefined) {
					// The picker listed it a moment ago; a store that no longer
					// has it is reported, never silently re-created.
					this.chat.addChild(errorNotice(`model "${id}" is not configured`))
					this.tui.requestRender()
					return false
				}
				const run: SetupRunOptions = {
					draft: draftFromConfig(config),
					// The id is the model's identity: an edit can change every
					// field except which entry it is, so the update goes through
					// the manager's replacement rather than a remove and an add.
					commit: async draft => {
						try {
							await this.commandContext.agent().updateModel({
								...this.setupConfig(draft),
								id: config.id,
								name: config.id,
							})
							return null
						} catch (error) {
							return error instanceof Error ? error.message : String(error)
						}
					},
					saveLabel: "Save changes",
					heading: `Edit "${config.id}"`,
					keepLimitsLabel: "Keep current limits",
					keepExistingKey: true,
					cancelEdit: true,
				}
				if (this.phase === "setup") {
					return (await this.runSetupSequence(run)) === "saved"
				}
				this.enterSetupPhase(null)
				const outcome = await this.runSetupSequence(run)
				void this.runSetup()
				return outcome === "saved"
			},
			removeModel: async (id: string): Promise<void> => {
				// The manager owns the active pointer: removing the active model
				// leaves none, so the gate reopens now rather than at the next
				// task submission. A failure to persist propagates to the caller,
				// which reports it instead of a success.
				await this.commandContext.agent().removeModel(id)
				if ((await modelReadiness(this.options.agent)).kind !== "ready") {
					this.enterSetupPhase(null)
					void this.runSetup()
				}
			},
			modelChangeBlocked: (): "running" | "compacting" | undefined =>
				this.compacting ? "compacting" : this.running ? "running" : undefined,
			submitTask: async text => {
				await this.submit(text)
			},
			quit: (): void => this.shutdown(),
		}
	}

	// ── editor ───────────────────────────────────────────────────────

	/**
	 * Replaces the active session and replays it. Owns every UI refresh a
	 * switch requires: transcript, pending tool state, and the footer's
	 * workspace/model/branch.
	 */
	private setActiveSession(session: Session): void {
		this.session = session
		this.chat.clear()
		this.pendingTools.clear()
		this.replaySession()
		// Every session-owned reading is replaced, not carried over: another
		// session's run figures and warnings describe another conversation.
		this.display = seededDisplay(session)
		this.contextCleared = false
		this.runBeforeRewind = false
		this.updateWarning()
		// A switched/forked session may live in another workspace, so the
		// footer's branch (and model) are re-read, not carried over.
		void this.refreshFooterData()
		this.updateFooter()
		this.tui.requestRender()
	}

	private createEditor(): Editor {
		const editor = new Editor(
			this.tui,
			{
				borderColor: (text) => theme.muted(text),
				selectList: {
					selectedPrefix: (text) => theme.selected(text),
					selectedText: (text) => ansi.bold(text),
					description: (text) => theme.muted(text),
					scrollInfo: (text) => theme.faint(text),
					noMatch: (text) => theme.failure(text),
				},
			},
			{ ghostTextStyle: (text) => theme.muted(text) },
		)
		// The composer's prompt gutter and placeholder are the workspace input's
		// presentation; setup replaces the editor with its own field (see
		// `updateEditorSlot`), so they are set here and toggled with the phase.
		editor.setPrompt(COMPOSER_PROMPT)
		editor.setAutocompleteProvider(new LoongCodeAutocomplete(
			() => autocompleteItems(this.session.cwd),
			() => this.session.cwd,
		))
		editor.setGhostTextProvider(state =>
			composerGhostText(state, COMMANDS, this.phase === "normal" ? COMPOSER_PLACEHOLDER : undefined),
		)
		editor.onSubmit = (text: string) => {
			void this.submit(text)
		}
		return editor
	}

	// ── global keys ───────────────────────────────────

	private handleGlobalInput(data: string): { consume?: boolean; data?: string } | undefined {
		// An open selector or session manager owns the keyboard.
		if (this.selector !== null || this.manager !== null) return undefined

		// Alt+Enter inserts a newline in the composer. The application used to
		// submit/queue here; it now rewrites the event so the editor's existing
		// newline path handles it uniformly across terminal encodings.
		const newline = altEnterAsNewline(data)
		if (newline !== undefined) return newline

		if (matchesKey(data, "escape")) {
			if (this.testAbort !== null) {
				// Cancelling a test is an explicit act with an explicit result:
				// it stops the request and is reported as a cancellation, never
				// as a success.
				this.testAbort.abort()
				return { consume: true }
			}
			if (this.askState !== null) {
				const ask = this.askState
				this.askState = null
				this.status.clear()
				ask.resolve(null)
				this.tui.requestRender()
				return { consume: true }
			}
			if (this.running) {
				this.abortRun()
				return { consume: true }
			}
			return undefined
		}
		if (matchesKey(data, "ctrl+c")) {
			if (this.running) {
				this.editor.setText("")
				this.tui.requestRender()
				return { consume: true }
			}
			const now = Date.now()
			if (now - this.lastCtrlC < 500) {
				this.shutdown()
			} else {
				this.lastCtrlC = now
				this.editor.setText("")
				this.chat.addChild(notice("press ctrl-c again to exit"))
			}
			return { consume: true }
		}
		if (matchesKey(data, "ctrl+d")) {
			if (!this.running && this.editor.getText().trim().length === 0) {
				this.shutdown()
				return { consume: true }
			}
			return undefined
		}
		// While the gate is closed these two act on a workspace that is not open
		// yet — tool output that is not rendered, a model set the user has not
		// been admitted to. They are consumed and change nothing. Escape,
		// Ctrl+C and Ctrl+D above are deliberately NOT gated: they are how a
		// prompt is cancelled and how the session is left.
		const gated = matchesKey(data, "ctrl+o") || matchesKey(data, "ctrl+p")
		if (this.phase === "setup" && gated) return { consume: true }

		if (matchesKey(data, "ctrl+o")) {
			this.toolsExpanded = !this.toolsExpanded
			for (const component of this.chat.children) {
				if (component instanceof ToolExecutionComponent) component.setExpanded(this.toolsExpanded)
			}
			// A tool's rendered height depends on its expansion, so the
			// conversation stack must re-measure after the toggle.
			this.chat.invalidate()
			this.tui.requestRender()
			return { consume: true }
		}
		if (matchesKey(data, "ctrl+p")) {
			void this.cycleModel()
			return { consume: true }
		}
		return undefined
	}

	/**
	 * Switches to the next configured model.
	 *
	 * Every step lives inside one `try`: this runs from a keypress, on a promise
	 * nobody awaits, so a rejection that escaped would end the process rather
	 * than the switch. `activateModel` is awaited for the same reason — left
	 * floating, its rejection would escape the handler that is meant to catch
	 * it. A failure is reported and the model in use is left alone; the success
	 * notice is only reached once the switch has actually been persisted.
	 */
	private async cycleModel(): Promise<void> {
		try {
			const models = (await this.options.agent.modelManager()).list()
			if (models.length === 0) {
				// There is nothing to cycle to, and saying "only one model" would
				// describe a configuration that does not exist.
				this.chat.addChild(notice(NO_MODEL_NOTICE))
				this.tui.requestRender()
				return
			}
			if (models.length === 1) {
				this.chat.addChild(notice("only one model configured"))
				return
			}
			const currentId = (await this.options.agent.currentModel())?.id
			const index = models.findIndex(m => m.id === currentId)
			const next = models[(index + 1) % models.length]!
			await this.options.agent.activateModel(next.id)
			this.chat.addChild(notice(`switched model: ${next.id}`))
			// The footer's model identity and window must follow the switch.
			await this.refreshFooterData()
			this.tui.requestRender()
		} catch (error) {
			// Both ways this can fail — an unreadable configuration, and a switch
			// that could not be persisted — are reported the same way every other
			// model failure is. The footer still names the model actually in use,
			// because nothing here claims a switch that did not happen.
			this.chat.addChild(errorNotice(error instanceof Error ? error.message : String(error)))
			this.tui.requestRender()
		}
	}

	/**
	 * Leaves the fullscreen screen and exits. `note`, when given, is written to
	 * stderr *after* the terminal is restored — the transcript is gone by then,
	 * so this is the only place a parting message can still be read.
	 */
	private shutdown(note?: string): never {
		this.abort?.abort()
		this.tui.stop()
		if (note !== undefined) process.stderr.write(note)
		process.exit(0)
	}

	// ── submission ───────────────────────────────────────────────────

	private async submit(raw: string): Promise<void> {
		if (this.askState !== null) {
			const ask = this.askState
			this.askState = null
			this.status.clear()
			ask.resolve(raw)
			return
		}

		const text = raw.trim()
		if (text.length === 0) return

		// The gate, as the one place every submission funnels through: the
		// composer, `submitTask`, and prompt templates all arrive here, and so
		// does every command — `/session`, `/rewind`, `/new`, `/compact`,
		// `/copy`, `/help`. While setup is incomplete there is no working
		// interface to submit from, so nothing submitted can run. The prompt
		// branch above is deliberately before this: a credential prompt is part
		// of setup, not a way around it.
		if (this.phase === "setup") return

		if (text.startsWith("/")) {
			const spaceIdx = text.indexOf(" ")
			const name = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)
			const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1)

			const input = resolveSlashInput(this.session.cwd, name)
			if (input.kind === "command") {
				try {
					await input.command.execute(this.commandContext, args)
				} catch (error) {
					// Model-management failures must surface as normal error
					// notices, never as an uncaught stack trace over the TUI.
					this.chat.addChild(errorNotice(
						`/${name} failed: ${error instanceof Error ? error.message : String(error)}`,
					))
				}
				// A command may change the active model (e.g. /model), so
				// the footer's model identity and window are re-read here.
				await this.refreshFooterData()
				this.tui.requestRender()
				return
			}
			// Prompt templates: /name expands to the template content, resolved
			// live from disk so added, edited, and removed templates apply
			// immediately.
			if (input.kind === "template") {
				await this.submit(input.content)
				return
			}
			this.chat.addChild(errorNotice(`unknown command "/${name}" — try /help`))
			this.tui.requestRender()
			return
		}

		if (this.running) {
			// Enter during a run steers the agent.
			this.session.steer(text)
			this.chat.addChild(notice("steering…"))
			this.tui.requestRender()
			return
		}

		if (this.compacting) {
			// A task must not start while a manual compaction is rewriting the
			// same history (and the compaction owns the shared spinner).
			this.chat.addChild(notice("a compaction is in progress — wait for it to finish"))
			this.tui.requestRender()
			return
		}

		// The authoritative model check, read fresh here rather than trusting
		// the startup reading: that one described the launch, this one decides
		// what happens to the task in hand. The agent layer enforces the same
		// rule again before it runs anything, so the worst a wrong answer here
		// could do is word the failure badly — never start a run without a
		// model, and never open setup for a model that is already configured.
		const readiness = await modelReadiness(this.options.agent)
		if (readiness.kind !== "ready") {
			// The model went away under a session that had one. The gate closes
			// again and the task is held, not run: it goes back to the composer
			// only once setup succeeds, and only the user submits it.
			this.enterSetupPhase(text)
			void this.runSetup()
			return
		}

		this.chat.addChild(userMessage(text))
		// The first message hides the empty-state masthead; its cached height
		// must not survive into the conversation.
		this.invalidateHeader()
		await this.startRun(expandFileReferences(text, this.session.cwd))
	}

	/**
	 * Guides a task that arrived without a usable model into the existing
	 * `/model` setup, then hands the task back.
	 *
	 * The composer is the task's home for the whole detour: `restorePrompt` runs
	 * in a `finally`, so cancellation, a successful save, a failed save, an
	 * unreadable configuration and an unexpected throw all leave the task
	 * exactly where the user can submit it. Nothing runs by itself — the user
	 * decides when the task is ready to send — and the composer is replaced
	 * rather than appended to, so a repeated attempt cannot double the text.
	 * That replacement also clears whatever the setup prompts last left in the
	 * composer, which is the only thing that can be there: a command is only
	 * reachable after the editor has cleared itself, and its prompts own the
	 * editor while they are open.
	 */
	/**
	 * The gate, closed: no model is active, so the normal interface is not
	 * reachable. The setup flow runs here and only here.
	 *
	 * Every pass begins with a FRESH reading — never the stored reason, never a
	 * command's return value (the `/model` command returns nothing; it reports
	 * through notices) — so a retry after an external fix goes straight through,
	 * a configuration that broke in the meantime is reported, and a still-missing
	 * model comes back to the user's choice rather than reopening on its own.
	 *
	 * Total by construction: this runs on a promise nobody awaits (`start()` and
	 * `submit` both hand it off), so a rejection would end the process. The last
	 * resort is an exit, which is the closed direction.
	 */
	private async runSetup(): Promise<void> {
		let firstAttempt = true
		let shownError: string | null = null
		try {
			while (this.phase === "setup" && !this.exiting) {
				const readiness = await modelReadiness(this.options.agent)

				if (readiness.kind === "ready") {
					if (this.enterNormal()) return
					// The model is active but the workspace view could not be
					// opened. That is a failure like any other: the user decides,
					// and the loop never spins on it.
					this.setupReason = "view"
					this.setupPanel.setContent({
						heading: ["Workspace unavailable", "Your model is active, but the workspace could not be opened."],
						hints: "↑/↓ Select · Enter Confirm",
					})
					this.updateEditorSlot()
					if (!(await this.offerRecovery("Retry"))) return
					firstAttempt = false
					continue
				}

				this.setupReason = readiness.kind === "error" ? "error" : "missing"
				this.updateEditorSlot()
				if (readiness.kind === "error" && readiness.message !== shownError) {
					shownError = readiness.message
					this.setupPanel.setContent({
						heading: ["Model configuration", "LoongCode cannot read your model configuration."],
						problem: readiness.message,
						hints: "↑/↓ Select · Enter Confirm",
					})
					// Not an unconfigured installation: the configuration exists
					// and cannot be read. Naming the file is the whole remedy —
					// it is preserved, never repaired or replaced — so the full
					// message is kept in the transcript beneath the frame, where
					// a long path is not truncated.
					this.chat.addChild(errorNotice(readiness.message))
					this.tui.requestRender()
				}

				if (!firstAttempt) {
					// The previous attempt produced no model — cancelled, the
					// save failed, or the file is still broken. Never reopen on
					// our own: the user chooses, and leaving exits.
					const label = readiness.kind === "error" ? "Retry" : "Set up a model"
					const description = readiness.kind === "error"
						? "after correcting or removing that file"
						: undefined
					if (!(await this.offerRecovery(label, description))) return
				}
				firstAttempt = false

				if (readiness.kind === "missing") {
					// The sequence owns the screen until it saves or the user
					// leaves. A save does not open the gate by itself: the loop
					// re-reads, so entry is still decided by a fresh check.
					const outcome = await this.runSetupSequence(this.creationRun())
					if (outcome === "exited") {
						this.exitFromSetup()
						return
					}
				}
			}
		} catch (error) {
			// Nothing in the loop is expected to throw — the reading is total and
			// the command reports its own failures — so this is a last resort.
			// It ends the session rather than leaving a gate that might be open.
			this.chat.addChild(errorNotice(`model setup failed: ${error instanceof Error ? error.message : String(error)}`))
			this.tui.requestRender()
			this.exitFromSetup()
		}
	}

	/**
	 * Asks what to do after an attempt that did not produce a working session.
	 *
	 * This is the only way the flow ever repeats: the first attempt is
	 * automatic, every later one is the user's decision, and leaving the dialog
	 * ends the session. Returns true to try again.
	 */
	private async offerRecovery(againLabel: string, againDescription?: string): Promise<boolean> {
		const choice = await this.commandContext.pick("Model setup", [
			{ value: SETUP_AGAIN, label: againLabel, description: againDescription },
			{ value: SETUP_EXIT, label: "Exit", description: "LoongCode cannot run tasks without a model" },
		])
		if (choice === SETUP_AGAIN) return true
		this.exitFromSetup()
		return false
	}

	/**
	 * The approved setup sequence: protocol, service address, API key, model
	 * identifier, an unnumbered limits sub-step, a real model call, then an
	 * explicit save.
	 *
	 * The collected values live in one record that every step reads and writes,
	 * so Back and a retry return the user to what they had typed. Nothing is
	 * persisted until a call has actually succeeded AND the user has confirmed
	 * it — and the save action exists only on the success screen, so there is no
	 * route from a failed, cancelled or timed-out test to saving.
	 *
	 * What the run is *for* — creating a model or editing one — arrives in
	 * {@link SetupRunOptions}; the steps themselves are identical either way.
	 */
	private async runSetupSequence(options: SetupRunOptions): Promise<"saved" | "exited"> {
		const draft = options.draft
		let step: SetupStep = "protocol"

		for (;;) {
			switch (step) {
				case "protocol":
					step = await this.setupProtocolStep(draft, options)
					break
				case "endpoint":
					step = await this.setupFieldStep("endpoint", draft)
					break
				case "apiKey":
					step = options.keepExistingKey === true
						? await this.setupKeyStep(draft)
						: await this.setupFieldStep("apiKey", draft)
					break
				case "model":
					step = await this.setupFieldStep("model", draft)
					break
				case "limits":
					step = await this.setupLimitsStep(draft, options)
					break
				case "test":
					step = await this.setupTestStep(draft)
					break
				case "tested":
					step = await this.setupTestedStep(draft, options)
					break
				case "failed":
					step = await this.setupFailedStep()
					break
				case "saved":
					return "saved"
				case "exit":
					return "exited"
			}
		}
	}

	/** The options a run that creates a new model uses. */
	private creationRun(): SetupRunOptions {
		const first = SETUP_PROTOCOLS[0]!.value
		return {
			draft: {
				protocol: first,
				endpoint: SETUP_ENDPOINTS[first],
				apiKey: "",
				model: "",
				contextWindow: SETUP_DEFAULT_CONTEXT_WINDOW,
				maxOutputTokens: SETUP_DEFAULT_MAX_OUTPUT_TOKENS,
			},
			commit: draft => this.saveSetupConfig(draft),
			saveLabel: "Save and Enter Workspace",
			keepLimitsLabel: "Continue with defaults",
		}
	}

	/** Step 1 — the protocol. Esc here is the leave question, not a Back. */
	private async setupProtocolStep(draft: SetupDraft, options: SetupRunOptions): Promise<SetupStep> {
		const editing = options.cancelEdit === true
		this.setupPanel.setContent({
			heading: [options.heading ?? "Configure your model", "Select API protocol"],
			hints: editing ? "↑/↓ Select · Enter Next · Esc Cancel" : "↑/↓ Select · Enter Next · Esc Exit",
		})
		const chosen = await this.setupPick("Protocol", SETUP_PROTOCOLS, draft.protocol)
		if (chosen !== null && (chosen === "openai" || chosen === "anthropic")) {
			// The address default belongs to a protocol the user just switched
			// to. Merely confirming the one already there must not rewrite an
			// address the draft carries — an edit keeps the endpoint it saved.
			if (chosen !== draft.protocol) draft.endpoint = SETUP_ENDPOINTS[chosen]
			draft.protocol = chosen
			return "endpoint"
		}
		const leave = await this.setupPick(
			editing ? "Cancel the edit?" : "Leave setup?",
			[
				{ value: "stay", label: editing ? "Continue editing" : "Continue setup" },
				{
					value: "exit",
					label: editing ? "Cancel the edit" : "Exit LoongCode",
					...(editing ? {} : { description: "LoongCode cannot run tasks without a model" }),
				},
			],
		)
		return leave === "exit" ? "exit" : "protocol"
	}

	/**
	 * Steps 2–4 — the address, the key and the model identifier.
	 *
	 * Each is a single field with its own validation: a rejected value is
	 * reported on the step it belongs to and the input is kept, so correcting a
	 * typo never means retyping the rest.
	 */
	private async setupFieldStep(field: SetupFieldName, draft: SetupDraft): Promise<SetupStep> {
		const spec = SETUP_FIELDS[field]
		let problem: string | null = null
		for (;;) {
			this.setupPanel.setContent({
				step: spec.step,
				heading: [spec.heading],
				...(spec.note === undefined ? {} : { note: spec.note }),
				...(problem === null ? {} : { problem }),
				hints: spec.hints,
			})
			const value = await this.commandContext.ask(spec.heading, {
				// The panel above carries the prompt; a second copy in the status
				// row would point at the wrong end of the screen.
				quiet: true,
				secret: spec.secret,
				initialValue: draft[field],
			})
			if (value === null) return spec.back
			const trimmed = value.trim()
			problem = spec.validate(trimmed)
			if (problem !== null) continue
			draft[field] = trimmed
			return spec.next
		}
	}

	/**
	 * Step 3 of an edit — the key, without ever showing the stored one.
	 *
	 * The choice is made first, so the stored key never reaches a prompt or a
	 * label: keeping it is the default and changes nothing, and only a
	 * replacement is typed, into a masked field that starts empty. A draft that
	 * keeps its key still holds it, so escaping out of the replacement prompt
	 * cannot lose it.
	 */
	private async setupKeyStep(draft: SetupDraft): Promise<SetupStep> {
		const spec = SETUP_FIELDS.apiKey
		this.setupPanel.setContent({
			step: spec.step,
			heading: [spec.heading],
			note: "The stored key is not displayed.",
			hints: "↑/↓ Select · Enter Next · Esc Back",
		})
		const choice = await this.setupPick(
			"API key",
			[
				{ value: "keep", label: "Keep existing key" },
				{ value: "replace", label: "Enter a new key…" },
			],
			"keep",
		)
		if (choice === null) return "endpoint"
		if (choice === "keep") return "model"

		let problem: string | null = null
		for (;;) {
			this.setupPanel.setContent({
				step: spec.step,
				heading: [spec.heading],
				...(problem === null ? {} : { problem }),
				hints: "Enter Next · Esc Back",
			})
			const entered = await this.commandContext.ask(spec.heading, { quiet: true, secret: true })
			if (entered === null) return "endpoint"
			const trimmed = entered.trim()
			problem = spec.validate(trimmed)
			if (problem !== null) continue
			draft.apiKey = trimmed
			return "model"
		}
	}

	/**
	 * The limits sub-step, unnumbered: the numbered five steps the user walks
	 * are exactly the ones they always were.
	 *
	 * Escaping walks back the way the rest of the sequence does — out of a
	 * prompt to this choice, out of the choice to the model identifier — so the
	 * defaults stay reachable from anywhere inside the sub-step.
	 */
	private async setupLimitsStep(draft: SetupDraft, options: SetupRunOptions): Promise<SetupStep> {
		for (;;) {
			this.setupPanel.setContent({
				heading: ["Model limits", "How much context LoongCode plans requests against."],
				hints: "↑/↓ Select · Enter Next · Esc Back",
			})
			const choice = await this.setupPick("Model limits", [
				{
					value: "keep",
					label: `${options.keepLimitsLabel} (${draft.contextWindow} / ${draft.maxOutputTokens})`,
				},
				{ value: "configure", label: "Configure limits…" },
			])
			if (choice === null) return "model"
			if (choice === "keep") return "test"
			const applied = await this.promptForLimits(draft)
			if (applied === "back") return "model"
			if (applied === "cancelled") continue
			return "test"
		}
	}

	/**
	 * The two limit prompts, validated against the same rules the configuration
	 * schema enforces — a pair that would not validate is never carried into the
	 * connection test or the save.
	 */
	private async promptForLimits(draft: SetupDraft): Promise<"applied" | "back" | "cancelled"> {
		const contextWindow = await this.promptForLimit("Context window", draft.contextWindow, () => null)
		if (contextWindow === null) return "cancelled"
		const maxOutputTokens = await this.promptForLimit("Max output tokens", draft.maxOutputTokens, value =>
			value > contextWindow
				? `max output tokens (${value}) must not exceed the context window (${contextWindow})`
				: null,
		)
		if (maxOutputTokens === null) return "cancelled"
		draft.contextWindow = contextWindow
		draft.maxOutputTokens = maxOutputTokens
		return "applied"
	}

	/** One numeric field of the limits sub-step, reported on its own screen. */
	private async promptForLimit(
		heading: string,
		initial: number,
		validate: (value: number) => string | null,
	): Promise<number | null> {
		let problem: string | null = null
		for (;;) {
			this.setupPanel.setContent({
				heading: [heading],
				...(problem === null ? {} : { problem }),
				hints: "Enter Next · Esc Back",
			})
			const raw = await this.commandContext.ask(heading, { quiet: true, initialValue: String(initial) })
			if (raw === null) return null
			const trimmed = raw.trim()
			const parsed = Number(trimmed)
			if (trimmed.length === 0 || !Number.isInteger(parsed) || parsed <= 0) {
				problem = `${heading} must be a positive integer.`
				continue
			}
			problem = validate(parsed)
			if (problem !== null) continue
			return parsed
		}
	}

	/**
	 * Step 5 — a real request through the selected protocol.
	 *
	 * Nothing is persisted here, and nothing downstream can reach the save
	 * action: the outcome of this call is what decides which screen follows.
	 */
	private async setupTestStep(draft: SetupDraft): Promise<SetupStep> {
		this.setupPanel.setContent({
			step: "Step 5/5",
			heading: [
				"Testing model…",
				"",
				"● Sending test request",
				"● Waiting for model response",
			],
			hints: "Testing in progress. Please wait. · Esc Cancel test",
		})
		this.setupSelector = null
		this.updateEditorSlot()
		this.tui.requestRender()

		const cancel = new AbortController()
		const timeout = new AbortController()
		const timer = setTimeout(() => timeout.abort(), SETUP_TEST_TIMEOUT_MS)
		this.testAbort = cancel
		try {
			await testModelConnection(this.setupConfig(draft), {
				signal: AbortSignal.any([timeout.signal, cancel.signal]),
			})
			this.lastTestFailure = null
			return "tested"
		} catch (error) {
			this.lastTestFailure = describeTestFailure(error, cancel.signal.aborted, timeout.signal.aborted)
			return "failed"
		} finally {
			clearTimeout(timer)
			this.testAbort = null
		}
	}

	/** The success screen. Saving is an explicit choice made here and nowhere else. */
	private async setupTestedStep(draft: SetupDraft, options: SetupRunOptions): Promise<SetupStep> {
		this.setupPanel.setContent({
			heading: [
				"✓ Model test succeeded",
				"",
				`Protocol: ${protocolLabel(draft.protocol)}`,
				`Model:    ${draft.model}`,
				`Context:  ${draft.contextWindow} tokens`,
				`Output:   ${draft.maxOutputTokens} tokens`,
				"",
				"A valid model response was received.",
			],
			hints: "↑/↓ Select · Enter Confirm",
		})
		const choice = await this.setupPick("Model test succeeded", [
			{ value: "save", label: options.saveLabel },
			{ value: "edit", label: "Return to Edit Configuration" },
		])
		if (choice !== "save") return "model"

		const unsaved = await options.commit(draft)
		if (unsaved === null) return "saved"
		if (unsaved === "cancelled") return "model"

		// A configuration that could not be written is not a success: the user
		// stays in setup, told why, with the values still in hand.
		this.setupPanel.setContent({
			heading: [
				"✗ Could not save the configuration",
				"",
				`Details: ${unsaved}`,
				"",
				"Configuration is retained and can be corrected.",
			],
			hints: "↑/↓ Select · Enter Confirm",
		})
		const next = await this.setupPick("Save failed", [
			{ value: "edit", label: "Return to Edit Configuration" },
			{ value: "exit", label: "Exit LoongCode" },
		])
		return next === "exit" ? "exit" : "model"
	}

	/** The failure screen: the configuration is kept, and editing or retrying is offered. */
	private async setupFailedStep(): Promise<SetupStep> {
		const failure = this.lastTestFailure ?? {
			reason: "The model request failed.",
			details: "No model response was received.",
		}
		this.setupPanel.setContent({
			heading: [
				"✗ Model test failed",
				"",
				`Reason: ${failure.reason}`,
				`Details: ${failure.details}`,
				"",
				"Configuration is retained and can be corrected.",
			],
			hints: "↑/↓ Select · Enter Confirm",
		})
		const choice = await this.setupPick("Model test failed", [
			{ value: "edit", label: "Return to Edit Configuration" },
			{ value: "retry", label: "Retry Test" },
			{ value: "exit", label: "Exit LoongCode" },
		])
		if (choice === "retry") return "test"
		return choice === "exit" ? "exit" : "model"
	}

	/** The candidate configuration, in the shape the manager persists. */
	private setupConfig(draft: SetupDraft): ModelConfig {
		return {
			id: deriveModelId(draft.model),
			name: draft.model,
			protocol: draft.protocol,
			endpoint: draft.endpoint,
			model: draft.model,
			apiKey: draft.apiKey,
			contextWindow: draft.contextWindow,
			maxOutputTokens: draft.maxOutputTokens,
		}
	}

	/**
	 * Persists and activates the verified configuration.
	 *
	 * Returns null on success, `"cancelled"` when the user backed out of the
	 * id conflict prompt, and the failure message otherwise.
	 */
	private async saveSetupConfig(draft: SetupDraft): Promise<string | null> {
		const config = this.setupConfig(draft)
		let id = config.id
		try {
			const manager = await this.commandContext.agent().modelManager()
			const existing = new Set(manager.list().map(model => model.id))
			if (existing.has(id)) {
				// The local id is derived from the model identifier, so two
				// configurations for the same model name need a name of their
				// own. The user supplies it; no silent suffix is invented.
				const resolved = await this.askForSetupId(id, existing)
				if (resolved === null) return "cancelled"
				id = resolved
			}
			await this.commandContext.agent().configureModel({ ...config, id, name: id })
			return null
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
	}

	/** Asks for a local id that is not taken yet. */
	private async askForSetupId(taken: string, existing: ReadonlySet<string>): Promise<string | null> {
		let candidate = taken
		for (;;) {
			const raw = await this.commandContext.ask(
				`model "${candidate}" already exists — enter a different local model id:`,
			)
			if (raw === null) return null
			const next = raw.trim()
			if (next.length === 0 || next.startsWith("\u0000") || existing.has(next)) continue
			return next
		}
	}

	/**
	 * Shows a list inside the setup panel and resolves with the choice, or null
	 * when the user pressed Escape.
	 */
	private setupPick(
		title: string,
		items: readonly SelectorItem[],
		selectedValue?: string,
	): Promise<string | null> {
		const selector = new Selector(title, [...items], selectedValue)
		return new Promise<string | null>(resolve => {
			const close = (): void => {
				if (this.setupSelector !== selector) return
				this.setupSelector = null
				this.updateEditorSlot()
				this.tui.setFocus(this.editor)
				this.tui.requestRender()
			}
			selector.onSelect = value => {
				close()
				resolve(value)
			}
			selector.onCancel = () => {
				close()
				resolve(null)
			}
			this.setupSelector = selector
			this.updateEditorSlot()
			this.tui.setFocus(selector)
			this.tui.requestRender()
		})
	}

	/**
	 * Opens the gate, or reports why it could not be opened.
	 *
	 * Everything that can fail happens FIRST — building the workspace view — and
	 * the commit that follows is synchronous and calls nothing fallible, so a
	 * failure leaves the application in setup with nothing half-applied, and no
	 * input event can interleave with a partial transition. Returns false if the
	 * interface could not be restored.
	 */
	private enterNormal(): boolean {
		let transcript: Component[]
		let warning: Component | null
		try {
			transcript = this.buildTranscript()
			warning = this.buildWarning()
		} catch (error) {
			this.chat.addChild(errorNotice(
				`could not open the workspace view: ${error instanceof Error ? error.message : String(error)}`,
			))
			this.tui.requestRender()
			return false
		}

		// The commit: no `await`, nothing that can throw.
		this.chat.clear()
		for (const component of transcript) this.chat.addChild(component)
		this.invalidateHeader()
		this.warning.clear()
		if (warning !== null) this.warning.addChild(warning)
		this.editor.disableSubmit = false
		this.phase = "normal"
		// The task held back while the model was unavailable goes back to the
		// composer — for the user to submit, never to be run here.
		this.restorePrompt(this.pendingTask ?? "")
		this.pendingTask = null
		this.setupPanel.setPendingTask(null)
		this.updateEditorSlot()
		this.tui.setFocus(this.editor)
		this.updateFooter()
		void this.refreshFooterData()
		this.tui.requestRender()
		return true
	}

	/**
	 * Closes the gate and runs setup. `task` is held, never run.
	 *
	 * Reached mid-session when the model goes away, so the workspace that was
	 * open has to go with it: its transcript, its warning row and its footer
	 * figures are all cleared, and the footer is re-rendered from the setup
	 * state. Leaving any of them would show the workspace behind a gate that
	 * is supposed to be shut.
	 */
	private enterSetupPhase(task: string | null): void {
		if (task !== null) this.pendingTask = task
		this.phase = "setup"
		this.chat.clear()
		this.warning.clear()
		this.setupPanel.setPendingTask(this.pendingTask)
		this.chat.addChild(this.setupPanel)
		this.updateEditorSlot()
		this.updateFooter()
		this.tui.requestRender()
	}

	/**
	 * Leaves the session from setup.
	 *
	 * A task held back by the gate is not run and is not stored anywhere — the
	 * composer is not durable — so the user is told plainly, on the terminal
	 * they return to, that it was neither executed nor saved.
	 */
	private exitFromSetup(): void {
		this.exiting = true
		this.shutdown(this.pendingTask === null
			? "loongcode: model setup was cancelled.\n"
			: "loongcode: model setup was cancelled — your task was not run and has not been saved.\n")
	}

	/**
	 * Fills the composer slot: the editor in the normal phase, and while the
	 * gate is closed the setup state in its place — except during a prompt,
	 * whose value is typed into the editor.
	 */
	private updateEditorSlot(): void {
		this.editorSlot.clear()
		// The composer's prompt gutter belongs to the workspace input, not to the
		// setup field it is also used as; it is present exactly while the gate is
		// open.
		this.editor.setPrompt(this.phase === "normal" ? COMPOSER_PROMPT : undefined)
		if (this.phase === "setup") {
			// Setup owns the screen: the list or the field is part of the setup
			// panel, and the composer slot stays empty — there is no workspace
			// composer to type a task into yet.
			const field = this.askState !== null ? this.editor : this.setupSelector
			this.setupPanel.setInput(field)
			// Enter reaches the editor only while it is the setup field.
			this.editor.disableSubmit = field !== this.editor
			return
		}
		this.setupPanel.setInput(null)
		// A prompt is typed into this editor and submitted with Enter, so
		// submit is enabled for exactly the states that show it.
		this.editor.disableSubmit = false
		this.editorSlot.addChild(this.editor)
	}

	private async startRun(text: string): Promise<void> {
		this.running = true
		this.display = NO_RUN_DISPLAY
		// The new run measures its own context and produces its own figures, so
		// the previous reading's provenance stops being reported.
		this.contextCleared = false
		this.runBeforeRewind = false
		this.abort = new AbortController()

		let aborted = false
		let termination: "aborted" | "error" | "complete" = "complete"
		try {
			// The model is resolved per run, so the footer's budget is refreshed
			// here: a switch made by /model or Ctrl-P must not leave it stale.
			// This is the first statement of the protected region rather than the
			// last of the prelude: a failure while preparing the run must reach
			// the same `finally` as a failure during it, or `running` would stay
			// set and every later task would be swallowed as steering.
			await this.refreshFooterData()
			this.showSpinner("working… (esc to interrupt)")
			const result = await this.options.agent.run(this.session, text, {
				signal: this.abort.signal,
				onEvent: event => this.handleRunEvent(event),
			})
			aborted = result.aborted
			if (aborted) termination = "aborted"
			if (aborted) this.chat.addChild(notice("run aborted"))
		} catch (err) {
			termination = "error"
			this.chat.addChild(errorNotice(err instanceof Error ? err.message : String(err)))
		} finally {
			this.running = false
			this.abort = null
			this.finalizeStreaming()
			// A run that terminated abnormally (abort or error) may leave a tool
			// whose result never arrived still showing `running`. Mark exactly
			// those interrupted; a normal completion has already resolved every
			// call, so nothing is relabelled.
			if (termination !== "complete") this.settlePendingTools(termination)
			this.currentBlock = null
			this.currentIteration = undefined
			this.hideSpinner()
			this.updateFooter()
			this.tui.setFocus(this.editor)
			this.tui.requestRender()
		}
	}

	private abortRun(): void {
		if (this.abort !== null) {
			this.abort.abort()
			this.tui.requestRender()
		}
	}

	// ── RunEvent → UI (the single event adapter) ─────────────────────

	private handleRunEvent(event: RunEvent): void {
		// The display facts are folded from the runtime's own events, once.
		this.display = reduceRunDisplay(this.display, event)
		switch (event.type) {
			case "run_start":
				break
			case "iteration_start":
				// A new model iteration begins. The next content opens a fresh
				// block under this number; nothing is emitted until it does, so an
				// iteration that produces neither text nor a tool call leaves no
				// empty block behind.
				this.currentIteration = event.iteration
				this.currentBlock = null
				this.loader.setMessage("working… (esc to interrupt)")
				this.updateFooter()
				break
			case "assistant_delta": {
				const block = this.ensureBlock()
				if (this.streaming === null) {
					this.streaming = new Container()
					this.streamingText = ""
					// One renderer for the whole streamed message, updated in place.
					// The delta path used to build a renderer and a theme per chunk;
					// the renderer is now kept, so a chunk costs an `setText` rather
					// than an allocation. (The growing text is still reparsed as it
					// arrives — that is inherent to streaming without incremental
					// Markdown — but no renderer is discarded per chunk.)
					this.streamingMarkdown = new Markdown("", 0, 0, markdownTheme())
					this.streaming.addChild(this.streamingMarkdown)
					block.addChild(this.streaming)
				}
				this.streamingText += event.text
				this.streamingMarkdown!.setText(this.streamingText)
				// The block grew: its cached height must be re-measured next frame.
				this.chat.invalidateChild(block)
				break
			}
			case "reasoning_delta": {
				// Internal reasoning is never shown; only a generic indicator that
				// one is in progress, and only once per iteration.
				if (this.reasoning === null) {
					this.reasoning = new Container()
					this.reasoning.addChild(new Text(theme.muted("… thinking"), 0, 0))
					const block = this.ensureBlock()
					block.addChild(this.reasoning)
					this.chat.invalidateChild(block)
				}
				break
			}
			case "steered":
				this.chat.addChild(notice("steered"))
				break
			case "model_response": {
				const last = this.session.lastAssistant()
				const text = last !== undefined
					? last.content.filter(part => part.type === "text").map(part => part.text).join("")
					: ""
				if (this.streaming !== null) {
					this.streaming.clear()
					if (text.trim().length > 0) this.streaming.addChild(assistantMessage(text))
					this.streaming = null
					this.streamingMarkdown = null
					if (this.currentBlock !== null) this.chat.invalidateChild(this.currentBlock)
				} else if (text.trim().length > 0) {
					const block = this.ensureBlock()
					block.addChild(assistantMessage(text))
					this.chat.invalidateChild(block)
				}
				break
			}
			case "tool_call": {
				const component = new ToolExecutionComponent(
					event.toolCallId,
					event.name,
					event.input,
					this.currentIteration,
				)
				const block = this.ensureBlock()
				this.pendingTools.set(event.toolCallId, { component, block })
				block.addChild(component)
				this.chat.invalidateChild(block)
				break
			}
			case "tool_progress": {
				const pending = this.pendingTools.get(event.toolCallId)
				if (pending !== undefined) {
					pending.component.setProgress(event.text)
					this.chat.invalidateChild(pending.block)
					this.tui.requestRender()
				}
				break
			}
			case "tool_result": {
				const pending = this.pendingTools.get(event.toolCallId)
				if (pending !== undefined) {
					// Duration is the runtime's; the TUI never times a tool itself.
					pending.component.setResult(event.ok, event.result, event.durationMs)
					pending.component.setExpanded(this.toolsExpanded)
					this.pendingTools.delete(event.toolCallId)
					this.chat.invalidateChild(pending.block)
				}
				break
			}
			case "compaction":
				this.chat.addChild(notice(compactionNoticeText(event.summarizedMessages, event.usage)))
				break
			case "compaction_skipped":
				// The history could not shrink. Not necessarily fatal — the
				// projection recovery below may follow — but always stated.
				this.chat.addChild(notice(compactionSkippedNoticeText(event.reason, event.trigger)))
				break
			case "projection_reduced":
				this.chat.addChild(notice(projectionReducedNoticeText(event.reduced, event.originalBytes)))
				break
			case "auto_retry":
				this.loader.setMessage(
					`provider busy — retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s… (esc to interrupt)`,
				)
				break
			case "recovery":
				this.chat.addChild(notice(event.note.split("\n")[0] ?? "recovered from interruption"))
				break
			case "run_end": {
				// The failure that ended the run, in full, before the summary.
				if (event.run.error !== undefined) this.chat.addChild(errorNotice(event.run.error))

				// The runtime's own record, rendered as sent — no value here is
				// recomputed, and the record itself states how the run ended. The
				// summary reports the authoritative model-call count; the footer's
				// live run figures reset when the next run starts.
				for (const line of runSummaryLines(event.run)) {
					this.chat.addChild(notice(line))
				}
				break
			}
		}
		this.updateFooter()
		this.tui.requestRender()
	}

	/**
	 * The block the live run is currently filling, created on first content.
	 *
	 * A block is opened lazily so an iteration that emits neither text nor a
	 * tool call never leaves an empty gutter behind, and the number attached is
	 * the iteration that was actually in flight when the content arrived.
	 */
	private ensureBlock(): IterationBlock {
		if (this.currentBlock === null) {
			this.currentBlock = new IterationBlock(this.currentIteration)
			this.chat.addChild(this.currentBlock)
		}
		return this.currentBlock
	}

	/**
	 * Marks any tool whose result never arrived as interrupted, then forgets it.
	 *
	 * Only a run that terminated without delivering every result leaves entries
	 * in `pendingTools`; a call that received its result was already removed, so
	 * a completed tool is never relabelled here. `reason` records the actual
	 * termination so the sweep is not applied to a run that finished normally.
	 */
	private settlePendingTools(reason: "aborted" | "error"): void {
		if (this.pendingTools.size === 0) return
		for (const pending of this.pendingTools.values()) {
			pending.component.setInterrupted()
			this.chat.invalidateChild(pending.block)
		}
		this.pendingTools.clear()
	}

	private finalizeStreaming(): void {
		if (this.streaming !== null) {
			this.streaming.clear()
			if (this.streamingText.trim().length > 0) {
				this.streaming.addChild(assistantMessage(this.streamingText))
			}
			this.streaming = null
			this.streamingText = ""
			this.streamingMarkdown = null
		}
	}

	// ── status / footer ──────────────────────────────────────────────

	private showSpinner(label: string): void {
		this.status.clear()
		this.loader.setMessage(label)
		this.status.addChild(this.loader)
		this.loader.start()
	}

	private hideSpinner(): void {
		this.loader.stop()
		this.status.clear()
	}

	private updateFooter(): void {
		const lines = footerRows({
			cwd: this.session.cwd,
			branch: this.gitBranch,
			running: this.running,
			compacting: this.compacting,
			modelId: this.modelId,
			limits: this.modelLimits,
			modelMissing: this.readiness?.kind === "missing",
			// While the gate is closed the footer describes setup, not a
			// workspace that is not open: the projection drops everything the
			// workspace produced, including the run figures seeded from a
			// previous session. They come back with the transition.
			setup: this.phase === "setup",
			compactThresholdPct: this.compactThresholdPct,
			lastCallUsage: this.display.lastCallUsage,
			runRequests: this.display.runRequests,
			runUsage: this.display.runUsage,
			lastRun: this.display.lastRun,
			compactedMessages: this.display.compactedMessages,
			contextCleared: this.contextCleared,
			runBeforeRewind: this.runBeforeRewind,
		})
		this.footerRow1.setRow(lines.row1)
		// The usage row is always set; whether it is shown is decided at render
		// time from the live terminal height (`footerRow2`'s visibility).
		this.footerRow2.setRow(lines.row2)
		this.tui.requestRender()
	}

	/**
	 * Re-renders the persistent warning row from the session's own state.
	 *
	 * Read from the session rather than from a flag set at rewind time, so a
	 * switch, a reload and a rewind all render the same fact the same way.
	 */
	private updateWarning(): void {
		this.warning.clear()
		const line = this.buildWarning()
		if (line !== null) this.warning.addChild(line)
	}

	/** The session warning row, or null when the session has nothing to warn
	 *  about. Built separately so opening the gate can construct it before it
	 *  commits to anything. */
	private buildWarning(): Component | null {
		const note = this.session.rewind
		if (note === null || note.shellTurns === 0) return null
		return new Text(`  ${theme.warning(shellWarningText(note))}`, 1, 0)
	}

	private async refreshFooterData(): Promise<void> {
		// Re-read per run and on every model switch: the footer must describe
		// the model actually in use, never a previous one. Total by
		// construction — an unreadable configuration is reported by the footer,
		// never thrown at a caller that is not waiting to catch it.
		this.readiness = await modelReadiness(this.options.agent)
		const model = this.readiness.kind === "ready" ? this.readiness.model : undefined
		this.modelId = model?.id
		this.modelLimits = model?.limits
		try {
			this.compactThresholdPct = loadSettings(this.session.cwd).settings.autoCompact?.thresholdPct
		} catch {
			// A malformed settings file must not break the footer. Without a
			// threshold the context segment omits it rather than guessing one.
			this.compactThresholdPct = undefined
		}
		try {
			const proc = spawnSync("git", ["-C", this.session.cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" })
			if (proc.status === 0 && typeof proc.stdout === "string") {
				this.gitBranch = proc.stdout.trim() || undefined
			}
		} catch {
			// Not a git repository — footer omits the branch.
		}
		this.updateFooter()
	}

	// ── session manager (/session) ───────────────────────────────────

	/** True while a run or a manual compaction owns the active session. */
	private sessionBusy(): boolean {
		return this.running || this.compacting
	}

	private notifySessionBusy(): void {
		this.chat.addChild(notice(this.running
			? "a task is running — finish it before managing sessions"
			: "a compaction is in progress — wait for it to finish"))
		this.tui.requestRender()
	}

	/**
	 * The workspace-scoped candidate set: persisted sessions whose `cwd` matches
	 * the active workspace. The active session is included even when it has not
	 * been persisted yet (a fresh session is only written on its first
	 * checkpoint), so it is always visible — without ever widening the boundary.
	 */
	private async scopedSessions(workspace: string): Promise<ScopedSessionSummary[]> {
		const summaries = await this.options.agent.sessionSummaries()
		const scoped: ScopedSessionSummary[] = workspaceSessions(summaries, workspace)
		if (!scoped.some(session => session.id === this.session.id) && this.session.cwd === workspace) {
			scoped.unshift(this.summaryOf(this.session))
		}
		return scoped
	}

	private summaryOf(session: Session): ScopedSessionSummary {
		const firstUser = session.messages.find(message => message.role === "user")
		return {
			id: session.id,
			cwd: session.cwd,
			cwdPresent: true,
			title: session.title,
			parentSessionId: session.parentSessionId,
			updatedAt: session.updatedAt,
			messageCount: session.messages.length,
			firstUser: firstUser !== undefined && typeof firstUser.content === "string" ? firstUser.content.slice(0, 60) : null,
		}
	}

	/** Loads a session only if it belongs to the scoped candidate set. */
	private async loadScopedSession(scoped: readonly ScopedSessionSummary[], id: string): Promise<Session | null> {
		if (!scoped.some(session => session.id === id)) return null
		if (id === this.session.id) return this.session
		try {
			return await this.options.agent.loadSession(id)
		} catch {
			return null
		}
	}

	private openSessionManager(sessions: readonly ScopedSessionSummary[]): Promise<SessionManagerAction> {
		const manager = new SessionManager(sessions, this.session.id, `Sessions · ${this.session.cwd}`)
		return new Promise<SessionManagerAction>(resolve => {
			const close = (action: SessionManagerAction): void => {
				if (this.manager !== manager) return
				this.manager = null
				this.picker.setComponent(null)
				this.tui.setFocus(this.editor)
				this.tui.requestRender()
				resolve(action)
			}
			manager.onAction = close
			this.manager = manager
			this.picker.setComponent(manager)
			this.tui.setFocus(manager)
			this.tui.requestRender()
		})
	}

	/**
	 * Drives `/session`: open the workspace-scoped manager, execute the chosen
	 * action, and reopen it after operations that stay within management. All
	 * session mutations and switches are guarded against an active run, both on
	 * open and again before each operation.
	 */
	/**
	 * `/rewind`: pick a checkpoint, pick an action, apply it.
	 *
	 * Nothing is restored by selecting a checkpoint — the action menu is a
	 * second, explicit step, and every destructive action is confirmed. A run
	 * in flight refuses the whole flow: rewinding history underneath a live run
	 * would leave it describing turns that no longer exist.
	 */
	private async runRewind(): Promise<void> {
		if (this.running) {
			this.notifyRewindRefused("a run is in progress — press esc to interrupt it first")
			return
		}
		if (this.compacting) {
			this.notifyRewindRefused("a compaction is in progress — wait for it to finish")
			return
		}

		const stored = await this.checkpointStore.load(this.session.id)
		// An index is not an identity: a rewind frees indices that the next turn
		// reuses, so a record is offered only while it still anchors to the turn
		// it was opened for.
		const usable = liveCheckpoints(stored, this.session.messages)
		if (usable.length === 0) {
			this.chat.addChild(notice(stored.length === 0
				? "nothing to rewind to yet — checkpoints are created per prompt"
				: "nothing to rewind to — earlier checkpoints no longer match this conversation"))
			this.tui.requestRender()
			return
		}

		const chosen = await this.commandContext.pick(
			"Rewind to",
			[...usable].reverse().map(checkpoint => ({
				value: checkpoint.id,
				label: truncateForRow(checkpoint.prompt),
				description: [
					// A turn that touched no file shows no count: "0 files"
					// names an absence as if it were a result, and most turns
					// are ordinary conversation.
					...(checkpoint.files.length > 0 ? [plural(checkpoint.files.length, "file", "files")] : []),
					// Only a positive count is a fact; an absent one predates
					// shell tracking and claims nothing either way.
					...(checkpoint.shell !== undefined && checkpoint.shell > 0
						? [plural(checkpoint.shell, "shell command", "shell commands")]
						: []),
					new Date(checkpoint.createdAt).toLocaleTimeString(),
				].join(" · "),
			})),
		)
		if (chosen === null) return
		const checkpoint = usable.find((c: Checkpoint) => c.id === chosen)
		if (checkpoint === undefined) return

		const action = await this.commandContext.pick("Rewind action", [
			{ value: "both", label: "Restore code and conversation", description: "undo the turn, files included" },
			{ value: "conversation", label: "Restore conversation", description: "keep the files as they are" },
			{ value: "code", label: "Restore code", description: "keep the conversation as it is" },
			{ value: "summary-from", label: "Summarize from here", description: "replace this turn onward with a summary" },
			{ value: "summary-up-to", label: "Summarize up to here", description: "replace everything before this turn" },
			{ value: "cancel", label: "Cancel", description: "change nothing" },
		])
		if (action === null || action === "cancel") return

		await this.applyRewind(checkpoint, action, stored)
	}

	/**
	 * Records that history changed underneath the footer's readings.
	 *
	 * The context gauge describes how full the *current* context is, and that
	 * reading was taken before the rewrite, so it is dropped rather than
	 * presented as current. Clearing only the reading — not `runRequests`,
	 * `runUsage` or `lastRun` — leaves the session's genuine execution history
	 * intact; the gauge returns with the next real measurement, and the run
	 * figures are relabelled rather than adjusted.
	 */
	private forgetStaleAfterRewrite(historyChanged: boolean): void {
		// A rewrite that changed nothing leaves the reading exactly as valid as
		// it was: claiming it went stale would be its own small lie.
		if (!historyChanged) return
		this.display = { ...this.display, lastCallUsage: undefined }
		this.contextCleared = true
		this.runBeforeRewind = true
	}

	/**
	 * Persists what a rewrite did to the checkpoint lineage, and what it
	 * discarded that cannot be undone.
	 *
	 * The tombstone write and the session's warning are one commit: a warning
	 * that outlived its tombstones (or the reverse) would describe a state that
	 * never existed.
	 */
	private async commitAdvance(advance: CheckpointAdvance): Promise<string | null> {
		// The conversation has already changed, so the in-memory record of it
		// changes with it. Only persistence can fail from here.
		recordRewind(this.session, advance.discarded)
		this.updateWarning()
		try {
			await this.checkpointStore.save(this.session.id, advance.next)
			await this.session.checkpoint()
			return null
		} catch (err) {
			// Reporting this as a failed rewind would be false — it happened.
			return `the change was applied, but its checkpoint record could not be saved (${err instanceof Error ? err.message : String(err)}) — later rewinds may still offer these turns`
		}
	}

	/** Applies one chosen rewind action and reports exactly what happened. */
	private async applyRewind(checkpoint: Checkpoint, action: string, stored: readonly Checkpoint[]): Promise<void> {
		try {
			if (action === "code") {
				// Files only: the conversation, and so every checkpoint and the
				// session's warning, are exactly as they were.
				const outcome = await rewindSession(this.session, checkpoint, "code")
				this.chat.addChild(notice(describeFiles(outcome.files)))
				this.tui.requestRender()
				return
			}

			// Where this checkpoint's turn begins NOW. Derived from the turn's
			// identity rather than the index stored with the checkpoint, which
			// a compaction or an earlier rewind may have invalidated.
			const boundary = turnIndexOf(this.session.messages, checkpoint.turnId)
			if (boundary < 0) {
				this.chat.addChild(errorNotice("rewind: that turn is no longer in this conversation"))
				this.tui.requestRender()
				return
			}
			// "Summarize up to here" replaces what is above the checkpoint;
			// everything else cuts from the checkpoint down.
			const from = action === "summary-up-to" ? 0 : boundary
			const to = action === "summary-up-to" ? boundary : this.session.messages.length

			if (action === "summary-from" || action === "summary-up-to") {
				await this.summarizeHistory(from, to, stored)
				return
			}

			const outcome = await rewindSession(this.session, checkpoint, action === "both" ? "both" : "conversation")
			const advance = discardTurns(stored, outcome.removedTurnIds)
			const unsaved = await this.commitAdvance(advance)
			this.forgetStaleAfterRewrite(outcome.removedMessages > 0)
			this.chat.clear()
			this.pendingTools.clear()
			this.replaySession()
			// The three facts, each stated once: what happened to the
			// conversation, to tracked files, and to everything a shell did.
			// With no discarded turn there is no shell fact to state: a turn
			// that ran a command always has a record now.
			this.chat.addChild(notice(describeFiles(outcome.files)))
			if (advance.discarded.length > 0) this.chat.addChild(notice(describeShell(advance.discarded)))
			this.restorePrompt(checkpoint.prompt)
			this.chat.addChild(notice(`rewound ${plural(outcome.removedMessages, "message", "messages")} — the prompt is back in the composer`))
			if (unsaved !== null) this.chat.addChild(errorNotice(unsaved))
			this.tui.requestRender()
		} catch (err) {
			this.chat.addChild(errorNotice(`rewind failed: ${err instanceof Error ? err.message : String(err)}`))
			this.tui.requestRender()
		}
	}

	/** Summarizes `[from, to)` and reports the result; the files are untouched. */
	private async summarizeHistory(from: number, to: number, stored: readonly Checkpoint[]): Promise<void> {
		const range = this.session.messages.slice(from, to)
		const text = await this.options.agent.summarize(
			range.map(m => ({ role: m.role, content: m.content }) as ModelMessage),
		)
		// `summarizeRange` re-checks the boundaries and refuses a range that
		// would split a turn, so a bad selection cannot corrupt the history.
		const outcome = await summarizeRange(this.session, from, to, async () => text)
		// The rewrite reports the turns it removed; those, and only those, are
		// what this operation discarded.
		const advance = discardTurns(stored, outcome.removedTurnIds)
		const unsaved = await this.commitAdvance(advance)
		this.forgetStaleAfterRewrite(outcome.replaced > 0)
		this.chat.clear()
		this.pendingTools.clear()
		this.replaySession()
		if (advance.discarded.length > 0) this.chat.addChild(notice(describeShell(advance.discarded)))
		this.chat.addChild(notice(`summarized ${plural(outcome.replaced, "message", "messages")}; files unchanged`))
		if (unsaved !== null) this.chat.addChild(errorNotice(unsaved))
		this.tui.requestRender()
	}

	private notifyRewindRefused(reason: string): void {
		this.chat.addChild(errorNotice(`cannot rewind: ${reason}`))
		this.tui.requestRender()
	}

	/** Puts a rewound prompt back in the composer so it can be edited and resent. */
	private restorePrompt(prompt: string): void {
		this.editor.setText(prompt)
	}

	private async runSessionManager(): Promise<void> {
		if (this.sessionBusy()) {
			this.notifySessionBusy()
			return
		}
		const workspace = this.session.cwd

		for (;;) {
			const scoped = await this.scopedSessions(workspace)
			const action = await this.openSessionManager(scoped)

			if (action.kind === "close") return
			// A run may have started while the manager was open; refuse rather
			// than race it. Management follows the same busy contract as /compact.
			if (this.sessionBusy()) {
				this.notifySessionBusy()
				return
			}

			switch (action.kind) {
				case "switch": {
					if (action.id === this.session.id) return
					const next = await this.loadScopedSession(scoped, action.id)
					if (next === null) {
						this.chat.addChild(errorNotice("that session is no longer available"))
						this.tui.requestRender()
						continue
					}
					this.setActiveSession(next)
					this.chat.addChild(notice(`switched to session ${next.id.slice(0, 8)}`))
					return
				}
				case "rename": {
					const target = await this.loadScopedSession(scoped, action.id)
					if (target === null) {
						this.chat.addChild(errorNotice("that session is no longer available"))
						this.tui.requestRender()
						continue
					}
					const input = await this.commandContext.ask("Rename session", { initialValue: target.title ?? "" })
					if (input === null) continue
					const title = input.trim()
					if (title.length === 0) {
						this.chat.addChild(errorNotice("session title cannot be empty"))
						this.tui.requestRender()
						continue
					}
					try {
						await target.setTitle(title)
						this.chat.addChild(notice(`session renamed: ${title}`))
					} catch (error) {
						this.chat.addChild(errorNotice(`rename failed: ${error instanceof Error ? error.message : String(error)}`))
					}
					this.tui.requestRender()
					continue
				}
				case "delete": {
					if (action.id === this.session.id) {
						this.chat.addChild(errorNotice("cannot delete the current session"))
						this.tui.requestRender()
						continue
					}
					// The boundary holds at the operation site, not just in the
					// component: only an id from the scoped set may be deleted.
					if (!scoped.some(session => session.id === action.id)) {
						this.chat.addChild(errorNotice("that session is no longer available"))
						this.tui.requestRender()
						continue
					}
					try {
						await this.options.agent.deleteSession(action.id)
					} catch (error) {
						this.chat.addChild(errorNotice(`delete failed: ${error instanceof Error ? error.message : String(error)}`))
						this.tui.requestRender()
						continue
					}
					// `SessionStore.delete` swallows errors, so a normal return is
					// not proof. Re-enumerate and treat a surviving id as failure.
					const remaining = await this.scopedSessions(workspace)
					if (remaining.some(session => session.id === action.id)) {
						this.chat.addChild(errorNotice("delete failed: the session is still present"))
						this.tui.requestRender()
						continue
					}
					this.chat.addChild(notice("session deleted"))
					this.tui.requestRender()
					continue
				}
				case "fork": {
					const parent = await this.loadScopedSession(scoped, action.id)
					if (parent === null) {
						this.chat.addChild(errorNotice("that session is no longer available"))
						this.tui.requestRender()
						continue
					}
					const candidates = forkCandidates(parent)
					if (candidates.length === 0) {
						this.chat.addChild(notice("nothing to fork yet"))
						this.tui.requestRender()
						continue
					}
					const chosen = await this.commandContext.pick(
						"Fork from message",
						candidates.map(candidate => ({
							value: String(candidate.index),
							label: candidate.label,
							description: candidate.description,
						})),
					)
					if (chosen === null) continue
					const cut = Number(chosen) + 1
					try {
						const forked = await forkSession(this.options.agent, parent, cut)
						this.setActiveSession(forked)
						this.chat.addChild(notice(`forked session ${forked.id.slice(0, 8)} from message #${cut}`))
					} catch (error) {
						this.chat.addChild(errorNotice(`fork failed: ${error instanceof Error ? error.message : String(error)}`))
						this.tui.requestRender()
						continue
					}
					return
				}
				case "clone": {
					const source = await this.loadScopedSession(scoped, action.id)
					if (source === null) {
						this.chat.addChild(errorNotice("that session is no longer available"))
						this.tui.requestRender()
						continue
					}
					try {
						const clone = await cloneSession(this.options.agent, source)
						this.setActiveSession(clone)
						this.chat.addChild(notice(`cloned into session ${clone.id.slice(0, 8)}`))
					} catch (error) {
						this.chat.addChild(errorNotice(`clone failed: ${error instanceof Error ? error.message : String(error)}`))
						this.tui.requestRender()
						continue
					}
					return
				}
			}
		}
	}

	// ── session replay ───────────────────────────────────────────────

	private replaySession(): void {
		for (const component of this.buildTranscript()) this.chat.addChild(component)
		// A replayed session almost always holds messages, so the masthead's
		// cached height (the empty-state banner) no longer applies.
		this.invalidateHeader()
	}

	/**
	 * Re-measures the masthead.
	 *
	 * The header's height is not fixed: it renders the empty-state banner while
	 * the session holds no messages, and zero rows afterwards. That flip is not
	 * a mutation the windowed transcript can observe, so it is announced here at
	 * the points where the message count can change.
	 */
	private invalidateHeader(): void {
		if (this.header !== null) this.transcript?.invalidateChild(this.header)
	}

	/**
	 * The workspace view as components, built but not applied.
	 *
	 * Separate from `replaySession` so entering the normal phase can build
	 * everything that might fail before it commits to anything: a failure here
	 * leaves the application in setup rather than half-way into a workspace.
	 */
	private buildTranscript(): Component[] {
		const components: Component[] = []
		const resultsByCallId = new Map<string, { ok: boolean; result: string }>()
		for (const message of this.session.messages) {
			if (message.role !== "tool") continue
			for (const result of message.content) {
				const text = result.output.type === "json"
					? JSON.stringify(result.output.value) ?? ""
					: result.output.text
				resultsByCallId.set(result.toolCallId, {
					ok: result.output.type !== "tool_error",
					result: text,
				})
			}
		}
		for (const message of this.session.messages) {
			for (const component of replayMessage(message, resultsByCallId)) {
				components.push(component)
			}
		}
		if (this.session.needsRecovery()) {
			components.push(notice("interrupted run detected — it will be reconciled on the next task"))
		}
		return components
	}

	// ── lifecycle ────────────────────────────────────────────────────

	/**
	 * Starts the interface.
	 *
	 * The gate opens here, not in the constructor: the terminal's input handler
	 * is only installed by `tui.start()` (`TuiBase.start`), so an interactive
	 * flow begun earlier would render onto the normal screen before the
	 * alternate screen is entered — and then wait forever for a keystroke that
	 * could never arrive.
	 */
	start(): void {
		this.tui.start()
		this.updateFooter()
		if (this.phase === "setup") {
			this.tui.requestRender()
			void this.runSetup()
			return
		}
		this.tui.setFocus(this.editor)
	}

	stop(): void {
		this.tui.stop()
	}
}

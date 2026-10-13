import type { CompactionOutcome, Session } from "@loongcode/agent"

/**
 * Outcome of a manual `/compact`, including cases the compaction layer cannot
 * report on its own: no model configured, and a compaction already in flight.
 *
 * Deliberately a union rather than a boolean: "nothing to compact", "no model",
 * "already running" and "compaction failed" must not render the same message.
 */
export type CompactResult =
  | CompactionOutcome
  | { readonly status: "no-model" }
  | { readonly status: "busy"; readonly reason: "compacting" | "running" }

/** Facade the commands act through — implemented by the TUI app. */
export interface CommandContext {
  agent(): import("@loongcode/agent").LoongCode
  session(): Session
  /** Replaces the active session (new/switch/fork/clone) and replays it. */
  setSession(session: Session): void
  /** Shows a notice / error line in the chat. */
  notify(text: string, isError?: boolean): void
  /** Opens an inline selector and resolves with the chosen value.
   *  `options.selectedValue` highlights an existing choice when it opens. */
  pick(
    title: string,
    items: Array<{ value: string; label: string; description?: string }>,
    options?: { selectedValue?: string },
  ): Promise<string | null>
  /** Prompts for a single line of input (status-prompt style). `secret` masks
   *  the typed text so credentials are never echoed. `initialValue` pre-fills
   *  the editor (used to seed a rename with the current title). `quiet` omits
   *  the status-row label, for a caller that already shows the prompt beside
   *  the input. */
  ask(label: string, options?: { secret?: boolean; initialValue?: string; quiet?: boolean }): Promise<string | null>
  /**
   * Opens the interactive, workspace-scoped session manager (`/session`). The
   * application owns the whole interaction and all session mutations; this is
   * the command's only hook into it.
   */
  manageSessions(): Promise<void>
  /**
   * Runs the model setup sequence — protocol, service address, API key, model
   * identifier, a real model call, then an explicit save. Resolves true when a
   * model was saved and activated. The application owns the whole interaction;
   * this is the command's only hook into it.
   */
  configureModel(): Promise<boolean>
  /** Runs the model-based context compaction immediately. */
  compact(): Promise<CompactResult>
  /**
   * Opens the `/rewind` flow: pick a checkpoint, pick an action, apply it.
   * The application owns the interaction and the session mutation; this is the
   * command's only hook into it.
   */
  rewind(): Promise<void>
  /** Submits a task through the normal run path (used by templates). */
  submitTask(text: string): Promise<void>
  /**
   * Shuts the UI down through its own lifecycle (leaving the fullscreen screen
   * and restoring the terminal) before exiting. Commands must use this rather
   * than calling `process.exit` directly.
   */
  quit(): void
}

export interface Command {
  readonly name: string
  readonly description: string
  /** Syntax/documentation shown by `/help`, e.g. `<title>`. */
  readonly argumentHint?: string
  /**
   * User-facing inline UI copy shown as a muted ghost placeholder in the
   * composer while the command has no argument yet, e.g. `Name…`. Distinct
   * from `argumentHint`: it is presentation copy, not syntax, and is only set
   * for commands with a simple required argument.
   */
  readonly argumentPlaceholder?: string
  execute(ctx: CommandContext, args: string): Promise<void> | void
}

// ── model management (/model) ────────────────────────────────────────
//
// `/model` is the sole model surface: it opens a picker that selects the active
// model and offers `Add model…` as the only configuration action. The runtime
// store (ModelManager) is the source of truth for the configured models; these
// helpers only drive the picker/prompt interaction.

/** Picker action value for the `Add model…` row. Control-character prefixed so
 *  it can never collide with a user-chosen model id. */
const MODEL_ADD = "\u0000model:add"

/** A user-facing message derived from a thrown value. Never contains secrets:
 *  ModelError messages carry no API key (see @loongcode/model). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const COMMANDS: Command[] = [
  {
    name: "help",
    description: "Show available commands",
    execute(ctx) {
      const lines = COMMANDS.map(c => {
        const args = c.argumentHint !== undefined ? ` ${c.argumentHint}` : ""
        return `/${c.name}${args} — ${c.description}`
      })
      ctx.notify(`Commands:\n${lines.join("\n")}`)
    },
  },
  {
    name: "model",
    description: "Select or add a model",
    async execute(ctx, args) {
      // `/model` takes no arguments. The former `add`/`edit`/`remove` forms and
      // direct model-id activation are gone; any argument is rejected rather
      // than silently reinterpreted.
      if (args.trim().length > 0) {
        ctx.notify("usage: /model", true)
        return
      }

      const agent = ctx.agent()
      const models = (await agent.modelManager()).list()
      const active = (await agent.currentModel())?.id

      // A single picker covers both capabilities: every configured model, plus
      // `Add model…`. With no configured models it collapses to the Add row,
      // so the setup sequence is always reachable.
      const chosen = await ctx.pick("Model", [
        ...models.map(m => ({
          value: m.id,
          label: m.id,
          description: m.id === active ? "active" : undefined,
        })),
        { value: MODEL_ADD, label: "Add model…" },
      ])
      if (chosen === null) return
      if (chosen === MODEL_ADD) {
        // The application runs the one configuration sequence there is — the
        // same one first-run onboarding uses, which saves only after a real
        // model call has succeeded and been confirmed.
        await ctx.configureModel()
        return
      }
      try {
        await agent.activateModel(chosen)
        ctx.notify(`active model: ${chosen}`)
      } catch (error) {
        ctx.notify(`cannot activate model: ${errorMessage(error)}`, true)
      }
    },
  },
  {
    name: "new",
    description: "Start a fresh session in the same workspace",
    execute(ctx) {
      const session = ctx.agent().createSession(ctx.session().cwd)
      ctx.setSession(session)
      ctx.notify("started a new session")
    },
  },
  {
    name: "session",
    description: "Manage sessions in this workspace",
    execute(ctx) {
      return ctx.manageSessions()
    },
  },
  {
    name: "rewind",
    description: "Restore the conversation, files, or both to an earlier prompt",
    async execute(ctx) {
      await ctx.rewind()
    },
  },
  {
    name: "compact",
    description: "Manually compact the session context",
    async execute(ctx) {
      const result = await ctx.compact()
      switch (result.status) {
        case "compacted":
          ctx.notify(`context compacted — ${result.removed} messages summarized`)
          break
        case "no-progress":
          // The reason is the diagnosis, not decoration: `empty-tail` means a
          // single-turn history whose whole compactable region is the live
          // task, which no amount of retrying will change — and which is why a
          // run at its budget has to shed the request instead.
          ctx.notify(`nothing to compact — ${result.reason}`)
          break
        case "failed":
          ctx.notify(`compaction failed: ${result.error}`, true)
          break
        case "no-model":
          ctx.notify("no model configured — use /model to add one", true)
          break
        case "busy":
          ctx.notify(result.reason === "running"
            ? "a task is running — wait for it to finish before compacting"
            : "a compaction is already in progress")
          break
      }
    },
  },
  {
    name: "copy",
    description: "Copy the last agent response to the clipboard (OSC52)",
    execute(ctx) {
      const last = ctx.session().lastAssistant()
      const text = last === undefined
        ? ""
        : last.content.filter(p => p.type === "text").map(p => p.text).join("")
      if (text.trim().length === 0) {
        ctx.notify("no agent response to copy", true)
        return
      }
      const encoded = Buffer.from(text, "utf-8").toString("base64")
      process.stdout.write(`\x1b]52;c;${encoded}\x07`)
      ctx.notify("last response copied to the system clipboard")
    },
  },
  {
    name: "quit",
    description: "Exit LoongCode",
    execute(ctx) {
      ctx.quit()
    },
  },
]

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find(command => command.name === name)
}

import { describe, expect, test } from "bun:test"
import { LoongCode } from "@loongcode/agent"
import type { ModelConfig } from "@loongcode/model"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMMANDS, findCommand, type CommandContext, type CompactResult } from "./commands"
import { LoongCodeAutocomplete } from "./input/autocomplete"

describe("commands (AC12)", () => {
  test("core commands exist with descriptions", () => {
    const names = COMMANDS.map(c => c.name)
    for (const name of ["help", "model", "new", "session", "compact", "copy", "quit"]) {
      expect(names).toContain(name)
    }
    expect(findCommand("model")?.description.length).toBeGreaterThan(0)
    expect(findCommand("nonexistent")).toBeUndefined()
  })

  test("the retired import/export/hotkeys commands no longer exist", () => {
    // Portability (import/export) and the redundant hotkey listing are gone
    // from the TUI surface; none may remain discoverable or dispatchable.
    for (const name of ["import", "export", "hotkeys"]) {
      expect(findCommand(name)).toBeUndefined()
    }
  })

  test("the retired /trust command no longer exists", () => {
    // Project-local prompts and skills now load unconditionally, so the
    // project-trust concept has no command surface.
    expect(findCommand("trust")).toBeUndefined()
  })

  test("the retired /reload command no longer exists", () => {
    // Prompt templates are discovered live, so no manual refresh remains.
    expect(findCommand("reload")).toBeUndefined()
  })

  test("the retired login/logout commands no longer exist", () => {
    expect(findCommand("login")).toBeUndefined()
    expect(findCommand("logout")).toBeUndefined()
  })

  test("session management is consolidated into /session", () => {
    // `/session` is the single interactive session-management entry point, so
    // the separate session commands must not remain discoverable.
    for (const name of ["resume", "name", "tree", "fork", "clone"]) {
      expect(findCommand(name)).toBeUndefined()
    }
    expect(findCommand("session")?.description).toBe("Manage sessions in this workspace")
  })

  test("/help lists only /new and /session among the session commands", () => {
    const notices: string[] = []
    const ctx = { notify: (text: string) => { notices.push(text) } } as unknown as CommandContext
    findCommand("help")!.execute(ctx, "")
    const help = notices.join("\n")
    expect(help).toContain("/new — Start a fresh session in the same workspace")
    expect(help).toContain("/session — Manage sessions in this workspace")
    for (const removed of ["/resume", "/name", "/tree", "/fork", "/clone"]) {
      expect(help).not.toContain(removed)
    }
  })

  test("autocomplete proposes the consolidated surface and nothing removed", async () => {
    const provider = new LoongCodeAutocomplete(
      () => COMMANDS.map(command => ({ name: command.name, description: command.description })),
      () => process.cwd(),
    )
    const suggestions = await provider.getSuggestions(["/"], 0, 1)
    expect(suggestions).not.toBeNull()
    const labels = suggestions!.items.map(item => item.label)
    expect(labels).toContain("/new")
    expect(labels).toContain("/session")
    for (const removed of ["/resume", "/name", "/tree", "/fork", "/clone"]) {
      expect(labels).not.toContain(removed)
    }
  })

  test("/help and autocomplete no longer advertise removed commands", async () => {
    const removed = ["/import", "/export", "/hotkeys", "/trust", "/reload"]

    const notices: string[] = []
    const ctx = { notify: (text: string) => { notices.push(text) } } as unknown as CommandContext
    findCommand("help")!.execute(ctx, "")
    const help = notices.join("\n")
    for (const name of removed) {
      expect(help).not.toContain(name)
    }

    const provider = new LoongCodeAutocomplete(
      () => COMMANDS.map(command => ({ name: command.name, description: command.description })),
      () => process.cwd(),
    )
    const suggestions = await provider.getSuggestions(["/"], 0, 1)
    expect(suggestions).not.toBeNull()
    const labels = suggestions!.items.map(item => item.label)
    for (const name of removed) {
      expect(labels).not.toContain(name)
    }
  })

  test("/model is a single command with no argument syntax", () => {
    const model = findCommand("model")
    expect(model).toBeDefined()
    expect(model!.description).toBe("Select or add a model")
    expect(model!.argumentHint).toBeUndefined()
    expect(model!.argumentPlaceholder).toBeUndefined()
  })

  test("/model has no textual subcommands (add/edit/remove/configure/model-id)", async () => {
    // Every former argument form must be rejected up front: no picker opens, no
    // model is activated, and nothing is configured.
    for (const arg of ["add", "edit m1", "remove m1", "m1", "configure", "edit", "remove"]) {
      const notices: Array<{ text: string; isError: boolean }> = []
      let picks = 0
      const ctx = {
        agent: () => ({
          modelManager: async () => ({ list: () => [{ id: "m1" }] }),
          currentModel: async () => ({ id: "m1" }),
          activateModel: async () => { throw new Error("must not activate") },
          configureModel: async () => { throw new Error("must not configure") },
        }),
        pick: async () => { picks += 1; return null },
        notify: (text: string, isError?: boolean) => { notices.push({ text, isError: isError === true }) },
      } as unknown as CommandContext

      await findCommand("model")!.execute(ctx, arg)

      expect(notices.at(-1)).toEqual({ text: "usage: /model", isError: true })
      expect(picks).toBe(0)
    }
  })

  test("/help advertises /model without argument syntax", () => {
    const notices: string[] = []
    const ctx = { notify: (text: string) => { notices.push(text) } } as unknown as CommandContext
    findCommand("help")!.execute(ctx, "")
    const help = notices.join("\n")
    expect(help).toContain("/model — Select or add a model")
    for (const stale of ["/model add", "/model edit", "/model remove", "Configure models", "[add |"]) {
      expect(help).not.toContain(stale)
    }
  })

  test("autocomplete proposes /model and never advertises subcommands", async () => {
    const provider = new LoongCodeAutocomplete(
      () => COMMANDS.map(command => ({ name: command.name, description: command.description })),
      () => process.cwd(),
    )
    const all = await provider.getSuggestions(["/"], 0, 1)
    expect(all!.items.map(item => item.label)).toContain("/model")

    // Typing the command name yields only the command itself, never an
    // `add`/`edit`/`remove` form.
    const partial = await provider.getSuggestions(["/model"], 0, 6)
    expect(partial!.items.map(item => item.label)).toEqual(["/model"])
  })
})

/** A command context whose `compact()` returns a scripted result. */
function compactContext(result: CompactResult): { ctx: CommandContext; notices: string[] } {
  const notices: string[] = []
  const ctx = {
    compact: async () => result,
    notify: (text: string) => { notices.push(text) },
  } as unknown as CommandContext
  return { ctx, notices }
}

describe("/compact busy handling", () => {
  test("a compaction already in progress is reported, not started again", async () => {
    const { ctx, notices } = compactContext({ status: "busy", reason: "compacting" })
    await findCommand("compact")!.execute(ctx, "")
    expect(notices).toEqual(["a compaction is already in progress"])
  })

  test("compacting during a run is refused with a distinct message", async () => {
    const { ctx, notices } = compactContext({ status: "busy", reason: "running" })
    await findCommand("compact")!.execute(ctx, "")
    expect(notices).toEqual(["a task is running — wait for it to finish before compacting"])
  })
})

describe("/quit lifecycle", () => {
  test("uses the UI shutdown hook instead of exiting the process directly", async () => {
    // The fullscreen renderer must be stopped through the UI lifecycle so the
    // alternate screen and mouse state are restored before the process exits.
    let quitCalls = 0
    const ctx = {
      quit: () => {
        quitCalls += 1
      },
    } as unknown as CommandContext
    await findCommand("quit")!.execute(ctx, "")
    expect(quitCalls).toBe(1)
  })
})

describe("commands route through their context hooks", () => {
  test("/model still routes through ctx.pick with its title", async () => {
    const pickedTitles: string[] = []
    const ctx = {
      agent: () => ({
        modelManager: async () => ({ list: () => [{ id: "m1" }, { id: "m2" }] }),
        currentModel: async () => ({ id: "m1" }),
      }),
      session: () => ({ id: "current", cwd: "/tmp", messages: [], status: "idle" }),
      pick: async (title: string) => {
        pickedTitles.push(title)
        return null
      },
      notify: () => {},
      setSession: () => {},
    } as unknown as CommandContext

    await findCommand("model")!.execute(ctx, "")

    expect(pickedTitles).toEqual(["Model"])
  })

  test("/session opens the workspace-scoped manager via ctx.manageSessions", async () => {
    let opened = 0
    const ctx = {
      session: () => ({ id: "current", cwd: "/tmp", messages: [], status: "idle" }),
      manageSessions: async () => {
        opened += 1
      },
    } as unknown as CommandContext

    await findCommand("session")!.execute(ctx, "")

    expect(opened).toBe(1)
  })
})

// ── model management (/model) ────────────────────────────────────────

interface ModelRecord {
  id: string
}

interface PickCall {
  title: string
  items: Array<{ value: string; label: string; description?: string }>
  selectedValue?: string
}

interface ModelHarness {
  ctx: CommandContext
  notices: Array<{ text: string; isError: boolean }>
  asks: Array<{ label: string; secret: boolean }>
  picks: PickCall[]
  calls: {
    configured: ModelConfig[]
    activated: string[]
  }
  lastPickItems: Array<{ value: string; label: string; description?: string }>
  /** How many times the command asked the application to run setup. */
  readonly setupRuns: number
}

/**
 * A command context over a scripted in-memory model store. `pick` and `ask`
 * are driven per test through handlers, so the command logic — not the picker —
 * is what is under test.
 */
function modelHarness(options: {
  models?: ModelRecord[]
  active?: string
  askResults?: Array<string | null>
  pick?: (call: PickCall, index: number) => string | null
  failConfigure?: Error
  failActivate?: Error
  /** What the application's setup sequence reports back. */
  setupResult?: boolean
}): ModelHarness {
  const notices: ModelHarness["notices"] = []
  const asks: ModelHarness["asks"] = []
  const picks: PickCall[] = []
  const calls: ModelHarness["calls"] = { configured: [], activated: [] }
  const askResults = [...(options.askResults ?? [])]
  const models = options.models ?? []
  const byId = new Map(models.map(m => [m.id, m]))
  const lastPickItems: ModelHarness["lastPickItems"] = []
  let pickCall = 0
  let setupRuns = 0

  const manager = {
    list: () => models.map(m => ({ id: m.id })),
  }

  const ctx = {
    agent: () => ({
      modelManager: async () => manager,
      currentModel: async () => (options.active === undefined ? undefined : { id: options.active }),
      configureModel: async (config: ModelConfig) => {
        if (options.failConfigure) throw options.failConfigure
        calls.configured.push(config)
      },
      activateModel: async (id: string) => {
        if (options.failActivate) throw options.failActivate
        if (!byId.has(id)) throw new Error(`model "${id}" is not configured`)
        calls.activated.push(id)
      },
    }),
    notify: (text: string, isError?: boolean) => {
      notices.push({ text, isError: isError === true })
    },
    pick: async (
      title: string,
      items: Array<{ value: string; label: string; description?: string }>,
      opts?: { selectedValue?: string },
    ) => {
      const call: PickCall = { title, items, selectedValue: opts?.selectedValue }
      picks.push(call)
      lastPickItems.length = 0
      lastPickItems.push(...items)
      const result = options.pick?.(call, pickCall) ?? null
      pickCall += 1
      return result
    },
    ask: async (label: string, opts?: { secret?: boolean }) => {
      asks.push({ label, secret: opts?.secret === true })
      return askResults.length > 0 ? askResults.shift()! : null
    },
    // The configuration sequence is the application's; the command only asks
    // for it to run, and this records that it did.
    configureModel: async () => {
      setupRuns += 1
      return options.setupResult ?? true
    },
  } as unknown as CommandContext

  return { ctx, notices, asks, picks, calls, lastPickItems, get setupRuns() { return setupRuns } }
}

/** Value of the first item whose label matches. */
function byLabel(call: PickCall, label: string): string | null {
  return call.items.find(item => item.label === label)?.value ?? null
}

/**
 * A pick handler covering the `/model` picker and the add wizard's protocol and
 * commit steps. `protocol` selects the protocol item; `limits` chooses
 * `Configure limits…` at the commit step instead of the primary action.
 */
function wizard(
  opts: { protocol?: "openai" | "anthropic"; limits?: boolean } = {},
): (call: PickCall) => string | null {
  return call => {
    if (call.title === "Model") return byLabel(call, "Add model…")
    if (call.title === "Protocol") {
      return byLabel(call, opts.protocol === "anthropic" ? "Anthropic" : "OpenAI-compatible")
    }
    if (call.title.startsWith("Add ")) {
      if (opts.limits) return byLabel(call, "Configure limits…")
      return byLabel(call, "Add model")
    }
    return null
  }
}

describe("/model selection", () => {
  test("lists configured models, marks the active one, and offers only Add model…", async () => {
    const h = modelHarness({ models: [{ id: "m1" }, { id: "m2" }], active: "m1" })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.lastPickItems.map(i => i.label)).toEqual(["m1", "m2", "Add model…"])
    expect(h.lastPickItems[0]!.description).toBe("active")
    expect(h.lastPickItems[1]!.description).toBeUndefined()
    expect(h.lastPickItems.some(i => i.label === "Configure models…")).toBe(false)
  })

  test("selecting a configured model activates it", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }, { id: "m2" }],
      active: "m1",
      pick: call => (call.title === "Model" ? "m2" : null),
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.activated).toEqual(["m2"])
    expect(h.notices.at(-1)).toEqual({ text: "active model: m2", isError: false })
  })

  test("Esc cancels without changing the active model", async () => {
    const h = modelHarness({ models: [{ id: "m1" }, { id: "m2" }], active: "m1" })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.activated).toEqual([])
    expect(h.calls.configured).toEqual([])
    expect(h.notices).toEqual([])
  })

  test("an activation failure is a normal error notice", async () => {
    const h = modelHarness({ models: [{ id: "m1" }], active: "m1", pick: () => "ghost" })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.notices.at(-1)!.isError).toBe(true)
    expect(h.notices.at(-1)!.text).toContain("cannot activate model")
  })
})

describe("/model add", () => {
  test("with no models the picker collapses to Add model… and nothing else", async () => {
    const h = modelHarness({ models: [], pick: () => null })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.lastPickItems.map(i => i.label)).toEqual(["Add model…"])
  })

  test("choosing Add model… runs the application's setup sequence", async () => {
    // `add` is no longer a wizard of its own: the command delegates to the one
    // configuration sequence there is — the same one first-run onboarding
    // uses, which saves only after a real model call has succeeded.
    const h = modelHarness({ models: [], pick: call => byLabel(call, "Add model…") })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.setupRuns).toBe(1)
    // The command itself configures nothing: the sequence owns that.
    expect(h.calls.configured).toEqual([])
  })

  test("a sequence that saves nothing leaves the active model alone", async () => {
    const h = modelHarness({ models: [], pick: call => byLabel(call, "Add model…"), setupResult: false })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.setupRuns).toBe(1)
    expect(h.calls.activated).toEqual([])
  })
})

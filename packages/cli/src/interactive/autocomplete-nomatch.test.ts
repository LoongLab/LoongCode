import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Terminal } from "@loongcode/tui"
import { LoongCode } from "@loongcode/agent"
import { LoongCodeTui, modelReadiness } from "./app"
import { parseRawScreen, parseScreen } from "./view/testing"
import { setThemeColorDepth, setThemeMonochrome, setThemeScheme, theme } from "./view/theme"

/**
 * The no-match row, seen through the real application.
 *
 * The provider's empty-result path, the editor's decision to keep the interaction
 * open, and the application's `muted` role wiring only join up in the assembled
 * app — so this test asserts the rendered bytes it actually emits, not a
 * re-implementation of them.
 */

const QUERY = "/zzz"
const MESSAGE = `  No matching commands "${QUERY}"`
const ROWS = 30

let root: string
let ws: string
let configDir: string
let sessionsDir: string
let priorConfigDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loongcode-nomatch-"))
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
  // Restore the deterministic default so other suites are unaffected.
  setThemeScheme("dark")
  setThemeColorDepth("256")
  setThemeMonochrome(false)
})

interface Tty {
  readonly terminal: Terminal
  readonly writes: string[]
  feed(data: string): void
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
  return { terminal, writes, feed: data => state.send?.(data) }
}

const flush = async (times = 12): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 1))
}

const modelsFile = (): string => join(configDir, "models.json")
/** A configured-but-never-contacted model: readiness only needs one to exist. */
const dummyConfig = (): string =>
  JSON.stringify({
    version: 1,
    models: [{
      id: "probe", name: "probe", protocol: "openai", endpoint: "http://127.0.0.1:9/v1",
      model: "probe-model", apiKey: "sk-dummy-not-a-real-key",
      contextWindow: 128000, maxOutputTokens: 8192,
    }],
    activeModelId: "probe",
  })

interface Harness {
  readonly app: LoongCodeTui
  readonly tty: Tty
}

async function mount(): Promise<Harness> {
  const agent = new LoongCode({ sessionsDir })
  const session = agent.createSession(ws)
  const tty = createTerminal(100, ROWS)
  const app = new LoongCodeTui({
    agent,
    session,
    terminal: tty.terminal,
    label: session.cwd,
    readiness: await modelReadiness(agent),
  })
  app.start()
  await flush()
  return { app, tty }
}

/** Force a render and return both the plain rows and the ANSI-preserving rows. */
function render(h: Harness): { plain: string; raw: string } {
  h.tty.writes.length = 0
  ;(h.app as unknown as { tui: { renderNow(force?: boolean): void } }).tui.renderNow(true)
  const written = h.tty.writes.join("")
  return {
    plain: parseScreen(written, ROWS).join("\n"),
    raw: parseRawScreen(written, ROWS).join("\n"),
  }
}

/** A deterministic 256-colour palette so the role assertions are not depth-dependent. */
function pinColor(): void {
  setThemeScheme("dark")
  setThemeColorDepth("256")
  setThemeMonochrome(false)
}

describe("slash no-match in the assembled application", () => {
  test("an unmatched slash query renders the explicit no-match row", async () => {
    writeFileSync(modelsFile(), dummyConfig())
    const h = await mount()
    pinColor()
    h.tty.feed(QUERY)
    await flush()

    expect(render(h).plain).toContain(`No matching commands "${QUERY}"`)
  })

  test("the no-match row is styled with muted, not failure", async () => {
    writeFileSync(modelsFile(), dummyConfig())
    const h = await mount()
    pinColor()
    h.tty.feed(QUERY)
    await flush()

    // Precondition: at this depth the two roles are distinguishable, so the
    // assertion below is meaningful.
    expect(theme.muted(MESSAGE)).not.toBe(theme.failure(MESSAGE))

    const { raw } = render(h)
    expect(raw).toContain(theme.muted(MESSAGE))
    expect(raw).not.toContain(theme.failure(MESSAGE))
  })
})

/**
 * The forced recovery pass (`PruneContext.forced`).
 *
 * It exists for the shape the pressure-driven pass cannot help — one task turn
 * whose whole context is the tool output produced after it — and it is the only
 * pass allowed to withhold inside the current turn. These tests pin what it
 * withholds, what it must never withhold, and what a withheld result still
 * tells the model.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelMessage } from "@loongcode/model"
import { estimateTokens } from "../../src/context/budget"
import type { PruneStats, ProjectionMessage } from "../../src/context/projection"
import { isPrunedToolOutput, pruneOldToolOutputs } from "../../src/context/projection"
import { CODING_TOOLS } from "../../src/tools"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const user = (text: string): ProjectionMessage => ({ role: "user", content: text })

/** An assistant turn that asked for one tool call. */
const call = (toolCallId: string, toolName: string, input: unknown): ProjectionMessage => ({
  role: "assistant",
  content: [{ type: "tool_call", toolCallId, toolName, input }],
})

/** The tool message answering one call, with optional agent-local metadata. */
const answer = (
  toolCallId: string,
  toolName: string,
  text: string,
  extra?: { failureEvidence?: boolean; externalizedAt?: string },
): ProjectionMessage => ({
  role: "tool",
  content: [{ toolCallId, toolName, output: { type: "text", text } }],
  ...(extra?.failureEvidence === true ? { failureEvidence: true } : {}),
  ...(extra?.externalizedAt === undefined ? {} : { affordances: { [toolCallId]: { externalizedAt: extra.externalizedAt } } }),
})

/** A failed execution: `tool_error` output, which is never withheld. */
const failed = (toolCallId: string, toolName: string, text: string): ProjectionMessage => ({
  role: "tool",
  content: [{ toolCallId, toolName, output: { type: "tool_error", text } }],
})

/** One `read` turn: the call names the path, the answer carries the content. */
const readTurn = (id: string, filePath: string, text: string): ProjectionMessage[] => [
  call(id, "read", { filePath }),
  answer(id, "read", text),
]

const noteBody = (i: number): string => `note ${i} `.repeat(500)

/** The verified failure shape: the task first, then everything the run read. */
function singleTurnHistory(reads: number): ProjectionMessage[] {
  return [
    user("read the notes and summarise them"),
    ...Array.from({ length: reads }, (_, i) => readTurn(`call_${i}`, `/notes/note-${i}.md`, noteBody(i))).flat(),
  ]
}

/** Every marker the projection carries, in order. */
const markers = (messages: readonly ModelMessage[]) =>
  messages.flatMap(m => (m.role === "tool" ? m.content.map(r => r.output) : [])).filter(isPrunedToolOutput)

/** The surviving text of every tool result, `undefined` where withheld. */
const resultTexts = (messages: readonly ModelMessage[]): Array<string | undefined> =>
  messages.flatMap(m =>
    m.role === "tool" ? m.content.map(r => (r.output.type === "text" ? r.output.text : undefined)) : [],
  )

// ---------------------------------------------------------------------------
// why the forced pass exists
// ---------------------------------------------------------------------------

describe("the pressure-driven pass cannot shrink a single-turn history", () => {
  test("stage one is barred from the current turn, so only the newest result is touched", () => {
    const projected = pruneOldToolOutputs(singleTurnHistory(6), { inputBudget: 10 })

    // Stage two's last resort rewrites the newest result…
    expect(markers(projected)).toHaveLength(1)
    // …and every older result survives in full, which is why the request still
    // cannot fit: stage one may not enter the current turn at all.
    expect(resultTexts(projected).slice(0, 5)).toEqual([0, 1, 2, 3, 4].map(noteBody))
    expect(estimateTokens(projected)).toBeGreaterThan(10)
  })
})

// ---------------------------------------------------------------------------
// what the forced pass withholds
// ---------------------------------------------------------------------------

describe("the forced pass withholds what the model can get back", () => {
  test("everything recoverable except the newest two is withheld", () => {
    const projected = pruneOldToolOutputs(singleTurnHistory(6), { inputBudget: 100_000, forced: true })

    const withheld = markers(projected)
    expect(withheld).toHaveLength(4)
    // The newest two are the ones the current step is working from.
    expect(resultTexts(projected).slice(-2)).toEqual([noteBody(4), noteBody(5)])
    // A withheld read states the path it read and how much it held.
    for (const [i, marker] of withheld.entries()) {
      expect(marker.value.toolName).toBe("read")
      expect(marker.value.sourcePath).toBe(`/notes/note-${i}.md`)
      expect(marker.value.originalBytes).toBe(Buffer.byteLength(noteBody(i), "utf-8"))
    }
  })

  test("the estimate cannot gate it: it withholds even when the projection already fits", () => {
    // The budget here is far larger than the history. The pressure-driven pass
    // would return this projection untouched; recovery must not, because the
    // estimate is exactly what the provider has just contradicted.
    const history = singleTurnHistory(3)
    expect(pruneOldToolOutputs(history, { inputBudget: 100_000 })).toEqual(history)
    expect(markers(pruneOldToolOutputs(history, { inputBudget: 100_000, forced: true }))).toHaveLength(1)
  })

  test("a declared spill path is carried through, alongside the read's own path", () => {
    const history: ProjectionMessage[] = [
      user("task"),
      call("c1", "bash", { command: "generate" }),
      answer("c1", "bash", "output ".repeat(100), { externalizedAt: "/tmp/spill/c1.txt" }),
      ...readTurn("c2", "/notes/a.md", "a".repeat(4_000)),
      ...readTurn("c3", "/notes/b.md", "b".repeat(4_000)),
      ...readTurn("c4", "/notes/c.md", "c".repeat(4_000)),
    ]

    const withheld = markers(pruneOldToolOutputs(history, { inputBudget: 100_000, forced: true }))

    // The spilled bash output and the older read; the newest two reads stay.
    expect(withheld).toHaveLength(2)
    expect(withheld[0]!.value.spillPath).toBe("/tmp/spill/c1.txt")
    expect(withheld[0]!.value.sourcePath).toBeUndefined()
    expect(withheld[1]!.value.sourcePath).toBe("/notes/a.md")
  })

  test("a capped read keeps the offset that continues it", () => {
    // The read tool caps its own output and declares where to resume. A
    // withheld capped read must keep both facts, or the rest of the file is
    // unreachable.
    const paged: ProjectionMessage = {
      role: "tool",
      content: [{ toolCallId: "c1", toolName: "read", output: { type: "text", text: "page one\n".repeat(500) } }],
      affordances: { c1: { resumeOffset: 2_001 } },
    }
    const history: ProjectionMessage[] = [
      user("task"),
      call("c1", "read", { filePath: "/notes/long.md" }),
      paged,
      ...readTurn("c2", "/notes/b.md", "b".repeat(4_000)),
      ...readTurn("c3", "/notes/c.md", "c".repeat(4_000)),
    ]

    const withheld = markers(pruneOldToolOutputs(history, { inputBudget: 100_000, forced: true }))

    expect(withheld).toHaveLength(1)
    expect(withheld[0]!.value.sourcePath).toBe("/notes/long.md")
    expect(withheld[0]!.value.resumeOffset).toBe(2_001)
  })
})

// ---------------------------------------------------------------------------
// what it must never withhold
// ---------------------------------------------------------------------------

describe("nothing without a stated way back is withheld", () => {
  test("small tool output, failed executions and failure evidence all survive", () => {
    const history: ProjectionMessage[] = [
      user("task"),
      call("c1", "bash", { command: "echo hi" }),
      answer("c1", "bash", "hi"), // under the cap: never spilled, so no route
      call("c2", "grep", { pattern: "x" }),
      answer("c2", "grep", "one match"),
      call("c3", "bash", { command: "false" }),
      failed("c3", "bash", "exit 1"),
      call("c4", "bash", { command: "check" }),
      answer("c4", "bash", "observed failure", { failureEvidence: true }),
      ...readTurn("c5", "/notes/a.md", "a".repeat(4_000)),
    ]

    // The one recoverable result is also the newest, so it is retained. What
    // the provider receives is the history unchanged — agent-local metadata is
    // stripped by the projection, and nothing was withheld.
    const projected = pruneOldToolOutputs(history, { inputBudget: 100_000, forced: true })
    expect(markers(projected)).toHaveLength(0)
    const wire: ModelMessage[] = history.map(({ role, content }) => ({ role, content }) as ModelMessage)
    expect(projected).toEqual(wire)
  })

  test("protected results survive while older recoverable ones are withheld", () => {
    const history: ProjectionMessage[] = [
      user("task"),
      ...readTurn("c1", "/notes/a.md", "a".repeat(4_000)),
      ...readTurn("c2", "/notes/b.md", "b".repeat(4_000)),
      call("c3", "bash", { command: "check" }),
      answer("c3", "bash", "observed failure", { failureEvidence: true }),
      ...readTurn("c4", "/notes/c.md", "c".repeat(4_000)),
      ...readTurn("c5", "/notes/d.md", "d".repeat(4_000)),
    ]

    const projected = pruneOldToolOutputs(history, { inputBudget: 100_000, forced: true })

    expect(markers(projected).map(marker => marker.value.sourcePath)).toEqual(["/notes/a.md", "/notes/b.md"])
    // The evidence turn is untouched, and so is the newest pair.
    const evidence = projected.find(message => message.role === "tool" && message.content[0]!.toolCallId === "c3")
    if (evidence === undefined || evidence.role !== "tool") throw new Error("expected the evidence turn")
    expect(evidence.content[0]!.output).toEqual({ type: "text", text: "observed failure" })
    expect(resultTexts(projected).slice(-2)).toEqual(["c".repeat(4_000), "d".repeat(4_000)])
  })
})

// ---------------------------------------------------------------------------
// structural integrity
// ---------------------------------------------------------------------------

describe("a reduced projection is still a valid request", () => {
  test("every tool call keeps its result, in order", () => {
    const history = singleTurnHistory(6)
    const projected = pruneOldToolOutputs(history, { inputBudget: 100_000, forced: true })

    expect(projected.map(message => message.role)).toEqual(history.map(message => message.role))
    const calls = projected.flatMap(message =>
      message.role === "assistant"
        ? message.content.filter(part => part.type === "tool_call").map(part => part.toolCallId)
        : [],
    )
    const results = projected.flatMap(message =>
      message.role === "tool" ? message.content.map(result => result.toolCallId) : [],
    )
    expect(results).toEqual(calls)
  })

  test("the same history always produces the same projection", () => {
    const options = { inputBudget: 100_000, forced: true }
    expect(pruneOldToolOutputs(singleTurnHistory(6), options)).toEqual(
      pruneOldToolOutputs(singleTurnHistory(6), options),
    )
  })

  test("a second pass over its own output changes nothing further", () => {
    const once = pruneOldToolOutputs(singleTurnHistory(6), { inputBudget: 100_000, forced: true })
    const observations: PruneStats[] = []

    const twice = pruneOldToolOutputs(once as ProjectionMessage[], {
      inputBudget: 100_000,
      forced: true,
      onPrune: stats => observations.push(stats),
    })

    expect(twice).toEqual(once)
    expect(observations).toEqual([])
  })

  test("durable messages are never mutated", () => {
    const history = singleTurnHistory(6)
    const snapshot = structuredClone(history)

    pruneOldToolOutputs(history, { inputBudget: 100_000, forced: true })

    expect(history).toEqual(snapshot)
  })

  test("what it withheld is reported once, with the bytes it held", () => {
    const observations: PruneStats[] = []

    pruneOldToolOutputs(singleTurnHistory(6), {
      inputBudget: 100_000,
      forced: true,
      onPrune: stats => observations.push(stats),
    })

    const perResult = Buffer.byteLength(noteBody(0), "utf-8")
    expect(observations).toEqual([{ reduced: 4, originalBytes: perResult * 4 }])
  })

  test("a history with nothing recoverable reports no reduction at all", () => {
    const history: ProjectionMessage[] = [
      user("task"),
      call("c1", "bash", { command: "echo hi" }),
      answer("c1", "bash", "hi"),
      call("c2", "bash", { command: "pwd" }),
      answer("c2", "bash", "/tmp"),
    ]
    const observations: PruneStats[] = []

    const projected = pruneOldToolOutputs(history, { inputBudget: 1, forced: true, onPrune: s => observations.push(s) })

    // Not even stage two: recovery does not rewrite the newest result to no
    // purpose, and the caller is told nothing was withheld.
    expect(projected).toEqual(history)
    expect(observations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// the recovery route is real
// ---------------------------------------------------------------------------

describe("a withheld result's way back is a real one", () => {
  test("the stated path still holds the content, and a missing file fails explicitly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loongcode-projection-recovery-"))
    try {
      const filePath = join(dir, "notes.md")
      writeFileSync(filePath, "the actual content\n")
      const history: ProjectionMessage[] = [
        user("task"),
        ...readTurn("c1", filePath, "the actual content\n"),
        ...readTurn("c2", join(dir, "other.md"), "other\n"),
        ...readTurn("c3", join(dir, "third.md"), "third\n"),
      ]

      const withheld = markers(pruneOldToolOutputs(history, { inputBudget: 100_000, forced: true }))
      expect(withheld).toHaveLength(1)
      const sourcePath = withheld[0]!.value.sourcePath
      expect(sourcePath).toBe(filePath)

      const read = CODING_TOOLS.get("read")
      if (read === undefined) throw new Error("read tool is missing from the coding toolset")

      // Following the route returns the content the model was working from.
      const recovered = await read.execute({ filePath: sourcePath }, { cwd: dir })
      expect(recovered.ok).toBe(true)
      if (!recovered.ok) throw new Error("expected the read to succeed")
      expect(recovered.data).toContain("the actual content")

      // A route that no longer resolves fails; nothing is invented in its place.
      unlinkSync(filePath)
      const missing = await read.execute({ filePath: sourcePath }, { cwd: dir })
      expect(missing.ok).toBe(false)
      if (missing.ok) throw new Error("expected the read to fail")
      expect(missing.error).toContain(filePath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

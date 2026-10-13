/**
 * Context overflow recovery — the shape that produced
 * `context overflow detected but compaction made no progress: empty-tail`.
 *
 * One task, then everything the run read. The compactable region is the task
 * alone, so no compaction can ever shrink that history: the request projection
 * is what has to give, and the run has to survive it without losing evidence
 * the model can still get back.
 */
import { describe, expect, test } from "bun:test"
import type { ModelMessage, ModelRequest } from "@loongcode/model"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isPrunedToolOutput } from "../../src/context/projection"
import type { RunEvent } from "../../src/loop/events"
import { agentFor } from "../support/loop"
import { FakeModel, textResponse, toolCallResponse } from "../support/testing"

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Every request the fixtures use: a window whose budget is 6000 input
 *  tokens, a proactive threshold of 4800, and reads of ~1000 estimated
 *  tokens each — so the arithmetic below is legible. */
const LIMITS = { contextWindow: 8_000, maxOutputTokens: 2_000 }
const INPUT_BUDGET = 6_000

/** Real files: the history must carry reads a recovery can point back to.
 *  Multi-line on purpose — `read` caps a single line at 2000 characters, and a
 *  one-line note would arrive truncated and much smaller than it looks. */
function writeNotes(dir: string, lines: readonly number[]): string[] {
  return lines.map((count, i) => {
    const path = join(dir, `note-${i}.md`)
    writeFileSync(path, count === 0 ? `tiny note ${i}\n` : `note ${i}\n` + "body line\n".repeat(count))
    return path
  })
}

function notesDir(count: number): { dir: string; paths: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loongcode-overflow-recovery-"))
  return {
    dir,
    paths: writeNotes(dir, Array.from({ length: count }, () => 400)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Notes of deliberately different sizes, so how far a recovery reaches is
 *  decided by the fixture rather than by the file system. */
function sizedNotesDir(lines: readonly number[]): { dir: string; paths: string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loongcode-overflow-recovery-"))
  return { dir, paths: writeNotes(dir, lines), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const readCall = (id: string, path: string) => ({ toolCallId: id, toolName: "read", input: { filePath: path } })

/** Responses that read one note each; the last reports an input over budget. */
function readScript(
  paths: readonly string[],
  opts: { overflowTokens?: number; usage?: readonly number[] } = {},
): Array<ReturnType<typeof toolCallResponse>> {
  return paths.map((path, i) =>
    toolCallResponse([readCall(`call_${i}`, path)], {
      usage: { inputTokens: opts.usage?.[i] ?? (i === paths.length - 1 ? (opts.overflowTokens ?? 6_200) : 100 * (i + 1)) },
    }),
  )
}

const toolOutputs = (request: ModelRequest) =>
  request.messages.flatMap(message => (message.role === "tool" ? message.content.map(result => result.output) : []))

const markersIn = (request: ModelRequest) => toolOutputs(request).filter(isPrunedToolOutput)

const textResults = (messages: readonly { role: string; content: unknown }[]): string[] =>
  messages.flatMap(message =>
    message.role === "tool" && Array.isArray(message.content)
      ? (message.content as Array<{ output: { type: string; text?: string } }>)
          .map(result => result.output)
          .filter(output => output.type === "text")
          .map(output => output.text ?? "")
      : [],
  )

// ---------------------------------------------------------------------------
// the failure the work exists for
// ---------------------------------------------------------------------------

describe("a single-turn run survives an overflow compaction cannot fix", () => {
  test("it withholds recoverable output, continues, and records why", async () => {
    const notes = notesDir(12)
    try {
      const paths = notes.paths.slice(0, 4)
      const { agent, model, dir, cleanup } = agentFor(
        new FakeModel([...readScript(paths), textResponse("finished after recovery")], LIMITS),
      )
      const session = agent.createSession(dir)
      const events: RunEvent[] = []

      const result = await agent.run(session, "read the notes and summarise them", {
        onEvent: event => events.push(event),
      })

      expect(result.finishReason).toBe("stop")

      // Compaction could not progress, and said so instead of discarding it.
      const skipped = events.filter(event => event.type === "compaction_skipped")
      expect(skipped).toHaveLength(1)
      expect(skipped[0]).toMatchObject({ reason: "empty-tail", trigger: "reactive" })

      // The recovery withheld what the model can get back, and reported it.
      const reduced = events.filter(event => event.type === "projection_reduced")
      expect(reduced).toHaveLength(1)
      expect(reduced[0]).toMatchObject({ reduced: 2 })

      // A recovery pass costs no model call, and neither does the no-progress
      // compaction that preceded it: four reads, then one recovered request.
      expect(model.requests).toHaveLength(paths.length + 1)

      // The recovered request carries markers for the older reads…
      const recovered = model.requests[model.requests.length - 1]!
      expect(markersIn(recovered).map(marker => marker.value.sourcePath)).toEqual(paths.slice(0, 2))
      // …and the newest two are still there in full.
      expect(textResults(recovered.messages).filter(text => text.length > 100)).toHaveLength(2)

      // Recovery is a projection, never a deletion: durable history keeps all
      // four results, and the model can still read any of them again.
      expect(textResults(session.messages).filter(text => text.length > 100)).toHaveLength(paths.length)

      const run = session.runs[0]!
      expect(run.finishReason).toBe("stop")
      expect(run.compactionSkips).toEqual([{ reason: "empty-tail", trigger: "reactive", count: 1 }])
      expect(run.projectionRecoveries?.reduced).toBe(2)

      // The record on disk says the same thing: a reader who was not watching
      // can still tell an overflow was survived, and how.
      const onDisk = JSON.parse(readFileSync(join(dir, "sessions", `${session.id}.json`), "utf-8"))
      expect(onDisk.runs[0].compactionSkips).toEqual([{ reason: "empty-tail", trigger: "reactive", count: 1 }])
      expect(onDisk.runs[0].projectionRecoveries).toEqual({ reduced: 2, originalBytes: expect.any(Number) })
      expect(
        onDisk.messages.filter(
          (message: { role: string }) => message.role === "tool",
        ),
      ).toHaveLength(paths.length)

      cleanup()
    } finally {
      notes.cleanup()
    }
  })

  test("the model can fetch what was withheld, and gets the file, not an invention", async () => {
    const notes = notesDir(12)
    try {
      const paths = notes.paths.slice(0, 4)
      const { agent, model, dir, cleanup } = agentFor(
        new FakeModel(
          [
            ...readScript(paths),
            // The model, having been told the older reads were withheld, asks
            // for the first one again.
            toolCallResponse([readCall("again", paths[0]!)]),
            textResponse("read it again"),
          ],
          LIMITS,
        ),
      )
      const session = agent.createSession(dir)

      const result = await agent.run(session, "read the notes and summarise them")
      expect(result.finishReason).toBe("stop")

      // The withheld result was recoverable by re-reading its path…
      const recoveredRequest = model.requests[4]!
      expect(markersIn(recoveredRequest).map(marker => marker.value.sourcePath)).toContain(paths[0]!)
      // …and re-reading produced the actual content.
      const reread = session.messages.flatMap(message =>
        message.role === "tool" ? message.content.filter(result => result.toolCallId === "again") : [],
      )
      expect(reread).toHaveLength(1)
      if (reread[0]!.output.type !== "text") throw new Error("expected the re-read to return text")
      expect(reread[0]!.output.text).toContain(`note 0`)
      expect(reread[0]!.output.text).toContain("body line")

      cleanup()
    } finally {
      notes.cleanup()
    }
  })

  test("a provider rejection recovers even though the local estimate said the request fit", async () => {
    const notes = notesDir(12)
    try {
      const paths = notes.paths.slice(0, 4)
      // The provider's limit sits below the runtime's own budget: the estimator
      // calls the request fitting, request pruning never engages, and the
      // provider rejects it. That disagreement is what the recovery exists for.
      const providerLimit = 5_000
      const { agent, model, dir, cleanup } = agentFor(
        new FakeModel([...readScript(paths, { usage: [500, 1_500, 2_500, 3_500] }), textResponse("finished after recovery")], {
          ...LIMITS,
          maxInputTokens: providerLimit,
        }),
      )
      const session = agent.createSession(dir)
      const events: RunEvent[] = []

      const result = await agent.run(session, "read the notes and summarise them", {
        onEvent: event => events.push(event),
      })

      expect(result.finishReason).toBe("stop")
      // The request the provider rejected was one the runtime's own accounting
      // had accepted — the estimate that calls a request fitting is exactly
      // what cannot be trusted here.
      expect(model.requestSizes[3]!).toBeGreaterThan(providerLimit)
      expect(model.requestSizes[3]!).toBeLessThanOrEqual(INPUT_BUDGET)
      // And it was the provider's rejection that started the recovery.
      expect(events.filter(event => event.type === "compaction_skipped")[0]).toMatchObject({
        reason: "empty-tail",
        trigger: "provider",
      })
      expect(events.filter(event => event.type === "projection_reduced")[0]).toMatchObject({ reduced: 1 })

      cleanup()
    } finally {
      notes.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// boundaries
// ---------------------------------------------------------------------------

describe("recovery is bounded and honest when it cannot help", () => {
  test("nothing recoverable to withhold terminates, with the reason and no retry", async () => {
    const { agent, model, dir, cleanup } = agentFor(
      new FakeModel(
        [
          // A small bash result: capped at 2KB, never spilled, so nothing
          // states a way back to it and the recovery may not withhold it.
          toolCallResponse([{ toolCallId: "call_0", toolName: "bash", input: { command: "echo hi" } }], {
            usage: { inputTokens: 6_200 },
          }),
          textResponse("unreachable"),
        ],
        LIMITS,
      ),
    )
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    const result = await agent.run(session, "run it", { onEvent: event => events.push(event) })

    expect(result.finishReason).toBe("error")
    expect(result.error).toContain("empty-tail")
    expect(result.error).toContain("no recoverable tool output remained")
    expect(events.filter(event => event.type === "projection_reduced")).toHaveLength(0)
    // The rejected request is not sent again, and no summary is attempted: the
    // run made exactly the one call it had already made.
    expect(model.requests).toHaveLength(1)
    expect(session.runs[0]!.projectionRecoveries).toBeUndefined()

    cleanup()
  })

  test("recoveries are bounded: the sixth overflow ends the run", async () => {
    const notes = notesDir(12)
    try {
      const paths = notes.paths.slice(0, 9)
      const { agent, model, dir, cleanup } = agentFor(
        new FakeModel(
          [
            // Four reads at once, so the first recovery has something to
            // withhold; then one more per iteration.
            toolCallResponse(
              paths.slice(0, 4).map((path, i) => readCall(`call_${i}`, path)),
              { usage: { inputTokens: 6_200 } },
            ),
            ...paths.slice(4).map((path, i) =>
              toolCallResponse([readCall(`call_${i + 4}`, path)], { usage: { inputTokens: 6_200 } }),
            ),
          ],
          LIMITS,
        ),
      )
      const session = agent.createSession(dir)
      const events: RunEvent[] = []

      const result = await agent.run(session, "read everything", { onEvent: event => events.push(event) })

      expect(result.finishReason).toBe("error")
      expect(result.error).toContain("projection recoveries are spent")
      // Five recoveries, one per overflow, then the sixth is terminal — never
      // an unbounded sequence of the same attempt.
      expect(events.filter(event => event.type === "projection_reduced")).toHaveLength(5)
      expect(model.requests).toHaveLength(6)

      cleanup()
    } finally {
      notes.cleanup()
    }
  })

  test("a recovered request that would be sent twice is not sent at all", async () => {
    // Two tiny reads first, then two large ones: a recovery can only withhold
    // the tiny pair, so the reduced request is still over the provider's limit
    // — and, because a rejection changes no durable history, identical to the
    // request already rejected.
    const notes = sizedNotesDir([0, 0, 400, 400])
    try {
      const paths = notes.paths
      const { agent, model, dir, cleanup } = agentFor(
        new FakeModel([...readScript(paths, { usage: [500, 1_500, 2_500, 3_500] })], {
          ...LIMITS,
          maxInputTokens: 3_000,
        }),
      )
      const session = agent.createSession(dir)
      const events: RunEvent[] = []

      const result = await agent.run(session, "read the notes", { onEvent: event => events.push(event) })

      expect(result.finishReason).toBe("error")
      expect(result.error).toContain("the request the provider already rejected")
      // The first recovery was real and reported; the second refused to spend
      // another call on the same request instead of looping until its budget
      // ran out.
      expect(events.filter(event => event.type === "projection_reduced")).toHaveLength(1)
      expect(model.requests).toHaveLength(6)

      cleanup()
    } finally {
      notes.cleanup()
    }
  })

  test("both overflow branches draw on the same recovery budget", async () => {
    const notes = notesDir(24)
    try {
      const paths = notes.paths.slice(0, 16)
      // A provider rejection and a reported overflow alternate: the history
      // grows past the provider's limit, a recovery trims it under that limit,
      // and the next response reports an overflow of its own. Two triggers, one
      // budget — if they did not share it, this run would recover more than five
      // times.
      const script = paths.map((path, i) =>
        toolCallResponse([readCall(`call_${i}`, path)], { usage: { inputTokens: i < 3 ? 400 : 6_200 } }),
      )
      const { agent, model, dir, cleanup } = agentFor(new FakeModel(script, { ...LIMITS, maxInputTokens: 5_000 }))
      const session = agent.createSession(dir)
      const events: RunEvent[] = []

      const result = await agent.run(session, "read everything", { onEvent: event => events.push(event) })

      const triggers = (session.runs[0]!.compactionSkips ?? []).map(skip => skip.trigger)
      expect({
        reason: result.finishReason,
        error: result.error,
        triggers,
        reductions: events.filter(event => event.type === "projection_reduced").length,
        requests: model.requests.length,
      }).toMatchObject({ reason: "error", error: expect.stringContaining("projection recoveries are spent") })

      // Both overflow branches ran, and together they spent exactly the one bound.
      expect(triggers).toContain("provider")
      expect(triggers).toContain("reactive")
      expect(events.filter(event => event.type === "projection_reduced")).toHaveLength(5)

      cleanup()
    } finally {
      notes.cleanup()
    }
  })

  test("proactive no-progress is not repeated while the history it reads is unchanged", async () => {
    const notes = notesDir(12)
    try {
      const { agent, model, dir, cleanup } = agentFor(
        new FakeModel(
          [
            toolCallResponse([readCall("call_0", notes.paths[0]!)], { usage: { inputTokens: 5_000 } }),
            toolCallResponse([readCall("call_1", notes.paths[1]!)], { usage: { inputTokens: 5_000 } }),
            textResponse("finished"),
          ],
          LIMITS,
        ),
      )
      const session = agent.createSession(dir)
      const events: RunEvent[] = []

      const result = await agent.run(session, "read the notes", { onEvent: event => events.push(event) })

      expect(result.finishReason).toBe("stop")
      // Three iterations under pressure, one verdict: the history compaction
      // reads never moved, so the later iterations neither retried the attempt
      // nor reported it again.
      expect(model.requests).toHaveLength(3)
      expect(events.filter(event => event.type === "compaction_skipped")).toHaveLength(1)
      expect(session.runs[0]!.compactionSkips).toEqual([{ reason: "empty-tail", trigger: "proactive", count: 1 }])

      cleanup()
    } finally {
      notes.cleanup()
    }
  })

  test("a history change permits another proactive attempt", async () => {
    const notes = notesDir(12)
    try {
      const paths = notes.paths
      const { agent, model, dir, cleanup } = agentFor(
        new FakeModel(
          [
            toolCallResponse([readCall("call_0", paths[0]!), readCall("call_1", paths[1]!)], {
              usage: { inputTokens: 5_000 },
            }),
            // Consumed by the stream the steering interrupts.
            toolCallResponse([readCall("call_2", paths[2]!)]),
            textResponse("summary of the earlier work"),
            textResponse("finished after the steer"),
          ],
          LIMITS,
        ),
      )
      const session = agent.createSession(dir)
      const events: RunEvent[] = []
      let steered = false

      const result = await agent.run(session, "read the notes", {
        onEvent: event => {
          events.push(event)
          // A steering note is the one thing a running turn can add that moves
          // the boundary compaction reads.
          if (!steered && event.type === "tool_result") {
            steered = true
            session.steer("now read the third note")
          }
        },
      })

      expect(result.finishReason).toBe("stop")
      const steeredAt = events.findIndex(event => event.type === "steered")
      expect(steeredAt).toBeGreaterThan(-1)
      // Before the steer: the verdict was reached once, and reported once.
      const before = events.slice(0, steeredAt).filter(event => event.type === "compaction_skipped")
      expect(before).toHaveLength(1)
      expect(before[0]).toMatchObject({ reason: "empty-tail", trigger: "proactive" })
      // After it the boundary moved, so another attempt is made — which is the
      // whole difference from the unchanged case above.
      const after = events
        .slice(steeredAt)
        .filter(event => event.type === "compaction_skipped" || event.type === "compaction")
      expect(after.length).toBeGreaterThan(0)
      expect(after[0]).toMatchObject({ trigger: "proactive" })

      cleanup()
    } finally {
      notes.cleanup()
    }
  })

  test("proactive no-progress is reported, and does not end the run", async () => {
    const notes = notesDir(12)
    try {
      const { agent, model, dir, cleanup } = agentFor(
        new FakeModel(
          [
            // Over the 4800 threshold, under the 6000 budget: pressure without
            // an overflow.
            toolCallResponse([readCall("call_0", notes.paths[0]!)], { usage: { inputTokens: 5_000 } }),
            textResponse("finished"),
          ],
          LIMITS,
        ),
      )
      const session = agent.createSession(dir)
      const events: RunEvent[] = []

      const result = await agent.run(session, "read the note", { onEvent: event => events.push(event) })

      expect(result.finishReason).toBe("stop")
      expect(events.filter(event => event.type === "compaction_skipped")).toHaveLength(1)
      expect(events.filter(event => event.type === "compaction_skipped")[0]).toMatchObject({
        reason: "empty-tail",
        trigger: "proactive",
      })
      // Reported, not acted on: the proactive trigger does not start a
      // recovery, and a no-progress compaction costs no model call.
      expect(events.filter(event => event.type === "projection_reduced")).toHaveLength(0)
      expect(model.requests).toHaveLength(2)
      expect(session.runs[0]!.compactionSkips).toEqual([{ reason: "empty-tail", trigger: "proactive", count: 1 }])

      cleanup()
    } finally {
      notes.cleanup()
    }
  })
})

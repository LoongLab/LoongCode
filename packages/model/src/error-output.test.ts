/**
 * What a provider failure must NOT write.
 *
 * The AI SDK's default `onError` reports the raw error object to the console.
 * In a full-screen TUI "the console" is the interface, and the rendered object
 * carries the provider body, the request payload (the whole conversation and
 * every tool schema) and SDK stack frames — and, unlike this package's own
 * errors, it is not scrubbed of the API key. These tests hold that shut from
 * the outside: they capture every console and raw stream write during a real
 * failing request and assert the channel is silent, while the error itself
 * still reaches the caller, classified, and still retries.
 */
import { describe, expect, test } from "bun:test"
import { ModelError } from "./errors"
import type { Model, ModelEvent } from "./types"
import {
  TEST_API_KEY,
  activeModelViaManager,
  sse,
  startMockProvider,
  testConfig,
  withConfigDir,
} from "./test-support"

/**
 * Renders a captured console argument the way a terminal would see it.
 *
 * `String(error)` would hide exactly what these tests are about: Bun's console
 * formatting expands an Error's own properties, and the leak lives in those
 * properties (`requestBodyValues`, headers, status). Serializing the own
 * property names keeps that visible to the assertions.
 */
function render(args: readonly unknown[]): string {
  return args
    .map(value => {
      if (value instanceof Error) {
        let own = ""
        try {
          own = JSON.stringify(value, Object.getOwnPropertyNames(value)) ?? ""
        } catch {
          own = ""
        }
        return `${value.name}: ${value.message} ${own}`
      }
      return String(value)
    })
    .join(" ")
}

/** Runs `run` with every output channel captured. */
async function withCapturedOutput<T>(
  run: () => Promise<T>,
): Promise<{ output: string[]; value?: T; thrown?: unknown }> {
  const output: string[] = []
  const original = {
    error: console.error,
    log: console.log,
    warn: console.warn,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  }
  console.error = (...args: unknown[]) => { output.push(render(args)) }
  console.log = (...args: unknown[]) => { output.push(render(args)) }
  console.warn = (...args: unknown[]) => { output.push(render(args)) }
  process.stdout.write = ((chunk: unknown) => { output.push(String(chunk)); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => { output.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    return { output, value: await run() }
  } catch (thrown) {
    return { output, thrown }
  } finally {
    console.error = original.error
    console.log = original.log
    console.warn = original.warn
    process.stdout.write = original.stdout
    process.stderr.write = original.stderr
  }
}

async function drain(model: Model): Promise<void> {
  for await (const _event of model.stream({ messages: [{ role: "user", content: "hi" }] }) as AsyncIterable<ModelEvent>) {
    // Consume the stream; the failure arrives as a throw.
  }
}

const unauthorizedBody = JSON.stringify({
  error: { message: `Incorrect API key provided: ${TEST_API_KEY}.`, type: "invalid_request_error" },
})

describe("a failing request keeps the terminal clean", () => {
  test("a 401 stream writes nothing, and still reports a scrubbed error", async () => {
    const provider = await startMockProvider(() =>
      new Response(unauthorizedBody, { status: 401, headers: { "content-type": "application/json" } }),
    )
    try {
      await withConfigDir(async () => {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const { output, thrown } = await withCapturedOutput(() => drain(model))

        expect(output).toEqual([])
        expect(thrown).toBeInstanceOf(ModelError)
        expect((thrown as ModelError).code).toBe("authentication_failed")
        // The classification is the only thing that reaches the user, and the
        // credential is masked in it — the same value the console would have
        // printed verbatim.
        expect((thrown as ModelError).message).toContain("***")
        expect((thrown as ModelError).message).not.toContain(TEST_API_KEY)
      })
    } finally {
      await provider.close()
    }
  })

  test("a refused stream writes nothing and reports a request failure", async () => {
    await withConfigDir(async () => {
      const model = await activeModelViaManager(testConfig({ endpoint: "http://127.0.0.1:9" }))
      const { output, thrown } = await withCapturedOutput(() => drain(model))

      expect(output).toEqual([])
      expect(thrown).toBeInstanceOf(ModelError)
      expect((thrown as ModelError).code).toBe("request_failed")
    })
  })

  test("a 401 generate writes nothing either", async () => {
    const provider = await startMockProvider(() =>
      new Response(unauthorizedBody, { status: 401, headers: { "content-type": "application/json" } }),
    )
    try {
      await withConfigDir(async () => {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const { output, thrown } = await withCapturedOutput(() =>
          model.generate({ messages: [{ role: "user", content: "hi" }] }),
        )

        expect(output).toEqual([])
        expect((thrown as ModelError).code).toBe("authentication_failed")
        expect((thrown as ModelError).message).not.toContain(TEST_API_KEY)
      })
    } finally {
      await provider.close()
    }
  })

  test("a refused generate writes nothing", async () => {
    await withConfigDir(async () => {
      const model = await activeModelViaManager(testConfig({ endpoint: "http://127.0.0.1:9" }))
      const { output, thrown } = await withCapturedOutput(() =>
        model.generate({ messages: [{ role: "user", content: "hi" }] }),
      )

      expect(output).toEqual([])
      expect((thrown as ModelError).code).toBe("request_failed")
    })
  })
})

describe("suppressing the SDK's own reporting changes nothing else", () => {
  test("transient failures are still retried the same number of times", async () => {
    let attempts = 0
    const provider = await startMockProvider(() => {
      attempts += 1
      return new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    })
    try {
      await withConfigDir(async () => {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const { output, thrown } = await withCapturedOutput(() => drain(model))

        // Two retries after the first attempt — the package's policy, unchanged
        // by the SDK-level callback.
        expect(attempts).toBe(3)
        expect(output).toEqual([])
        expect((thrown as ModelError).code).toBe("request_failed")
      })
    } finally {
      await provider.close()
    }
  })

  test("a successful stream is unaffected", async () => {
    const provider = await startMockProvider(() =>
      sse([
        { id: "c", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] },
        { id: "c", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        null,
      ]),
    )
    try {
      await withConfigDir(async () => {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const events: ModelEvent[] = []
        const { output } = await withCapturedOutput(async () => {
          for await (const event of model.stream({ messages: [{ role: "user", content: "hi" }] })) {
            events.push(event)
          }
        })

        expect(output).toEqual([])
        expect(events.some(e => e.type === "text_delta" && e.text === "hello")).toBe(true)
        expect(events.some(e => e.type === "finish")).toBe(true)
      })
    } finally {
      await provider.close()
    }
  })
})

import { validateModelConfig } from "./config"
import { ModelError } from "./errors"
import { createModel } from "./model"
import type { ModelConfig } from "./types"

/**
 * Output ceiling for the connectivity probe.
 *
 * The probe asks for an answer it does not read, so the ceiling is as small as
 * a provider will accept. It is a limit on what the test costs, not a claim
 * about the model.
 */
const PROBE_MAX_OUTPUT_TOKENS = 16

/**
 * Sends one real request with `config` and reports whether a model answered.
 *
 * This exists so a configuration can be checked *before* it is persisted and
 * activated: `ModelManager` persists the moment a model is added, which is the
 * wrong order for a setup flow that must not save an unverified connection.
 *
 * It goes through the same path a run does — {@link createModel} selects the
 * adapter from `config.protocol`, and the adapter owns the wire format, the
 * retry policy, the timeout (via `signal`) and the error classification — so a
 * test that passes here is evidence about the protocol that will actually be
 * used, not about a lookalike. Nothing is persisted, cached, or activated.
 *
 * Resolves when a model answered. Throws the adapter's {@link ModelError} —
 * `authentication_failed`, `rate_limited`, `request_failed`,
 * `invalid_response`, `cancelled` — whose message is already scrubbed of the
 * API key by the runtime.
 */
export async function testModelConnection(
  config: ModelConfig,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  // The same validation the manager and the persisted file go through: a
  // probe must not be the one path that accepts a configuration the rest of
  // the package would reject.
  const validated = validateModelConfig(config, "model configuration")
  const model = createModel(validated)

  const response = await model.generate({
    messages: [{ role: "user", content: "ping" }],
    maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  // A resolved call is not by itself proof of an answer: a provider can report
  // a failed generation inside an otherwise successful response. That is not a
  // working connection, and saying so here keeps the setup flow from saving
  // one.
  if (response.finishReason === "error") {
    throw new ModelError(
      "invalid_response",
      "the service reported a failed generation for this model",
    )
  }
}

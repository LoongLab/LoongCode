import type { ModelUsage } from "@loongcode/model"
import type {
  CompactionSkipReason,
  CompactionTrigger,
  ModelIdentity,
  RunFinishReason,
  RunSummary,
} from "../session/types"

/**
 * Observability event emitted during a run. Enough to reconstruct what
 * happened without reading the transcript.
 *
 * Events are runtime observability, not durable session state, so they live
 * with the run orchestration that emits them rather than in `session/types`.
 * They reference the durable records (`ModelIdentity`, `RunSummary`) but are
 * never persisted themselves.
 */
export type RunEvent =
  | { type: "run_start"; sessionId: string; runId: string; task: string; model: ModelIdentity }
  | { type: "iteration_start"; iteration: number }
  | { type: "assistant_delta"; iteration: number; text: string }
  | { type: "reasoning_delta"; iteration: number; text: string }
  | { type: "steered"; iteration: number }
  | { type: "model_response"; iteration: number; finishReason: string; usage?: ModelUsage }
  | { type: "tool_call"; iteration: number; toolCallId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_progress"; iteration: number; toolCallId: string; name: string; text: string }
  | {
      type: "tool_result"
      iteration: number
      toolCallId: string
      name: string
      ok: boolean
      result: string
      /** Derived from the ledger's own timestamps. Absent when the runtime did
       *  not record both ends of the interval — an unknown duration stays
       *  unknown rather than reading as an instant one. */
      durationMs?: number
    }
  | {
      type: "compaction"
      summarizedMessages: number
      /** What the compaction's own model call consumed. Absent when no call
       *  happened, or when the provider reported no usage. */
      usage?: ModelUsage
    }
  | {
      /**
       * Compaction could not progress. Reported for every trigger, including
       * the proactive one, which used to discard this outcome in silence —
       * the reason the failure this event exists for was undiagnosable.
       *
       * Emitted before the caller decides what to do about it: the recovery
       * that may follow is a separate event with a separate meaning.
       */
      type: "compaction_skipped"
      iteration: number
      reason: CompactionSkipReason
      trigger: CompactionTrigger
    }
  | {
      /**
       * A forced recovery reduction withheld tool output from the request
       * about to be sent, after the provider rejected one the estimate called
       * fitting. Distinct from `compaction` (history shrank durably) and from
       * the run's `pruning` totals (routine pressure-driven reduction).
       */
      type: "projection_reduced"
      iteration: number
      /** Distinct tool results withheld from the request. */
      reduced: number
      /** Combined original UTF-8 byte length of exactly those results. */
      originalBytes: number
    }
  | {
      type: "auto_retry"
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  | { type: "recovery"; note: string }
  | {
      type: "run_end"
      runId: string
      finishReason: RunFinishReason
      iterations: number
      error?: string
      /** The completed run record — the same shape the session persists, so a
       *  JSONL consumer and a snapshot reader agree without a mapping layer.
       *  `run.usage` is the run's one usage total; there is deliberately no
       *  second `usage` field here, because a separate flat total could only
       *  disagree with this one. */
      run: RunSummary
    }

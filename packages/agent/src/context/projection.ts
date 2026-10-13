import type { ModelMessage, ModelToolOutput, ModelToolResult } from "@loongcode/model"
import { estimateTokens } from "./budget"
import { normalizePath, resolveToolPath, type ToolAffordances } from "../tools/types"

/**
 * Namespaced discriminator for a pruning marker.
 *
 * Namespacing is what makes collision avoidance independent of which tools
 * happen to exist today: a future tool that legitimately emits
 * `{ pruned: true }` as genuine `json` output cannot be misread as a marker.
 */
const PRUNED_KEY = "loongcodePruned"

/** The only reason a result is reduced: the request does not fit its budget. */
export type PruneReason = "request-over-budget"

/** A `ToolMessage` plus Agent-local metadata that never reaches the provider. */
export type ProjectionMessage = ModelMessage & {
  readonly failureEvidence?: boolean
  /**
   * Declared by whichever layer capped a result — see `ToolAffordances`.
   * Keyed by `toolCallId`, because the metadata describes one execution: a
   * turn's results must each be reduced with their own recovery, never a
   * sibling's.
   */
  readonly affordances?: Readonly<Record<string, ToolAffordances>>
}

/** What one pruning pass actually removed. */
export interface PruneStats {
  /**
   * Distinct tool outputs replaced by a pruned marker. A result the two-stage
   * shrink rewrites more than once is still one reduction.
   */
  readonly reduced: number
  /** Combined original UTF-8 byte length of exactly those results. */
  readonly originalBytes: number
}

/** Inputs needed to decide whether — and how far — to reduce a request. */
export interface PruneContext {
  /**
   * Provider-reported input tokens for the *previous* request. A trigger
   * signal only: it measures a request already sent, so it can never be
   * reduced by changing the current projection.
   */
  readonly lastInputTokens?: number
  /** Tokens available for input, from `contextBudget()`. The hard boundary. */
  readonly inputBudget: number
  /**
   * Observability sink, called once for a pass that reduced something.
   *
   * Not called when nothing was reduced — absence means this pass withheld
   * nothing, so a caller never has to filter out a zero-valued observation.
   * A throwing sink is ignored: reporting must not change what pruning does.
   */
  readonly onPrune?: (stats: PruneStats) => void
  /**
   * The session's working directory, for one purpose only: telling whether a
   * later write names the file an earlier read came from. The tools resolved
   * their paths against it when they ran, so resolving them again here is what
   * makes a relative path and the absolute path it named comparable.
   *
   * Absent means unknown, and unknown stays conservative — paths in different
   * forms are then treated as possibly the same file. See
   * {@link mayNameSameFile}.
   */
  readonly cwd?: string
  /**
   * Forced recovery, used only after a provider reported that a request did
   * not fit while this module's estimate said it did.
   *
   * The pressure-driven pass stops as soon as the estimate fits, and its stage
   * one protects the whole current user turn. Both assumptions are gone here:
   * the estimate has just been contradicted by the provider, and in a
   * single-turn run the current turn holds nearly everything. So a forced pass
   * withholds every eligible result older than the newest
   * {@link RETAINED_RECOVERABLE_RESULTS}, wherever it sits, and does not stop
   * at an estimate it cannot trust.
   */
  readonly forced?: boolean
}

/**
 * The model-facing stand-in for tool output withheld from a request.
 *
 * Deliberately a structured object rather than a sentence of text: a `text`
 * output is wire-indistinguishable from a genuine tool result (see
 * `toSDKToolOutput`, which maps `text` straight to the SDK's `text` kind), so
 * no wording could tell the model this is a placeholder rather than content.
 * `json` is an existing `ModelToolOutput` variant that already has a wire
 * representation, and the marker carries no recovery *instruction* — it states
 * facts only.
 */
export interface PrunedToolOutput {
  readonly [PRUNED_KEY]: true
  readonly reason: PruneReason
  readonly toolName: string
  readonly originalBytes: number
  /**
   * A captured artifact. The capping layer wrote the full output here when it
   * withheld it, so this route recovers the output as it was — provided the
   * artifact is still there.
   *
   * Arrives structurally: the capping layer declares a `ToolAffordances` on the
   * tool result, `ToolMessage` carries it, and this projection reads it off the
   * message. Nothing here inspects the result's prose, so a tool is free to
   * reword its visible message without breaking recovery.
   */
  readonly spillPath?: string
  /**
   * Routes through a MUTABLE file, not captures: `sourcePath` names the file a
   * `read` read, and `resumeOffset` continues a capped read at a line of it.
   * Following either re-reads what the file holds now — the tool output they
   * stand in for is stored nowhere, so content that changed or was deleted
   * since cannot be reconstructed from them.
   */
  readonly sourcePath?: string
  readonly resumeOffset?: number
  /** Present when part of the content was retained rather than withheld. */
  readonly excerpt?: string
}

/** True when `output` is a pruning marker rather than real tool content. */
export function isPrunedToolOutput(
  output: ModelToolOutput,
): output is { readonly type: "json"; readonly value: PrunedToolOutput } {
  if (output.type !== "json") return false
  const value = output.value
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)[PRUNED_KEY] === true
}

/**
 * Where a withheld result can be found again.
 *
 * `spillPath` names a captured artifact, which holds the output as it was.
 * `sourcePath` and `resumeOffset` name a live file instead, so following them
 * returns the file's CURRENT contents — the same path, not necessarily the
 * same evidence.
 */
interface RecoveryRoute {
  /** File the capping layer externalized the full output to. */
  readonly spillPath?: string
  /** Offset a capped read continues from. */
  readonly resumeOffset?: number
  /** Path a re-readable result was read from. */
  readonly sourcePath?: string
}

/** Tools whose call changes what a path holds. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit"])

/** Absolute in either form the runtime runs on: a POSIX root or a drive. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Whether two recorded paths may name the same file.
 *
 * Given the session's working directory, both paths resolve exactly as the
 * tools resolved them when they ran, so a relative path and the absolute path
 * it named compare equal and anything else is a difference this can conclude.
 * Without one — a caller that has no session — only the same-form case
 * concludes anything: two paths written in different forms may well be one
 * file, and treating them as different would offer a route that returns
 * content the model never read.
 *
 * Symlinks and hard links are never detected either way. The asymmetry is
 * deliberate: treating two paths as the same only ever costs a retained
 * result, while missing one costs evidence.
 */
function mayNameSameFile(a: string, b: string, cwd: string | undefined): boolean {
  const left = resolveIdentity(a, cwd)
  const right = resolveIdentity(b, cwd)
  if (left === right) return true
  if (cwd !== undefined) return false
  return isAbsolutePath(left) !== isAbsolutePath(right)
}

/** A path as the tools would have resolved it: against the session directory
 *  when one is known, and always with `.`/`..` collapsed. Windows drive paths
 *  compare case-insensitively, because the filesystem there does. */
function resolveIdentity(path: string, cwd: string | undefined): string {
  const trimmed = path.trim()
  const collapsed = normalizePath(cwd === undefined ? trimmed : resolveToolPath(trimmed, cwd))
  return /^[A-Za-z]:[\\/]/.test(collapsed) ? collapsed.toLowerCase() : collapsed
}

/** The route a result's own declared affordances state, if any. */
function declaredRoute(affordances: ToolAffordances | undefined): RecoveryRoute | undefined {
  if (affordances === undefined) return undefined
  if (affordances.externalizedAt === undefined && affordances.resumeOffset === undefined) return undefined
  return {
    ...(affordances.externalizedAt === undefined ? {} : { spillPath: affordances.externalizedAt }),
    ...(affordances.resumeOffset === undefined ? {} : { resumeOffset: affordances.resumeOffset }),
  }
}

/** The identity of one tool call, as the assistant message that issued it
 *  states it. Deliberately not read from the result: a result does not carry
 *  its call's input, and a made-up path would be worse than none.
 *
 *  `sequence` is the call's position among the calls in the projected history,
 *  which is the order they ran in — a tool message carries results for calls
 *  that may be spread over several assistant messages, so the results' own
 *  order is not the execution order. */
interface ToolCallIdentity {
  readonly toolName: string
  readonly input: unknown
  readonly sequence: number
}

/** Every tool call the messages being projected still carry, by call id. */
function toolCallsIn(messages: readonly ProjectionMessage[]): Map<string, ToolCallIdentity> {
  const calls = new Map<string, ToolCallIdentity>()
  let sequence = 0
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool_call") continue
      calls.set(part.toolCallId, { toolName: part.toolName, input: part.input, sequence })
      sequence += 1
    }
  }
  return calls
}

/** The path a call names, when it names one. */
function callPathOf(call: ToolCallIdentity | undefined): string | undefined {
  const input = call?.input as { filePath?: unknown } | null | undefined
  const filePath = input?.filePath
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined
}

/** The path a `read` call names, when it names one. */
function readPathOf(call: ToolCallIdentity | undefined): string | undefined {
  return call?.toolName === "read" ? callPathOf(call) : undefined
}

/** Whether a write or edit after `sequence` names `path`. */
function rewrittenAfter(
  calls: ReadonlyMap<string, ToolCallIdentity>,
  sequence: number,
  path: string,
  cwd: string | undefined,
): boolean {
  for (const call of calls.values()) {
    if (call.sequence <= sequence) continue
    if (!MUTATING_TOOLS.has(call.toolName)) continue
    const target = callPathOf(call)
    if (target !== undefined && mayNameSameFile(path, target, cwd)) return true
  }
  return false
}

/**
 * Whether a route through a file still leads to what the model read: the file
 * must be identifiable from the call that read it, and no later write or edit
 * may name it.
 */
function sourcePathIsIntact(
  route: RecoveryRoute,
  call: ToolCallIdentity | undefined,
  calls: ReadonlyMap<string, ToolCallIdentity>,
  cwd: string | undefined,
): boolean {
  if (route.sourcePath === undefined || call === undefined) return false
  return !rewrittenAfter(calls, call.sequence, route.sourcePath, cwd)
}

/**
 * Whether a result reached by `route` may be withheld at all.
 *
 * A captured artifact stands on its own: it is the output, written down. A
 * route that runs through a file is only as good as the file — it must be
 * identifiable from the call that read it and un-named by any later write or
 * edit, because following it returns what the file holds now. Anything that can
 * be shown to be neither keeps the result: an offset into a file nothing here
 * can name leads somewhere the model never read.
 */
function routeIsSafe(
  route: RecoveryRoute,
  call: ToolCallIdentity | undefined,
  calls: ReadonlyMap<string, ToolCallIdentity>,
  cwd: string | undefined,
): boolean {
  if (route.sourcePath !== undefined) return sourcePathIsIntact(route, call, calls, cwd)
  if (route.spillPath !== undefined) return true
  return false
}

/**
 * How to get back to a result this pass withholds, or `undefined` when nothing
 * states a way.
 *
 * A route is a pointer, not a copy: `spillPath` names a captured artifact,
 * while `sourcePath`/`resumeOffset` name a file whose current contents are what
 * following them returns. Nothing here reads prose: a capping layer declares
 * `externalizedAt`, and a `read` states its path in its own call, which is
 * never rewritten.
 */
function recoveryRouteFor(
  affordances: ToolAffordances | undefined,
  call: ToolCallIdentity | undefined,
): RecoveryRoute | undefined {
  const declared = declaredRoute(affordances) ?? {}
  const sourcePath = readPathOf(call)
  const route: RecoveryRoute = { ...declared, ...(sourcePath === undefined ? {} : { sourcePath }) }
  return route.spillPath === undefined && route.resumeOffset === undefined && route.sourcePath === undefined
    ? undefined
    : route
}

/**
 * The marker that replaces a withheld result.
 *
 * Recovery affordances come from the result's declared metadata, never from
 * its prose. This module used to regex-match the sentences emitted by
 * `tools/truncate.ts` and `read` ("Full content saved to: …", "Use offset=N to
 * continue."), which meant rewording a tool's user-facing message silently
 * removed the model's way back to the output. The producer now declares the
 * fact structurally and this layer consumes it; no wording is load-bearing.
 */
function markerFor(
  result: ModelToolResult,
  route: RecoveryRoute | undefined,
  excerpt: string | undefined,
  originalBytes: number,
): ModelToolResult {
  return {
    ...result,
    output: {
      type: "json",
      value: {
        [PRUNED_KEY]: true,
        reason: "request-over-budget",
        toolName: result.toolName,
        originalBytes,
        ...(route?.spillPath === undefined ? {} : { spillPath: route.spillPath }),
        ...(route?.resumeOffset === undefined ? {} : { resumeOffset: route.resumeOffset }),
        ...(route?.sourcePath === undefined ? {} : { sourcePath: route.sourcePath }),
        ...(excerpt === undefined ? {} : { excerpt }),
      },
    },
  }
}

/** Index of the last user message, or -1 when there is none. */
function lastUserIndexOf(messages: readonly ProjectionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i
  }
  return -1
}

/**
 * Whether this result may be withheld from the request. Failure evidence and
 * `tool_error` results are never withheld; only `text` output is reducible
 * (markers are `json`, so this is also what makes the projection idempotent).
 */
function isReducible(message: ProjectionMessage, result: ModelToolResult): boolean {
  if (message.failureEvidence === true) return false
  return result.output.type === "text"
}

function textOf(result: ModelToolResult): string {
  return result.output.type === "text" ? result.output.text : ""
}

/** Strips Agent-local metadata; the result is what the provider receives. */
function toModelMessages(messages: readonly ProjectionMessage[]): ModelMessage[] {
  return messages.map(({ role, content }) => ({ role, content }) as ModelMessage)
}

/**
 * Eligible results a forced pass always retains: the newest this many are the
 * ones the current decision most likely rests on.
 */
const RETAINED_RECOVERABLE_RESULTS = 2

/**
 * Withhold every eligible result older than the newest
 * {@link RETAINED_RECOVERABLE_RESULTS} — the forced recovery pass.
 *
 * Eligibility is deliberately narrower than {@link isReducible}: a result is
 * withheld only when something states how to get back to it — and when that
 * way back runs through a file, only while the file can be identified and no
 * later write or edit in the same history names it, because the route returns
 * what the file holds now rather than what the model read. A captured spill is
 * unaffected by writes to the file the output came from. Everything
 * {@link isReducible} protects stays protected as well — failure evidence,
 * tool errors, and markers already in the projection.
 *
 * Deterministic and single-pass: it visits the projection once and never
 * consults the estimate, because the estimate is the thing that just failed.
 */
function withholdRecoverableResults(
  projection: ProjectionMessage[],
  calls: ReadonlyMap<string, ToolCallIdentity>,
  cwd: string | undefined,
  recordReduction: (bytes: number) => void,
): void {
  // Collect first, apply second: eligibility is decided from the untouched
  // projection, so the outcome cannot depend on the order results are visited.
  const eligible: Array<{ message: number; result: number; bytes: number; route: RecoveryRoute }> = []
  for (let i = 0; i < projection.length; i++) {
    const message = projection[i]
    if (message.role !== "tool") continue
    const content = message.content
    for (let r = 0; r < content.length; r++) {
      const result = content[r]
      if (!isReducible(message, result)) continue
      const call = calls.get(result.toolCallId)
      const route = recoveryRouteFor(message.affordances?.[result.toolCallId], call)
      if (route === undefined) continue
      // A route through a live file is only as safe as the file's identity.
      // `spillPath` is a capture and is never affected by a later write to the
      // file the output came from; `sourcePath`/`resumeOffset` are, so they are
      // offered only when the file is known and intact. Anything unprovable
      // keeps the result rather than promising content that may have changed.
      if (!routeIsSafe(route, call, calls, cwd)) continue
      eligible.push({ message: i, result: r, bytes: Buffer.byteLength(textOf(result), "utf-8"), route })
    }
  }

  const retained = new Set(
    eligible
      .slice(Math.max(0, eligible.length - RETAINED_RECOVERABLE_RESULTS))
      .map(entry => `${entry.message}:${entry.result}`),
  )
  for (const entry of eligible) {
    if (retained.has(`${entry.message}:${entry.result}`)) continue
    // Re-read from the projection: the message this entry names may already
    // carry a sibling this pass replaced, and rebuilding from a stale array
    // would silently discard that reduction.
    const current = projection[entry.message].content as readonly ModelToolResult[]
    projection[entry.message] = {
      ...projection[entry.message],
      content: current.map((candidate, ri) =>
        ri === entry.result ? markerFor(current[ri], entry.route, undefined, entry.bytes) : candidate,
      ),
    } as ProjectionMessage
    recordReduction(entry.bytes)
  }
}

/**
 * Request-time context safety.
 *
 * Responsibilities (mechanism 2) — reduce an over-budget *request projection*
 * so the model call fits its input budget. This function never mutates durable
 * history, never runs on a turn-count rule, and never withholds failure
 * evidence. Emitting a smaller durable history is compaction's job.
 *
 * Trigger vs target: the decision to *enter* reduction uses
 * `max(lastInputTokens, estimateTokens(projection))`, because provider usage is
 * the more accurate signal when it is available. The reduction *target* is
 * `estimateTokens(projection) <= inputBudget` alone — `lastInputTokens`
 * describes a request already sent and cannot be reduced by rebuilding the
 * current one, so targeting it would over-reduce or never terminate.
 *
 * Reduction order:
 *   1. withhold the oldest reducible results, oldest first;
 *   2. if the newest result alone is still too large, keep it represented as a
 *      marker that carries an excerpt and its recovery affordances.
 *
 * Terminates when the projection fits or no reducible content remains.
 *
 * Recovery (`PruneContext.forced`) is the exception to the trigger rule above:
 * it runs after a provider has rejected a request this estimate called fitting,
 * so the estimate cannot gate it and the current turn's protection cannot
 * apply. It withholds everything eligible and recoverable in one pass and
 * reports what it withheld — the caller decides whether the result is fit to
 * send, because only the caller knows the request that was rejected.
 *
 * Omitting `context` means no budget is known, so no pressure can be shown and
 * the projection is returned unchanged.
 */
export function pruneOldToolOutputs(
  messages: readonly ProjectionMessage[],
  context?: PruneContext,
): ModelMessage[] {
  if (messages.length === 0) return toModelMessages(messages)
  if (context === undefined) return messages.map(({ role, content }) => ({ role, content }) as ModelMessage)

  const projection: ProjectionMessage[] = messages.map(message => ({ ...message }))
  const forced = context.forced === true
  const safety = Math.max(context.lastInputTokens ?? 0, estimateTokens(toModelMessages(projection)))
  if (!forced && safety <= context.inputBudget) return toModelMessages(projection)

  const fits = (): boolean => estimateTokens(toModelMessages(projection)) <= context.inputBudget
  const lastUserIndex = lastUserIndexOf(projection)

  // Observability accounting. A result the two-stage shrink rewrites more than
  // once is ONE reduction, so each distinct result is recorded on its first
  // replacement and its original size added exactly once.
  let reduced = 0
  let originalBytes = 0
  const recordReduction = (bytes: number): void => {
    reduced += 1
    originalBytes += bytes
  }

  if (forced) {
    // Recovery withholds everything recoverable at once, wherever it sits —
    // including the current turn, which stage one protects and which in a
    // single-turn run holds the whole context.
    withholdRecoverableResults(projection, toolCallsIn(projection), context.cwd, recordReduction)
  } else {
    // Stage 1 — withhold the oldest reducible results. Everything in the current
    // user turn is protected, as are failure-evidence turns and tool errors.
    for (let i = 0; i < projection.length && !fits(); i++) {
      if (i >= lastUserIndex && lastUserIndex !== -1) break
      const message = projection[i]
      if (message.role !== "tool") continue
      const count = message.content.length
      for (let r = 0; r < count; r++) {
        if (fits()) break
        // Re-read from the projection: an earlier iteration of this inner loop
        // may already have replaced a sibling result, and rebuilding from a
        // stale array would silently discard that reduction.
        const current = projection[i].content as readonly ModelToolResult[]
        const result = current[r]
        if (!isReducible(projection[i], result)) continue
        const text = textOf(result)
        const bytes = Buffer.byteLength(text, "utf-8")
        // This result's own recovery, not its siblings' — see `ToolMessage.affordances`.
        const route = declaredRoute(projection[i].affordances?.[result.toolCallId])
        projection[i] = {
          ...projection[i],
          content: current.map((candidate, ri) => (ri === r ? markerFor(result, route, undefined, bytes) : candidate)),
        } as ProjectionMessage
        recordReduction(bytes)
      }
    }
  }

  // Stage 2 — the newest result alone still does not fit. Keep it represented
  // but shrink it, retaining an excerpt and any recovery affordance instead of
  // withholding it entirely.
  //
  // Never in recovery mode: the forced pass has already withheld every
  // recoverable result it may, and shrinking the newest one would trade the
  // evidence the current step most likely needs for a request the caller is
  // about to be told does not fit. Every tool but `read` caps its own output
  // far below any real budget, and `read` caps at 50KB, so a single newest
  // result is never what makes a request overflow.
  if (!forced && !fits()) {
    for (let i = projection.length - 1; i >= 0; i--) {
      const message = projection[i]
      if (message.role !== "tool") continue
      const content = message.content as readonly ModelToolResult[]
      for (let r = content.length - 1; r >= 0; r--) {
        const result = content[r]
        if (!isReducible(message, result)) continue
        const text = textOf(result)
        const bytes = Buffer.byteLength(text, "utf-8")
        // Derive the reduction from the estimator and the budget — never from
        // an arbitrary byte constant.
        const excessChars = Math.max(0, (estimateTokens(toModelMessages(projection)) - context.inputBudget) * 4)
        const keepChars = Math.max(0, text.length - excessChars)
        // This result may be rewritten twice below. It is still ONE reduced
        // result, so it is recorded on the first replacement only.
        let recorded = false
        const shrink = (excerpt: string | undefined): void => {
          projection[i] = {
            ...projection[i],
            content: content.map((candidate, ri) =>
              ri === r
                ? markerFor(result, declaredRoute(projection[i].affordances?.[result.toolCallId]), excerpt, bytes)
                : candidate),
          } as ProjectionMessage
          if (!recorded) {
            recorded = true
            recordReduction(bytes)
          }
        }
        shrink(keepChars > 0 ? text.slice(0, keepChars) : undefined)
        // The marker's own metadata costs tokens; drop the excerpt if that is
        // what it takes to fit. Deterministic, two steps, then stop.
        if (!fits() && keepChars > 0) shrink(undefined)
        break
      }
      break
    }
  }

  if (reduced > 0 && context.onPrune !== undefined) {
    try {
      context.onPrune({ reduced, originalBytes })
    } catch {
      // Best-effort reporting: a failing sink must not discard the projection
      // this pass already computed, nor change what the model receives.
    }
  }

  return toModelMessages(projection)
}

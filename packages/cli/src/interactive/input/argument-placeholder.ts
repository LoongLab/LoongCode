/**
 * Slash-command argument placeholder policy.
 *
 * Decides whether the composer should show a muted, render-only ghost
 * placeholder for the command currently being typed, and what that text is.
 * This module is deliberately pure: it depends only on the editor's text
 * state and command metadata, never on terminal rendering or command
 * execution. The TUI never learns slash-command semantics.
 */

/** The slice of command metadata the policy needs. */
export interface ArgumentPlaceholderCommand {
  readonly name: string
  readonly argumentPlaceholder?: string
}

/** The slice of editor state the policy needs. */
export interface ArgumentPlaceholderState {
  readonly lines: readonly string[]
  readonly cursorLine: number
  readonly cursorCol: number
}

/**
 * Returns the placeholder to render, or `undefined` when no ghost should be
 * shown. A ghost is shown only for a single-line bare command (optionally
 * followed by whitespace) whose name exactly matches a known command that
 * declares an `argumentPlaceholder`, with the cursor at the end of the buffer.
 */
export function argumentPlaceholderFor(
  state: ArgumentPlaceholderState,
  commands: readonly ArgumentPlaceholderCommand[],
): string | undefined {
  // Single logical line only; multiline input never shows a ghost.
  if (state.lines.length !== 1 || state.cursorLine !== 0) return undefined

  const line = state.lines[0] ?? ""

  // Cursor must be at the end of the real buffer.
  if (state.cursorCol !== line.length) return undefined

  // Treat "/name" and "/name " (and any trailing whitespace) as the same
  // bare-command state. Internal whitespace is rejected: "/name foo" is not
  // bare, and command names never contain spaces, tabs, or slashes.
  const stripped = line.replace(/[ \t]+$/, "")
  const match = /^\/([^ \t/]+)$/.exec(stripped)
  if (match === null) return undefined

  const name = match[1]!
  const command = commands.find(c => c.name === name)
  return command?.argumentPlaceholder
}

/**
 * The composer's ghost text, deciding between the two cases that share the
 * cursor: the idle placeholder while the input is empty, and the slash-command
 * argument placeholder once a bare command has been typed. One entry point keeps
 * them from ever both claiming the same cursor.
 */
export function composerGhostText(
  state: ArgumentPlaceholderState,
  commands: readonly ArgumentPlaceholderCommand[],
  idlePlaceholder: string | undefined,
): string | undefined {
  // An empty buffer at its start is the empty input area: there is no command to
  // hint at, so the placeholder is what guides the user.
  const empty =
    state.lines.length === 1 &&
    state.cursorLine === 0 &&
    state.cursorCol === 0 &&
    (state.lines[0] ?? "") === ""
  if (empty && idlePlaceholder !== undefined) return idlePlaceholder

  return argumentPlaceholderFor(state, commands)
}

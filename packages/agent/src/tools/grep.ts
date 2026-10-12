import { open, readdir, stat } from "node:fs/promises"
import * as path from "node:path"
import { BINARY_SAMPLE_BYTES, looksBinary } from "./binary"
import { matchGlob } from "./glob"
import type { Tool, ToolExecutionContext, ToolResult } from "./types"
import { resolveToolPath } from "./types"

/**
 * Content search, implemented in-process rather than by spawning `grep`.
 *
 * The external binary was the tool's one hard dependency on a POSIX userland:
 * on Windows there is no `grep`, so the agent's primary search tool failed with
 * "Executable not found in $PATH" and read as "no results" to the model. This
 * implementation keeps the interface (id, schema, result strings, caps) and the
 * output conventions the tool has always had, which were measured from GNU grep
 * before it was replaced:
 *
 * - a directory target prints `path:line:text`, a file target prints `line:text`
 *   (grep omits the filename for a single operand, and the tool surfaced that)
 * - matches are case-insensitive, numbered per file, and truncated to
 *   MAX_LINE_LENGTH after the prefix is joined, capped at MAX_MATCHES with a
 *   "(Showing 100 of N matches…)" suffix
 * - lines are split on `\n` only, so a CRLF file keeps its `\r`; a file with no
 *   trailing newline still has its last line searched and numbered
 * - `include` filters on the basename, case-sensitively, and applies to an
 *   explicit file target too
 * - binary files are skipped by content, not by name: a `.png` holding text is
 *   searched, a text file named `.bin` is not skipped
 * - `.git` and `node_modules` are searched exactly as before; the search scope
 *   did not change
 * - symlinks met during traversal are not followed (`grep -r` parity), and a
 *   symlink given as the target is
 *
 * Documented differences from GNU grep, all deliberate:
 *
 * - the regex dialect is JavaScript's. POSIX constructs that JS cannot express
 *   (`[[:alpha:]]`, `\<`, `\>`) are rejected with a clear error instead of
 *   silently matching something else, and JS-only constructs (`\d`, lookahead,
 *   non-greedy quantifiers) now work. Case-insensitivity is JavaScript's simple
 *   case folding, which is identical to grep's for ASCII
 * - a path that cannot be read is reported *with* the matches found elsewhere
 *   instead of discarding them; the note says the search was incomplete
 * - special files (FIFOs, sockets, devices) are skipped rather than read, which
 *   removes a way for the tool to block forever
 * - files are read as UTF-8 (the agent's file model); searching a source file in
 *   a legacy single-byte or CJK encoding is best-effort
 */
const MAX_LINE_LENGTH = 2000
const MAX_MATCHES = 100
const MAX_ERRORS_SHOWN = 3

interface SearchState {
  readonly regex: RegExp
  /** Basename glob, when the caller asked to filter by file name. */
  readonly include: string | null
  readonly matches: string[]
  total: number
  readonly errors: string[]
}

export const grepTool: Tool = {
  idempotent: true,
  description:
    "Search file contents with a regular expression (JavaScript syntax, case-insensitive). " +
    "Returns matching lines with file:line prefixes. Skips binary files. " +
    "Says so when part of the tree could not be read.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regular expression to search for" },
      path: { type: "string", description: "Directory or file to search in. Defaults to the workspace root." },
      include: { type: "string", description: 'Glob pattern to filter searched files by name, e.g. "*.ts"' },
    },
    required: ["pattern"],
  },

  async execute(input: unknown, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { pattern, path: searchPath, include } = input as {
      pattern?: string
      path?: string
      include?: string
    }
    if (typeof pattern !== "string" || pattern.length === 0) {
      return { ok: false, error: "pattern is required" }
    }

    const unsupported = unsupportedConstruct(pattern)
    if (unsupported !== null) return { ok: false, error: unsupported }

    let regex: RegExp
    try {
      regex = new RegExp(pattern, "i")
    } catch (err) {
      return { ok: false, error: `Invalid regular expression: ${errorMessage(err)}` }
    }

    const target = searchPath !== undefined && searchPath !== ""
      ? resolveToolPath(searchPath, ctx?.cwd)
      : ctx?.cwd ?? process.cwd()

    const entry = await stat(target).catch(() => null)
    if (entry === null) return { ok: false, error: `Search path does not exist: ${target}` }

    const state: SearchState = {
      regex,
      include: include !== undefined && include !== "" ? include : null,
      matches: [],
      total: 0,
      errors: [],
    }

    if (entry.isDirectory()) {
      const rootFailure = await walk(state, target, trimTrailingSeparators(target), "", true)
      if (rootFailure !== null) return { ok: false, error: `Cannot read directory ${target}: ${rootFailure}` }
    } else if (entry.isFile()) {
      // A single explicit file: no filename prefix, which is the shape the tool
      // has always returned for this input, and an unreadable file is an error
      // rather than a partial result — there is nothing else to search.
      const failure = await searchFile(state, target, null)
      if (failure !== null) return { ok: false, error: `Cannot read file ${target}: ${failure}` }
    } else {
      // A FIFO, socket or device: the old implementation would have handed it
      // to grep, which reads it just as if it were an ordinary file and can
      // block on it indefinitely.
      return { ok: false, error: `Search path is not a regular file or directory: ${target}` }
    }

    const capped = state.matches.map(line =>
      line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "..." : line
    )
    const truncated = state.total > MAX_MATCHES
      ? `\n\n(Showing ${MAX_MATCHES} of ${state.total} matches. Refine the pattern or narrow the path.)`
      : ""
    const incomplete = state.errors.length === 0
      ? ""
      : `\n\n(Search incomplete: ${state.errors.length} path${state.errors.length === 1 ? "" : "s"} could not be read: ${
        state.errors.slice(0, MAX_ERRORS_SHOWN).join("; ")
      })`

    if (state.total === 0) return { ok: true, data: "No matches found." + incomplete }
    return { ok: true, data: capped.join("\n") + truncated + incomplete }
  },
}

/**
 * Walks one directory. Returns a message only when `isRoot` — a tree the
 * caller explicitly asked for that cannot be read at all is an error, while a
 * subdirectory that fails mid-search is recorded and the search continues.
 */
async function walk(
  state: SearchState,
  dir: string,
  base: string,
  rel: string,
  isRoot: boolean,
): Promise<string | null> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    const message = `${dir}: ${errorMessage(err)}`
    if (isRoot) return message
    state.errors.push(message)
    return null
  }

  for (const entry of entries) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      await walk(state, path.join(dir, entry.name), base, childRel, false)
    } else if (entry.isFile()) {
      // Symlinks (of either kind) and special files fall through: `grep -r`
      // does not follow symlinks it meets, and reading a FIFO can block.
      const failure = await searchFile(state, path.join(dir, entry.name), `${base}/${childRel}`)
      if (failure !== null) state.errors.push(failure)
    }
  }
  return null
}

/** Searches one file; returns an error message, or null on success (including
 *  "skipped as binary"). `printed` is null for an explicit single-file target.
 *
 *  One open per file, and the binary sniff happens before the rest of the file
 *  is read, so a large binary is never pulled into memory just to be rejected.
 *  That matters here: this runs once per file in the tree, and file-open
 *  latency is the dominant cost of the whole search. */
async function searchFile(
  state: SearchState,
  filepath: string,
  printed: string | null,
): Promise<string | null> {
  let handle
  try {
    handle = await open(filepath, "r")
  } catch (err) {
    return `${filepath}: ${errorMessage(err)}`
  }

  try {
    const sample = Buffer.allocUnsafe(BINARY_SAMPLE_BYTES)
    // `null` position: read from — and advance — the current file position, so
    // the read below continues after the sample instead of starting over.
    const { bytesRead } = await handle.read(sample, 0, BINARY_SAMPLE_BYTES, null)
    if (looksBinary(sample.subarray(0, bytesRead))) return null

    // The rest of the file, decoded with one decoder across the two reads so a
    // multi-byte character split at the sample boundary is reassembled.
    const rest = await handle.readFile()
    const decoder = new TextDecoder("utf-8")
    const text = decoder.decode(sample.subarray(0, bytesRead), { stream: true }) + decoder.decode(rest)

    if (state.include !== null && !matchGlob(state.include, path.basename(filepath))) return null

    const lines = text.split("\n")
    // A trailing newline does not start a line: dropping the phantom empty
    // element keeps `^$` from reporting a line that does not exist.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!state.regex.test(line)) continue
      state.total++
      if (state.matches.length < MAX_MATCHES) {
        state.matches.push(printed === null ? `${i + 1}:${line}` : `${printed}:${i + 1}:${line}`)
      }
    }
    return null
  } catch (err) {
    return `${filepath}: ${errorMessage(err)}`
  } finally {
    await handle.close().catch(() => {})
  }
}

/** POSIX constructs JavaScript regular expressions cannot express. Rejecting
 *  them is deliberate: interpreting `[[:alpha:]]` as a JS character class
 *  would silently match the wrong text. */
function unsupportedConstruct(pattern: string): string | null {
  if (/\[\[:/.test(pattern)) {
    return "Unsupported POSIX character class (e.g. [[:alpha:]]): this tool uses JavaScript " +
      "regular expressions. Use a range such as [A-Za-z] instead."
  }
  if (/\\[<>]/.test(pattern)) {
    return "Unsupported POSIX word-boundary escape (\\< or \\>): this tool uses JavaScript " +
      "regular expressions. Use \\b instead."
  }
  return null
}

/** `/a/b/` → `/a/b`, while the filesystem root survives as `/` or `C:\`. */
function trimTrailingSeparators(p: string): string {
  const root = path.parse(p).root
  const trimmed = p.replace(/[\\/]+$/, "")
  return trimmed.length < root.length ? root : trimmed
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

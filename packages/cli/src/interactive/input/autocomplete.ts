import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { AutocompleteProvider, AutocompleteSuggestions } from "@loongcode/tui"
import { IGNORED_WORKSPACE_ENTRIES } from "@loongcode/agent"

const MAX_FILES = 200

/**
 * Rank of a command name against a lowercased query, so the list can order the
 * closest matches first: an exact name, then a prefix, then any other substring.
 * Ties keep declaration order (the caller breaks them by original index).
 */
function matchRank(name: string, needle: string): number {
  const lower = name.toLowerCase()
  if (lower === needle) return 0
  if (lower.startsWith(needle)) return 1
  return 2
}

/**
 * Completions for the LoongCode editor:
 * - `/` at the start of the input completes commands (and prompt templates).
 * - `@` anywhere completes workspace file paths.
 */
export class LoongCodeAutocomplete implements AutocompleteProvider {
  triggerCharacters = ["/", "@"]

  constructor(
    private readonly getCommands: () => Array<{ name: string; description: string }>,
    private readonly getWorkspace: () => string,
  ) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    _options?: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? ""
    const before = line.slice(0, cursorCol)

    if (cursorLine === 0 && before.startsWith("/")) {
      const token = before.slice(1)
      // Whitespace after the command name means an argument position, not a
      // command-name query: `/model ` must not offer or report command matches.
      if (/[ \t]/.test(token)) return null

      // Case-insensitive substring match, ordered exact → prefix → substring;
      // declaration order is preserved inside each tier (and for the empty
      // query, which matches every command).
      const needle = token.toLowerCase()
      const items = this.getCommands()
        .map((command, index) => ({ command, index }))
        .filter(entry => entry.command.name.toLowerCase().includes(needle))
        .sort((a, b) => matchRank(a.command.name, needle) - matchRank(b.command.name, needle) || a.index - b.index)
        .map(({ command }) => ({
          value: `/${command.name} `,
          label: `/${command.name}`,
          description: command.description,
        }))

      // An empty result is still an active slash interaction: the editor renders
      // its explicit no-match row instead of the menu silently closing.
      return { items, prefix: before }
    }

    const atIdx = before.lastIndexOf("@")
    if (atIdx >= 0 && !before.slice(atIdx + 1).includes(" ")) {
      const token = before.slice(atIdx + 1)
      const items = this.workspaceFiles()
        .filter(file => token.length === 0 || file.includes(token))
        .slice(0, 20)
        .map(file => ({ value: `@${file} `, label: `@${file}` }))
      return items.length > 0 ? { items, prefix: before.slice(atIdx) } : null
    }

    return null
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: { value: string },
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? ""
    const start = cursorCol - prefix.length
    const newLine = line.slice(0, start) + item.value + line.slice(cursorCol)
    const out = [...lines]
    out[cursorLine] = newLine
    return { lines: out, cursorLine, cursorCol: start + item.value.length }
  }

  private workspaceFiles(): string[] {
    const root = this.getWorkspace()
    const out: string[] = []
    const walk = (dir: string, rel: string, depth: number = 0): void => {
      if (out.length >= MAX_FILES || depth > 8) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        if (out.length >= MAX_FILES) return
        if (IGNORED_WORKSPACE_ENTRIES.has(entry)) continue
        const full = join(dir, entry)
        const relative = rel === "" ? entry : `${rel}/${entry}`
        let isDir = false
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
        if (isDir) walk(full, relative, depth + 1)
        else out.push(relative)
      }
    }
    walk(root, "")
    return out
  }
}

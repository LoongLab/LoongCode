/**
 * Glob matching for the `find` tool, without a runtime dependency on Bun.
 *
 * The semantics are the ones `Bun.Glob.match` was measured to have before the
 * Node migration, and `glob.test.ts` pins them:
 *
 * - `*` and `?` never cross `/`, so `*.ts` matches `a.ts` but not `pkg/a.ts`
 * - a `**` segment spans zero or more whole directories, so a pattern of
 *   `**` + `/*.ts` matches both `a.ts` and `pkg/sub/a.ts` (zero directories
 *   is a match, not a miss)
 * - a trailing `**` spans the rest of the path (`pkg/**` matches `pkg/a.ts`)
 * - `{a,b}` alternates, `[...]` is a character class, matching is anchored and
 *   case-sensitive, and a literal `./` prefix is not normalised away
 *
 * Patterns are compiled to a RegExp once and cached: `find` matches every
 * entry in the tree against one pattern, so re-translating per entry would be
 * wasted work on a large repository.
 */

const cache = new Map<string, RegExp>()

export function matchGlob(pattern: string, path: string): boolean {
  let compiled = cache.get(pattern)
  if (compiled === undefined) {
    compiled = new RegExp(`^${translate(pattern)}$`)
    cache.set(pattern, compiled)
  }
  return compiled.test(path)
}

function translate(pattern: string): string {
  let out = ""
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!

    if (ch === "*") {
      const isDoubleStar = pattern[i + 1] === "*" && (i === 0 || pattern[i - 1] === "/")
      if (isDoubleStar) {
        const after = pattern[i + 2]
        if (after === "/") {
          out += "(?:[^/]+/)*"
          i += 3
          continue
        }
        if (after === undefined) {
          out += ".*"
          i += 2
          continue
        }
        // `**` glued to more text is not a whole segment; fall through so each
        // star is handled as an ordinary one.
      }
      out += "[^/]*"
      i += 1
      continue
    }

    if (ch === "?") {
      out += "[^/]"
      i += 1
      continue
    }

    if (ch === "[") {
      const end = pattern.indexOf("]", i + 1)
      if (end === -1) {
        out += "\\["
        i += 1
        continue
      }
      let body = pattern.slice(i + 1, end)
      if (body.startsWith("!")) body = `^${body.slice(1)}`
      out += `[${body.replace(/\\/g, "\\\\")}]`
      i = end + 1
      continue
    }

    if (ch === "{") {
      const end = matchingBrace(pattern, i)
      if (end !== -1) {
        const alternatives = splitAlternatives(pattern.slice(i + 1, end))
        if (alternatives.length > 1) {
          out += `(?:${alternatives.map(translate).join("|")})`
          i = end + 1
          continue
        }
      }
      out += "\\{"
      i += 1
      continue
    }

    out += escapeRegExp(ch)
    i += 1
  }
  return out
}

/** Index of the `}` closing the `{` at `start`, honouring nesting. */
function matchingBrace(pattern: string, start: number): number {
  let depth = 0
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++
    else if (pattern[i] === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Splits `a,{b,c}` on the top-level commas only. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const ch of body) {
    if (ch === "{") depth++
    else if (ch === "}") depth--
    if (ch === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch
}

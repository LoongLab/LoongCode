import { readFileSync } from "node:fs"
import { join } from "node:path"

const MAX_FILE_BYTES = 200 * 1024

/**
 * Expands `@path` references in a submitted task into the referenced file's
 * content, wrapped in XML markers. References that do not resolve to an
 * existing file are left as-is, so "@" in ordinary prose is never mangled.
 *
 * A reference starts at the beginning of the line or after whitespace — which
 * is what keeps `someone@example.com` out of it — and is either quoted or a
 * bare token:
 *
 *     @src/index.ts            a bare path, no whitespace
 *     @"/abs/path with spaces" quotes for a path that contains spaces
 *     @C:\src\file.ts          a Windows drive-absolute path
 *
 * Only double quotes are recognised, and there is no escape syntax inside
 * them: a path containing a double quote cannot be referenced. Drive-absolute
 * and POSIX-absolute paths are used as written; everything else resolves
 * relative to the workspace. UNC paths (`\\server\share`) are not recognised
 * as absolute here, matching the path resolution the tools use.
 */
export function expandFileReferences(text: string, cwd: string): string {
	return text.replace(/(^|\s)@(?:"([^"]+)"|([^\s@]+))/g, (match, lead: string, quoted?: string, bare?: string) => {
		const rawPath = quoted ?? bare
		if (rawPath === undefined) return match
		const resolved = resolveReferencePath(rawPath, cwd)
		let content: string
		try {
			content = readFileSync(resolved, "utf-8")
		} catch {
			return match
		}
		if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) {
			content = content.slice(0, MAX_FILE_BYTES) + "\n… (file truncated at 200KB)"
		}
		return `${lead}<file path="${resolved}">\n${content}\n</file>`
	})
}

/**
 * Where a reference points: an absolute path as written (POSIX `/…`, Windows
 * `C:\…` or `C:/…`), anything else joined onto the workspace.
 */
export function resolveReferencePath(rawPath: string, cwd: string): string {
	const absolute = rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawPath)
	return absolute ? rawPath : join(cwd, rawPath)
}

/**
 * Decoding subprocess output.
 *
 * The contract, and what it deliberately does NOT claim:
 *
 * - UTF-8 is the assumption, and on POSIX the only one. It is what the tools
 *   emit, and it is what the agent's file model uses.
 * - On Windows a command may instead write the console code page (cmd.exe's
 *   built-ins do; so do many native tools). The console code page is what
 *   `chcp` reports — it is a property of the console the child inherited, not
 *   a property of the child: a program writing into a pipe picks its own
 *   encoding, and the CRT default (the ANSI code page) is not always the same
 *   number. The probe is therefore a *hint for labelling a fallback*, never a
 *   determination of what the producer intended.
 * - A stream is decoded as UTF-8 when the whole stream is valid UTF-8. That is
 *   strong evidence and not proof: some code-page byte sequences are also
 *   valid UTF-8 (GBK `B0 A1` decodes as the Kannada letter U+0C21), which is
 *   why the fallback is labelled, and why the guidance remains "make the
 *   command emit UTF-8" rather than "let the tool guess".
 * - The decision is made once, on the complete byte sequence of one stream, at
 *   the end — not from a prefix. A decision taken from the first non-ASCII
 *   bytes can be wrong for everything after them, and undoing emitted
 *   replacement characters is impossible. That is the whole reason stdout and
 *   stderr are captured as bytes and decoded at close.
 *
 * No dependency: `TextDecoder` is in the platform. The legacy single-byte
 * labels are always present; the multi-byte CJK labels need a full-ICU build,
 * which the official Node builds are — and when a label is missing, the
 * fallback below says so instead of failing.
 */
import { spawnSync } from "node:child_process"

/**
 * The labels this module can produce: the WHATWG names `TextDecoder` accepts
 * for the code pages a Windows console realistically reports. Spelled out here
 * because the ambient `Encoding` type in this project is Node's BufferEncoding
 * union, which covers neither `gbk` nor the other multi-byte labels — the
 * runtime accepts them (the Encoding Standard's decoder set), and the
 * `TextDecoder` construction below is the one place that has to say so.
 */
export type DecoderLabel =
  | "utf-8"
  | "gbk"
  | "big5"
  | "shift_jis"
  | "euc-kr"
  | "windows-1250"
  | "windows-1251"
  | "windows-1252"
  | "windows-874"
  | "iso-8859-1"

/** `TextDecoder` label for a console code page, or null when unknown. */
export function encodingLabelForCodePage(codePage: number): DecoderLabel | null {
  switch (codePage) {
    case 65001: return "utf-8"
    case 936: return "gbk"
    case 950: return "big5"
    case 932: return "shift_jis"
    case 949: return "euc-kr"
    case 1250: return "windows-1250"
    case 1251: return "windows-1251"
    case 1252: return "windows-1252"
    case 874: return "windows-874"
    case 28591: return "iso-8859-1"
    default: return null
  }
}

export interface DecodedStream {
  readonly text: string
  /** Set when the decoding was a disclosed guess; appended to the tool result
   *  so neither the model nor the user trusts mojibake silently. */
  readonly note: string | null
}

/** POSIX decoding: UTF-8, exactly as the tools have always decoded. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes)
}

/**
 * Windows decoding: UTF-8 when the whole stream is valid UTF-8, otherwise the
 * console code page as a labelled fallback, otherwise UTF-8 with U+FFFD and a
 * note saying no code page could be determined.
 */
export function decodeWindowsOutput(bytes: Uint8Array): DecodedStream {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), note: null }
  } catch {
    // Not UTF-8. Only now is the code page worth asking for.
    return decodeWithCodePage(bytes, consoleCodePage())
  }
}

/**
 * The fallback decision on its own, with the code page supplied: what to do
 * once a stream is known not to be UTF-8. Split out from the probe so the
 * decision — decode, label, or admit ignorance — is testable on any platform
 * and independent of what the machine it runs on happens to report.
 */
export function decodeWithCodePage(bytes: Uint8Array, codePage: number | null): DecodedStream {
  const label = codePage === null ? null : encodingLabelForCodePage(codePage)
  if (label !== null && label !== "utf-8") {
    try {
      return {
        text: new TextDecoder(label as string as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes),
        note: `output is not UTF-8; decoded using code page ${codePage} (${label}), which may be inaccurate`,
      }
    } catch {
      // The runtime has no decoder for this label (a small-ICU build).
    }
  }

  return {
    text: decodeUtf8(bytes),
    note: codePage === null
      ? "output contained bytes that are not valid UTF-8 and no code page could be determined; some characters may be inaccurate"
      : `output contained bytes that are not valid UTF-8 and code page ${codePage} has no available decoder; some characters may be inaccurate`,
  }
}

let cachedCodePage: number | null | undefined

/**
 * The console output code page, probed once per process and only on Windows.
 * `chcp` writes digits in ASCII, so reading its answer does not depend on the
 * answer. Any failure (no cmd.exe, no output, a timeout) means "unknown", and
 * callers fall back to a labelled UTF-8 decode rather than guessing.
 *
 * Caching is safe for what it is used for: a console switched to UTF-8 mid-run
 * produces valid UTF-8, which never reaches this fallback at all.
 */
export function consoleCodePage(): number | null {
  if (cachedCodePage !== undefined) return cachedCodePage
  cachedCodePage = null
  if (process.platform !== "win32") return cachedCodePage

  try {
    const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "chcp"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    })
    const match = /(\d{3,5})/.exec(result.stdout ?? "")
    if (match !== null) cachedCodePage = Number.parseInt(match[1]!, 10)
  } catch {
    // Unknown code page: the labelled fallback covers it.
  }
  return cachedCodePage
}
/**
 * Binary-content detection, shared by the file-reading and content-searching
 * tools.
 *
 * The predicate is the one `read` has always used: a NUL byte, or a sample
 * with more than 30% non-printable bytes, means the content is not text.
 * `read` additionally refuses a list of archive/executable extensions before
 * sampling, because opening one of those as text is never useful there.
 * `grep` deliberately does not: its contract is the one GNU grep's `-I` had —
 * decide on the content, not the name — so a `.png` holding text is still
 * searched, and a text file merely named `.bin` is not skipped.
 */

/** How many bytes are examined. Both callers sniff a bounded prefix rather
 *  than loading a whole file to answer "is this text?". */
export const BINARY_SAMPLE_BYTES = 4096

/** True when the sampled bytes look like binary content rather than text. */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false

  const len = Math.min(bytes.length, BINARY_SAMPLE_BYTES)
  let nonPrintable = 0
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i]! < 9 || (bytes[i]! > 13 && bytes[i]! < 32)) nonPrintable++
  }
  return nonPrintable / len > 0.3
}

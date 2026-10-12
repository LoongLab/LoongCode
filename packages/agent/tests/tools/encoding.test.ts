import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { runProcess } from "../../src/tools/process"
import {
  consoleCodePage,
  decodeUtf8,
  decodeWindowsOutput,
  decodeWithCodePage,
  encodingLabelForCodePage,
} from "../../src/tools/encoding"

/**
 * The decoding contract is "UTF-8, and only when a whole stream proves it is
 * not UTF-8 do we fall back to the console code page and say so". These tests
 * pin the decisions, not the platform: `decodeWithCodePage` takes the code page
 * as an argument, so the Windows fallback is exercised here on Linux.
 */

const utf8 = (text: string) => Buffer.from(text, "utf-8")
/** Real GBK bytes (你 = C4 E3, 好 = BA C3, 世 = CA C0), each pair deliberately
 *  chosen because it is *not* valid UTF-8 — with GBK `B0 A1` (啊) the same
 *  bytes would be a valid UTF-8 sequence, which is the collision the module
 *  documentation warns about. */
const gbk = (text: string) => {
  const table: Record<string, number[]> = { 你: [0xc4, 0xe3], 好: [0xba, 0xc3], 世: [0xca, 0xc0] }
  const bytes: number[] = []
  for (const char of text) bytes.push(...(table[char] ?? [0x3f]))
  return Buffer.from(bytes)
}

describe("code page labels", () => {
  test("known console code pages map to TextDecoder labels", () => {
    expect(encodingLabelForCodePage(65001)).toBe("utf-8")
    expect(encodingLabelForCodePage(936)).toBe("gbk")
    expect(encodingLabelForCodePage(950)).toBe("big5")
    expect(encodingLabelForCodePage(932)).toBe("shift_jis")
    expect(encodingLabelForCodePage(949)).toBe("euc-kr")
    expect(encodingLabelForCodePage(1252)).toBe("windows-1252")
  })

  test("an unknown code page has no label", () => {
    expect(encodingLabelForCodePage(99999)).toBe(null)
  })
})

describe("whole-stream decisions", () => {
  test("valid UTF-8 is decoded as UTF-8, with no note", () => {
    expect(decodeWindowsOutput(utf8("hello 世界\n"))).toEqual({ text: "hello 世界\n", note: null })
  })

  test("a stream that is not UTF-8 falls back to the code page, and says so", () => {
    const decoded = decodeWithCodePage(gbk("你好"), 936)
    expect(decoded.text).toBe("你好")
    expect(decoded.note).toContain("code page 936")
    expect(decoded.note).toContain("may be inaccurate")
  })

  test("an unknown code page is admitted, not guessed", () => {
    const decoded = decodeWithCodePage(gbk("你好"), 99999)
    expect(decoded.text).toContain("�")
    expect(decoded.note).toContain("has no available decoder")
  })

  test("no code page at all is admitted too", () => {
    const decoded = decodeWithCodePage(gbk("你好"), null)
    expect(decoded.text).toContain("�")
    expect(decoded.note).toContain("no code page could be determined")
  })

  test("mixed content is decided once for the whole stream, not per prefix", () => {
    // ASCII first, then bytes that are not UTF-8: a prefix-based decision would
    // have locked in UTF-8 before seeing them.
    const bytes = Buffer.concat([utf8("plain ascii line\n"), gbk("你好"), utf8("\nmore ascii\n")])
    const decoded = decodeWithCodePage(bytes, 936)
    expect(decoded.text).toBe("plain ascii line\n你好\nmore ascii\n")
    expect(decoded.note).not.toBe(null)
  })

  test("a code page with no usable decoder still yields a labelled result", () => {
    // 28591 (iso-8859-1) is always available; this asks for a code page number
    // that has no label at all, and asserts the resulting text is still
    // produced and still labelled.
    const decoded = decodeWithCodePage(gbk("你好"), 0)
    expect(decoded.note).toContain("not valid UTF-8")
    expect(decoded.note).toContain("may be inaccurate")
  })
})

describe("POSIX decoding is unchanged", () => {
  const unixOnly = process.platform !== "win32"

  test("valid UTF-8 decodes exactly", () => {
    expect(decodeUtf8(utf8("héllo\n"))).toBe("héllo\n")
  })

  test("invalid bytes become replacement characters rather than throwing", () => {
    expect(decodeUtf8(Buffer.from([0xc3, 0x28]))).toBe("�(")
  })

  if (unixOnly) {
    test("the probe is not attempted off Windows", () => {
      expect(consoleCodePage()).toBe(null)
    })

    test("a command producing invalid UTF-8 gets no decode note on POSIX", async () => {
      const result = await runProcess("/bin/sh", ["-c", "printf '\\303\\050'"])
      expect(result.stdout).toBe("�(")
      expect(result.decodeNote).toBeUndefined()
    })

    test("a normal command carries no decode note", async () => {
      const result = await runProcess("/bin/sh", ["-c", "printf 'plain\\n'"])
      expect(result).toEqual({ stdout: "plain\n", stderr: "", exitCode: 0 })
    })
  }
})

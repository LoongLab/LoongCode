import { describe, expect, test } from "bun:test"
import { FooterLineView } from "./footer"
import { fixedChromeRows } from "./layout"
import type { FooterRow } from "../../projection"

/**
 * The footer's usage row retracts on a short terminal.
 *
 * Visibility is a render-time decision so a resize alone — which re-renders but
 * does not call the application's footer update — retracts or restores the row,
 * and the measured chrome (and therefore the conversation's height) follows.
 */

const ROW: FooterRow = {
  groups: [
    { parts: [{ text: "Context", tone: "dim", drop: 0 }] },
    { parts: [{ text: "12k/96k", tone: "dim", drop: 0 }] },
  ],
}

describe("FooterLineView visibility", () => {
  test("renders its row when visible", () => {
    const view = new FooterLineView(() => true)
    view.setRow(ROW)
    const lines = view.render(40)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.replace(/\x1b\[[0-9;]*m/g, "")).toContain("Context · 12k/96k")
  })

  test("renders nothing when not visible", () => {
    const view = new FooterLineView(() => false)
    view.setRow(ROW)
    expect(view.render(40)).toEqual([])
  })

  test("visibility is read on every render, so a height flip takes effect with no re-set", () => {
    let tall = true
    const view = new FooterLineView(() => tall)
    view.setRow(ROW)
    expect(view.render(40)).toHaveLength(1)
    // A resize changes only the predicate's input; the row is not set again.
    tall = false
    expect(view.render(40)).toEqual([])
    tall = true
    expect(view.render(40)).toHaveLength(1)
  })

  test("an unset row renders nothing regardless of visibility", () => {
    const view = new FooterLineView(() => true)
    expect(view.render(40)).toEqual([])
  })

  test("a hidden usage row returns its line to the conversation", () => {
    let tall = true
    const usage = new FooterLineView(() => tall)
    usage.setRow(ROW)
    const first = new FooterLineView()
    first.setRow(ROW)
    // The measured chrome is one row less when the usage row retracts.
    const visibleChrome = fixedChromeRows([first, usage], 40)
    tall = false
    const hiddenChrome = fixedChromeRows([first, usage], 40)
    expect(visibleChrome).toBe(2)
    expect(hiddenChrome).toBe(1)
  })
})

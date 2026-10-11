import { describe, expect, test } from "bun:test"
import { Text } from "@loongcode/tui"
import { displayWidth } from "../../projection"
import { SetupPanel } from "./setup-panel"

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "")

/**
 * The frame is drawn from text, so the one thing that can break it is a line
 * that is not exactly the width it was asked for — which would leave the right
 * edge ragged or push the border off the screen.
 */
describe("the setup panel frame", () => {
	for (const width of [40, 60, 80, 100]) {
		test(`every line is exactly ${width} columns, with or without an input`, () => {
			const panel = new SetupPanel()
			panel.setContent({
				step: "Step 2/5",
				heading: ["Service address (Base URL)"],
				note: "A description that is long enough to be clipped on a narrow terminal, deliberately.",
				problem: "That is not a valid URL.",
				hints: "Enter Next · Esc Back",
			})

			for (const input of [null, new Text("https://api.example.com/v1", 0, 0)]) {
				panel.setInput(input)
				const lines = panel.render(width).map(strip)
				expect(lines.length).toBeGreaterThan(3)
				for (const line of lines) {
					expect(displayWidth(line)).toBe(width)
				}
			}
		})
	}

	test("a held task is shown on every step", () => {
		const panel = new SetupPanel()
		panel.setContent({ heading: ["Select API protocol"], hints: "↑/↓ Select" })
		panel.setPendingTask("fix the failing test")
		const lines = panel.render(80).map(strip).join("\n")
		expect(lines).toContain("Your task is saved: fix the failing test")

		panel.setPendingTask(null)
		expect(panel.render(80).map(strip).join("\n")).not.toContain("Your task is saved")
	})
})

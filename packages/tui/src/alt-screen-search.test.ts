import { describe, expect, test } from "bun:test"
import { AltScreenSearchIndex, type SearchSource } from "./alt-screen-search.ts"

/**
 * Search over a logical-row source.
 *
 * The transcript is windowed, so search must reach rows the viewport is not
 * painting without a full render, and it must not rebuild its corpus on an
 * ordinary frame. A source that reports a monotonic `revision` lets it do both.
 */

/** A row source that counts how many times a row is read, with a settable revision. */
class Rows implements SearchSource {
	reads = 0
	revisionValue = 0
	constructor(private lines: string[]) {}
	get rowCount(): number {
		return this.lines.length
	}
	lineAt(row: number): string {
		this.reads += 1
		return this.lines[row] ?? ""
	}
	revision(): number {
		return this.revisionValue
	}
	set(row: number, value: string): void {
		this.lines[row] = value
		this.revisionValue += 1
	}
}

describe("AltScreenSearchIndex — windowed source", () => {
	test("finds matches on rows far outside any window", () => {
		const rows = new Rows(["alpha", "beta", "TARGET-ONE", "gamma", "TARGET-TWO", "delta"])
		const index = new AltScreenSearchIndex()
		const result = index.search(rows, "target")
		expect(result.matches.length).toBe(2)
		expect(result.matches[0]!.segments[0]!.row).toBe(2)
		expect(result.matches[1]!.segments[0]!.row).toBe(4)
	})

	test("an unchanged revision does not re-read a single row", () => {
		const rows = new Rows(["one", "two", "three", "four"])
		const index = new AltScreenSearchIndex()
		index.search(rows, "three")
		const readsAfterBuild = rows.reads
		// Ten ordinary frames: the revision is unchanged, so the corpus is reused.
		for (let i = 0; i < 10; i++) index.search(rows, "three")
		expect(rows.reads).toBe(readsAfterBuild)
	})

	test("a changed revision rebuilds the corpus and refinds matches", () => {
		const rows = new Rows(["one", "two", "three"])
		const index = new AltScreenSearchIndex()
		expect(index.search(rows, "three").matches.length).toBe(1)
		rows.set(0, "three is now first")
		const rebuilt = index.search(rows, "three")
		expect(rebuilt.changed).toBe(true)
		expect(rebuilt.matches.length).toBe(2)
		expect(rebuilt.matches[0]!.segments[0]!.row).toBe(0)
	})

	test("a query change re-searches without rebuilding the corpus", () => {
		const rows = new Rows(["alpha", "beta", "gamma"])
		const index = new AltScreenSearchIndex()
		expect(index.search(rows, "alpha").matches.length).toBe(1)
		const readsAfterBuild = rows.reads
		const result = index.search(rows, "beta")
		expect(result.changed).toBe(true)
		expect(result.matches.length).toBe(1)
		// The query changed but the source did not: no rows were read again.
		expect(rows.reads).toBe(readsAfterBuild)
	})

	test("a source without a revision still works, by comparing rows", () => {
		const lines = ["one", "two", "three"]
		const source: SearchSource = { rowCount: lines.length, lineAt: (row) => lines[row] ?? "" }
		const index = new AltScreenSearchIndex()
		expect(index.search(source, "two").matches.length).toBe(1)
		expect(index.search(source, "two").matches.length).toBe(1)
		lines[0] = "two again"
		expect(index.search(source, "two").matches.length).toBe(2)
	})
})

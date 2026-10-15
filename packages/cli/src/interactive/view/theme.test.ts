import { afterEach, describe, expect, test } from "bun:test"
import {
	setThemeColorDepth,
	setThemeMonochrome,
	setThemeScheme,
	surface,
	theme,
	type ColorDepth,
	type RoleName,
	type SchemeName,
} from "./theme"

const ROLES: RoleName[] = [
	"primary", "secondary", "muted", "faint", "accent", "accentBold", "success",
	"failure", "failureBold", "warning", "running", "structure", "diffAdd",
	"diffRemove", "selected", "border", "prompt", "surface",
]

const SCHEMES: SchemeName[] = ["dark", "light"]
const DEPTHS: ColorDepth[] = ["16", "256", "truecolor"]

afterEach(() => {
	// Restore the deterministic default so other suites are unaffected.
	setThemeScheme("dark")
	setThemeColorDepth("256")
	setThemeMonochrome(false)
})

/** The SGR parameters a role emits for a marker character, or [] when plain. */
function codesFor(style: (t: string) => string): number[][] {
	const painted = style("\u0000")
	const sequences = [...painted.matchAll(/\x1b\[([0-9;]*)m/g)].map(m => m[1]!.split(";").map(Number))
	return sequences
}

describe("theme roles", () => {
	test("every role resolves at every scheme and depth without throwing", () => {
		for (const scheme of SCHEMES) {
			setThemeScheme(scheme)
			for (const depth of DEPTHS) {
				setThemeColorDepth(depth)
				for (const role of ROLES) {
					expect(typeof theme[role]("\u0000")).toBe("string")
				}
			}
		}
	})

	test("16-color roles use only 16-color SGR parameters, never a 256 index", () => {
		setThemeColorDepth("16")
		for (const scheme of SCHEMES) {
			setThemeScheme(scheme)
			for (const role of ROLES) {
				for (const params of codesFor(theme[role])) {
					// Reject the `38;5;n` / `48;5;n` 256-color form.
					expect(params).not.toContain(5)
				}
			}
		}
	})

	test("256-color roles never emit a truecolor `38;2` / `48;2` sequence", () => {
		setThemeColorDepth("256")
		for (const role of ROLES) {
			for (const params of codesFor(theme[role])) {
				expect(params.includes(2)).toBe(false)
			}
		}
	})

	test("truecolor roles resolve 256 indices to 24-bit color", () => {
		setThemeColorDepth("truecolor")
		const bold = codesFor(theme.accent)
		// The accent emits a 38;2;r;g;b sequence (five parameters).
		expect(bold.some(params => params[0] === 38 && params[1] === 2 && params.length === 5)).toBe(true)
	})

	test("the dark and light palettes differ for the roles that mark state", () => {
		setThemeColorDepth("256")
		setThemeScheme("dark")
		const darkSuccess = theme.success("\u0000")
		const darkMuted = theme.muted("\u0000")
		setThemeScheme("light")
		const lightSuccess = theme.success("\u0000")
		const lightMuted = theme.muted("\u0000")
		expect(darkSuccess).not.toBe(lightSuccess)
		expect(darkMuted).not.toBe(lightMuted)
	})

	test("monochrome collapses every role to plain text", () => {
		setThemeMonochrome(true)
		for (const role of ROLES) {
			expect(theme[role]("\u0000")).toBe("\u0000")
		}
	})

	test("the surface role is a background, and follows the scheme", () => {
		setThemeColorDepth("256")
		setThemeScheme("dark")
		expect(surface("x")).toContain("48;5;")
		setThemeScheme("light")
		expect(surface("x")).toContain("48;5;")
		expect(surface("x")).not.toBe("\u0000")
	})

	test("no role paints a transcript foreground as a hardcoded background", () => {
		// Only `surface` may emit a background; every other role is foreground or
		// attributes. This is what keeps the transcript readable on any scheme.
		setThemeColorDepth("256")
		for (const role of ROLES) {
			if (role === "surface") continue
			for (const params of codesFor(theme[role])) {
				expect(params[0]).not.toBe(48)
			}
		}
	})
})

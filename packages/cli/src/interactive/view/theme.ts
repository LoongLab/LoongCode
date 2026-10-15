import type { MarkdownTheme } from "@loongcode/tui"
import { getTerminalColorMode } from "@loongcode/tui"

/**
 * LoongCode's semantic theme.
 *
 * The UI never names a raw ANSI color; it names a *role* (muted, success,
 * diffRemove, …) and this module resolves that role for the current terminal:
 * a dark or light scheme, at 16-, 256-, or truecolor depth. Roles are the one
 * place palette decisions live, so a scheme change or a weaker terminal is
 * handled here rather than at every call site.
 *
 * The identity is monochrome: the dark and light ramps are greys, and hierarchy
 * is carried by luminance level, weight and position rather than hue. The one
 * deliberate exception is *diff semantics* — added lines are green and removed
 * lines are red — which is why `diffAdd`/`diffRemove` are their own roles and
 * are never aliased to `success`/`failure` (those also paint the execution-state
 * glyphs, which stay monochrome). The `+`/`-` markers are part of the rendered
 * line, so a diff is still readable with no colour (and under `NO_COLOR`).
 *
 * `primary` carries no colour, so the canvas and the primary foreground stay the
 * terminal's own; the app paints no transcript background.
 *
 * State is module-level and mutable because a render calls these functions
 * lazily and the scheme can change under a live session (a terminal theme
 * switch) without rebuilding the component tree.
 */

export type SchemeName = "dark" | "light"
export type ColorDepth = "16" | "256" | "truecolor"

/** Text attributes only. Color is expressed through {@link theme} roles. */
export const ansi = {
	bold: (text: string): string => `\x1b[1m${text}\x1b[22m`,
	dim: (text: string): string => `\x1b[2m${text}\x1b[22m`,
	italic: (text: string): string => `\x1b[3m${text}\x1b[23m`,
	underline: (text: string): string => `\x1b[4m${text}\x1b[24m`,
	strikethrough: (text: string): string => `\x1b[9m${text}\x1b[29m`,
}

/** A resolved role style: `(text) => text'` with the role's attributes applied. */
export type Style = (text: string) => string

/**
 * A role's palette entry. `fg256`/`bg256` are 256-color indices; `fg16`/`bg16`
 * are the SGR color parameters used on a 16-color terminal (e.g. `"36"`). An
 * empty string means "default color at this depth". A role with no color at the
 * active depth renders as plain text, which is the safe default: text stays
 * readable even where color is unavailable.
 *
 * `fgRgb` is an exact 24-bit foreground used only on a truecolor terminal; where
 * it is absent the `fg256` index is resolved through the xterm cube, as before.
 * Only the diff roles set it, because their colours are the one place the design
 * asks for an exact value rather than the nearest index.
 */
interface RoleSpec {
	readonly fg16?: string
	readonly fg256?: number
	readonly fgRgb?: readonly [number, number, number]
	readonly bg16?: string
	readonly bg256?: number
	readonly weight?: "bold" | "dim"
}

export type RoleName =
	| "primary"
	| "secondary"
	| "muted"
	| "faint"
	| "accent"
	| "accentBold"
	| "success"
	| "failure"
	| "failureBold"
	| "warning"
	| "running"
	| "structure"
	| "diffAdd"
	| "diffRemove"
	| "selected"
	| "border"
	| "prompt"
	| "surface"

/**
 * The two scheme palettes.
 *
 * Both are monochrome ramps; the indices are chosen for readable contrast
 * against a typical dark or light terminal background. `diffAdd`/`diffRemove`
 * are the sole exception and carry the only hue in the interface. An unknown
 * scheme falls back to `dark`.
 *
 * At 256 colours the greys are the nearest index to the design value (a max
 * deviation of ~5/channel, imperceptible); the diff roles additionally carry an
 * exact `fgRgb` for truecolor terminals, and a plain `fg16` for 16-colour ones.
 */
const PALETTES: Record<SchemeName, Record<RoleName, RoleSpec>> = {
	// Monochrome ramp on a dark canvas: max emphasis (231) > body (188) >
	// secondary (247) > muted (243) > faint (241) > structure (238).
	dark: {
		primary: {},
		secondary: { fg256: 247, fg16: "37" },
		muted: { fg256: 243, fg16: "2" },
		faint: { fg256: 241, fg16: "2" },
		accent: { fg256: 231, fg16: "97" },
		accentBold: { fg256: 231, fg16: "97", weight: "bold" },
		success: { fg256: 188, fg16: "97" },
		failure: { fg256: 231, fg16: "97" },
		failureBold: { fg256: 231, fg16: "97", weight: "bold" },
		warning: { fg256: 231, fg16: "97" },
		running: { fg256: 231, fg16: "97" },
		structure: { fg256: 238, fg16: "2" },
		// The design's diff colours, exact on truecolor (#6FCF97 / #E06C75).
		diffAdd: { fg256: 78, fg16: "32", fgRgb: [111, 207, 151] },
		diffRemove: { fg256: 168, fg16: "31", fgRgb: [224, 108, 117] },
		selected: { fg256: 231, fg16: "97", weight: "bold" },
		border: { fg256: 238, fg16: "2" },
		prompt: { fg256: 231, fg16: "97" },
		surface: { bg256: 235, bg16: "100" },
	},
	// Monochrome ramp on a light canvas: max emphasis (234) > body (236) >
	// secondary (238) > muted (242) > faint (247) > structure (250).
	light: {
		primary: {},
		secondary: { fg256: 238, fg16: "" },
		muted: { fg256: 242, fg16: "2" },
		faint: { fg256: 247, fg16: "2" },
		accent: { fg256: 234, fg16: "30" },
		accentBold: { fg256: 234, fg16: "30", weight: "bold" },
		success: { fg256: 236, fg16: "30" },
		failure: { fg256: 234, fg16: "30" },
		failureBold: { fg256: 234, fg16: "30", weight: "bold" },
		warning: { fg256: 234, fg16: "30" },
		running: { fg256: 234, fg16: "30" },
		structure: { fg256: 250, fg16: "2" },
		// Dark green/red: the same diff semantics, readable on a light canvas.
		diffAdd: { fg256: 22, fg16: "32", fgRgb: [31, 122, 77] },
		diffRemove: { fg256: 124, fg16: "31", fgRgb: [163, 38, 30] },
		selected: { fg256: 234, fg16: "30", weight: "bold" },
		border: { fg256: 250, fg16: "2" },
		prompt: { fg256: 234, fg16: "30" },
		surface: { bg256: 253, bg16: "47" },
	},
}

/** Dark, 256-color: the safe default before the terminal reports anything. */
let currentScheme: SchemeName = "dark"
let currentDepth: ColorDepth = "256"
/** `NO_COLOR` (or an explicit call) collapses every role to plain text. */
let monochrome = false

export function setThemeScheme(scheme: SchemeName): void {
	currentScheme = scheme
}

export function setThemeColorDepth(depth: ColorDepth): void {
	currentDepth = depth
}

export function setThemeMonochrome(on: boolean): void {
	monochrome = on
}

export function themeScheme(): SchemeName {
	return currentScheme
}

/**
 * Resolves the depth the terminal can actually show and applies the initial
 * scheme. Called once when the app starts; tests and previews that never call
 * it keep the deterministic dark/256 default.
 *
 * Colors are opt-out via `NO_COLOR`; state is never carried by color alone, so
 * a monochrome terminal loses emphasis, not meaning.
 */
export function initTheme(): void {
	monochrome = process.env.NO_COLOR !== undefined
	const mode = getTerminalColorMode()
	const term = process.env.TERM ?? ""
	const colorTerm = (process.env.COLORTERM ?? "").toLowerCase()
	const truecolor =
		mode === "truecolor" || colorTerm === "truecolor" || colorTerm === "24bit" || term.endsWith("-direct")
	const sixteen = !truecolor && colorTerm === "" && !term.includes("256") && !term.includes("truecolor")
	currentDepth = truecolor ? "truecolor" : sixteen ? "16" : "256"
}

/** xterm 16-color palette, for converting an index to 24-bit color. */
const BASE16: ReadonlyArray<readonly [number, number, number]> = [
	[0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
	[0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
	[127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0],
	[92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
]

/** Converts a 256-color index to RGB using the standard xterm cube ramp. */
function indexToRgb(index: number): readonly [number, number, number] {
	if (index < 16) return BASE16[index] ?? [255, 255, 255]
	if (index < 232) {
		const n = index - 16
		const ramp = (v: number): number => (v === 0 ? 0 : 55 + 40 * v)
		return [ramp(Math.floor(n / 36)), ramp(Math.floor((n % 36) / 6)), ramp(n % 6)]
	}
	const v = 8 + (index - 232) * 10
	return [v, v, v]
}

function fgCode(spec: RoleSpec): string | undefined {
	if (currentDepth === "16") return spec.fg16 !== undefined && spec.fg16 !== "" ? spec.fg16 : undefined
	if (currentDepth === "truecolor") {
		// An exact 24-bit value wins; otherwise the 256 index is resolved through
		// the xterm cube. Only the diff roles carry an exact value.
		if (spec.fgRgb !== undefined) {
			const [r, g, b] = spec.fgRgb
			return `38;2;${r};${g};${b}`
		}
		if (spec.fg256 !== undefined) {
			const [r, g, b] = indexToRgb(spec.fg256)
			return `38;2;${r};${g};${b}`
		}
	} else if (spec.fg256 !== undefined) {
		return `38;5;${spec.fg256}`
	}
	return spec.fg16 !== undefined && spec.fg16 !== "" ? spec.fg16 : undefined
}

function bgCode(spec: RoleSpec): string | undefined {
	if (currentDepth === "16") return spec.bg16 !== undefined && spec.bg16 !== "" ? spec.bg16 : undefined
	if (spec.bg256 !== undefined) {
		if (currentDepth === "truecolor") {
			const [r, g, b] = indexToRgb(spec.bg256)
			return `48;2;${r};${g};${b}`
		}
		return `48;5;${spec.bg256}`
	}
	return spec.bg16 !== undefined && spec.bg16 !== "" ? spec.bg16 : undefined
}

function apply(role: RoleName, text: string): string {
	if (monochrome) return text
	const spec = PALETTES[currentScheme][role]
	const open: string[] = []
	const close: string[] = []
	if (spec.weight === "bold") {
		open.push("1")
		close.push("22")
	} else if (spec.weight === "dim") {
		open.push("2")
		close.push("22")
	}
	const fg = fgCode(spec)
	if (fg !== undefined) {
		open.push(fg)
		close.push("39")
	}
	const bg = bgCode(spec)
	if (bg !== undefined) {
		open.push(bg)
		close.push("49")
	}
	if (open.length === 0) return text
	return `\x1b[${open.join(";")}m${text}\x1b[${close.join(";")}m`
}

/**
 * The semantic roles. Each is a stable name for an intent, not a color.
 *
 * `structure` draws the spine and separators, `faint` de-emphasizes metadata
 * below `muted`, and `prompt` is the composer/entry rail. `surface` is the one
 * background role, used only for opaque overlays — never for transcript rows.
 */
export const theme: Record<RoleName, Style> = {
	primary: text => apply("primary", text),
	secondary: text => apply("secondary", text),
	muted: text => apply("muted", text),
	faint: text => apply("faint", text),
	accent: text => apply("accent", text),
	accentBold: text => apply("accentBold", text),
	success: text => apply("success", text),
	failure: text => apply("failure", text),
	failureBold: text => apply("failureBold", text),
	warning: text => apply("warning", text),
	running: text => apply("running", text),
	structure: text => apply("structure", text),
	diffAdd: text => apply("diffAdd", text),
	diffRemove: text => apply("diffRemove", text),
	selected: text => apply("selected", text),
	border: text => apply("border", text),
	prompt: text => apply("prompt", text),
	surface: text => apply("surface", text),
}

/**
 * The one opaque panel background, kept as a named export because overlays
 * import it directly. It resolves through the `surface` role, so it follows the
 * scheme like everything else.
 */
export const surface = (text: string): string => theme.surface(text)

export function markdownTheme(): MarkdownTheme {
	return {
		heading: (text) => theme.accentBold(text),
		link: (text) => ansi.underline(theme.accent(text)),
		linkUrl: (text) => theme.faint(text),
		code: (text) => theme.warning(text),
		codeBlock: (text) => text,
		codeBlockBorder: (text) => theme.faint(text),
		quote: (text) => theme.muted(text),
		quoteBorder: (text) => theme.faint(text),
		hr: (text) => theme.faint(text),
		listBullet: (text) => theme.accent(text),
		bold: (text) => ansi.bold(text),
		italic: (text) => ansi.italic(text),
		strikethrough: (text) => ansi.strikethrough(text),
		underline: (text) => ansi.underline(text),
	}
}

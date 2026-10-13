import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { configDir } from "./dir"

/** Windows shells the bash tool can be configured to run commands in. CMD and
 *  PowerShell are different languages; the product never switches between them
 *  on its own. */
export type WindowsShell = "cmd" | "powershell"

/** Runtime-tunable settings: global file merged under project
 *  file (project wins), nested objects merge recursively. */
export interface LoongCodeSettings {
  autoCompact?: {
    /** Proactive compaction before the input budget is exhausted. Default on. */
    enabled: boolean
    /** Percentage of the 75% input budget that triggers compaction. Default 80. */
    thresholdPct: number
  }
  theme?: "dark" | "light"
  /** Which Windows shell the bash tool runs commands in: "powershell"
   *  (default, Windows PowerShell) or "cmd" (cmd.exe via %ComSpec%). Windows
   *  only — POSIX platforms always run commands in /bin/sh. There is no
   *  fallback: if the selected shell is unavailable the command fails with an
   *  actionable error instead of running somewhere else. */
  shell?: WindowsShell
}

const DEFAULTS: LoongCodeSettings = {
  autoCompact: { enabled: true, thresholdPct: 80 },
  theme: "dark",
  shell: "powershell",
}

export interface LoadedSettings {
  settings: LoongCodeSettings
  /** Merged view for display; sources for diagnostics. */
  globalPath: string
  projectPath: string | null
  projectExists: boolean
}

export function globalSettingsPath(): string {
  return join(configDir(), "settings.json")
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".loongcode", "settings.json")
}

/** Reads and validates one settings file; invalid JSON or shape throws
 *  `configuration_error`-style Error (callers surface it). */
function readSettingsFile(path: string, exists: boolean): Partial<LoongCodeSettings> {
  if (!exists) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
  } catch (err) {
    throw new Error(`invalid settings file ${path}: ${err instanceof Error ? err.message : err}`)
  }
  return validateSettings(parsed, path)
}

function validateSettings(input: unknown, path: string): Partial<LoongCodeSettings> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`invalid settings file ${path}: expected an object`)
  }
  const record = input as Record<string, unknown>
  const out: Partial<LoongCodeSettings> = {}
  // Unknown keys are ignored rather than rejected, which is what lets a file
  // written by an older version keep loading: a stale `model` key, for example,
  // is simply not read. Only the keys below have any meaning.
  if (record.theme !== undefined) {
    if (record.theme !== "dark" && record.theme !== "light") {
      throw new Error(`invalid settings file ${path}: theme must be "dark" or "light"`)
    }
    out.theme = record.theme
  }
  if (record.shell !== undefined) {
    if (record.shell !== "cmd" && record.shell !== "powershell") {
      throw new Error(`invalid settings file ${path}: shell must be "cmd" or "powershell"`)
    }
    out.shell = record.shell
  }
  if (record.autoCompact !== undefined) {
    if (typeof record.autoCompact !== "object" || record.autoCompact === null) {
      throw new Error(`invalid settings file ${path}: autoCompact must be an object`)
    }
    const ac = record.autoCompact as Record<string, unknown>
    const enabled = ac.enabled === undefined ? true : ac.enabled === true
    const thresholdPct = ac.thresholdPct === undefined ? DEFAULTS.autoCompact!.thresholdPct : ac.thresholdPct
    if (typeof thresholdPct !== "number" || thresholdPct < 10 || thresholdPct > 100) {
      throw new Error(`invalid settings file ${path}: autoCompact.thresholdPct must be 10..100`)
    }
    out.autoCompact = { enabled, thresholdPct }
  }
  return out
}

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(override)) {
    const current = out[key]
    if (
      typeof value === "object" && value !== null && !Array.isArray(value) &&
      typeof current === "object" && current !== null && !Array.isArray(current)
    ) {
      out[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out as unknown as T
}

/** Loads global + project settings with deterministic precedence
 *  (project overrides global, per-key deep merge). */
export function loadSettings(cwd: string): LoadedSettings {
  const globalPath = globalSettingsPath()
  const projectPath = projectSettingsPath(cwd)
  const globalExists = existsSync(globalPath)
  const projectExists = existsSync(projectPath)

  const global = readSettingsFile(globalPath, globalExists)
  const project = readSettingsFile(projectPath, projectExists)

  const merged = deepMerge(deepMerge(DEFAULTS, global), project)
  return { settings: merged, globalPath, projectPath, projectExists }
}

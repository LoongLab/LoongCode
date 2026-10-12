import type { WindowsShell } from "../config/settings"

/**
 * Which shell a command runs in, resolved in one place.
 *
 * Supported execution environments, and nothing else:
 *
 * - POSIX: `/bin/sh -c`, exactly as before.
 * - Windows: CMD (`cmd.exe`, the default, taken from `%ComSpec%`) or Windows
 *   PowerShell, chosen explicitly with the `shell` setting.
 *
 * CMD and PowerShell are different languages, and neither is POSIX. The agent
 * is told which one is active — the tool description and the `<env>` block
 * both state it — because a command written for the wrong one fails in ways
 * the model has to recognise and repair.
 *
 * The tool never switches shells on its own. If the selected shell is missing,
 * the command fails with an actionable error; falling back to the other shell
 * would run the command in a language it was not written in.
 *
 * Deliberately not supported: Git Bash, WSL, MSYS, and shell autodetection.
 * Detecting whatever happens to be installed would make behavior depend on the
 * machine rather than on configuration, and would put a POSIX shell in the
 * path of commands the environment block describes as CMD or PowerShell.
 */

export interface ShellSpec {
  readonly kind: "posix" | "cmd" | "powershell"
  /** Executable to spawn. */
  readonly command: string
  /** Arguments that precede the command text. */
  readonly args: readonly string[]
  /** Human name, used in the environment block and in error messages. */
  readonly label: string
  /** The syntax a command for this shell must use. */
  readonly syntax: string
}

/** The Windows shell used when the setting says nothing. */
export const DEFAULT_WINDOWS_SHELL: WindowsShell = "cmd"

export function resolveShell(
  platform: NodeJS.Platform,
  selection: WindowsShell | undefined,
  env: NodeJS.ProcessEnv,
): ShellSpec {
  if (platform !== "win32") {
    // The `shell` setting is a Windows shell selector; POSIX keeps /bin/sh.
    return {
      kind: "posix",
      command: "/bin/sh",
      args: ["-c"],
      label: "sh (POSIX)",
      syntax: "POSIX shell syntax",
    }
  }

  if ((selection ?? DEFAULT_WINDOWS_SHELL) === "powershell") {
    return {
      kind: "powershell",
      command: "powershell.exe",
      // No profile, no banner, and no prompts: a command that asks a question
      // must fail rather than wait for an answer nobody can give.
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
      label: "powershell.exe (Windows PowerShell)",
      syntax: "Windows PowerShell syntax (cmdlets and PowerShell operators; not CMD, not POSIX)",
    }
  }

  const command = env.ComSpec ?? "cmd.exe"
  return {
    kind: "cmd",
    command,
    args: ["/d", "/s", "/c"],
    label: `${command} (CMD)`,
    syntax: "CMD syntax (built-ins and %VAR% expansion; not PowerShell, not POSIX)",
  }
}

/** The `<env>` line that tells the model which shell its commands reach. */
export function shellEnvironmentLine(spec: ShellSpec): string {
  return `Shell: ${spec.label} — commands run with ${spec.syntax}`
}

/** The failure to report when the selected shell could not be started at all.
 *  Actionable, and explicit that nothing else was tried. */
export function shellStartFailure(spec: ShellSpec, message: string): string {
  const remedy = spec.kind === "cmd"
    ? `This is the shell from %ComSpec%; check that cmd.exe is present and on PATH.`
    : `Set "shell" to "cmd" in settings.json to use CMD, or make sure "${spec.command}" is on PATH.`
  return `The Windows shell "${spec.command}" (${spec.label}) could not be started: ${message}\n` +
    `Commands run in the shell selected by the "shell" setting ("cmd" or "powershell"), and no other ` +
    `shell is tried automatically. ${remedy}`
}

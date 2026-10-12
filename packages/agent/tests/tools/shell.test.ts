import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "../../src/context/prompt"
import { Session } from "../../src/session/session"
import { bashTool } from "../../src/tools/bash"
import {
  DEFAULT_WINDOWS_SHELL,
  resolveShell,
  shellEnvironmentLine,
  shellStartFailure,
} from "../../src/tools/shell"

/**
 * The Windows shell is a choice between two different languages, and the
 * behavior that matters is: the right one is selected, the agent is told which
 * one is active, and nothing is ever substituted silently.
 *
 * The Windows branches are exercised here by passing the platform explicitly
 * (resolveShell takes it as an argument) and, for the tool, by taking the
 * win32 path on this host — that is a simulation of the branch, not a run on
 * Windows, and no test here claims Windows verification.
 */

const ENV_WITH_COMSPEC: NodeJS.ProcessEnv = { ComSpec: "C:\\Windows\\System32\\cmd.exe" }

describe("resolveShell", () => {
  test("POSIX always runs /bin/sh -c", () => {
    const spec = resolveShell("linux", undefined, {})
    expect(spec.kind).toBe("posix")
    expect(spec.command).toBe("/bin/sh")
    expect(spec.args).toEqual(["-c"])
  })

  test("a Windows shell selection does not change POSIX execution", () => {
    // The setting is a Windows selector. Silently running PowerShell on Linux
    // (or sh on Windows) would be exactly the substitution this avoids.
    expect(resolveShell("linux", "powershell", {}).command).toBe("/bin/sh")
    expect(resolveShell("darwin", "cmd", {}).command).toBe("/bin/sh")
  })

  test("Windows defaults to CMD from %ComSpec%", () => {
    const spec = resolveShell("win32", undefined, ENV_WITH_COMSPEC)
    expect(spec.kind).toBe("cmd")
    expect(spec.command).toBe("C:\\Windows\\System32\\cmd.exe")
    expect(spec.args).toEqual(["/d", "/s", "/c"])
    expect(spec.label).toContain("CMD")
  })

  test("Windows without %ComSpec% still names cmd.exe", () => {
    expect(resolveShell("win32", undefined, {}).command).toBe("cmd.exe")
  })

  test("Windows PowerShell is selected explicitly, and says so", () => {
    const spec = resolveShell("win32", "powershell", ENV_WITH_COMSPEC)
    expect(spec.kind).toBe("powershell")
    expect(spec.command).toBe("powershell.exe")
    expect(spec.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
    expect(spec.label).toContain("PowerShell")
  })

  test("the default is CMD, stated as a constant", () => {
    expect(DEFAULT_WINDOWS_SHELL).toBe("cmd")
    expect(resolveShell("win32", DEFAULT_WINDOWS_SHELL, ENV_WITH_COMSPEC).kind).toBe("cmd")
  })
})

describe("what the agent is told", () => {
  test("the environment line names the shell and its syntax, and does not blur them", () => {
    const cmd = shellEnvironmentLine(resolveShell("win32", "cmd", ENV_WITH_COMSPEC))
    expect(cmd).toContain("CMD syntax")
    expect(cmd).toContain("not PowerShell")

    const powershell = shellEnvironmentLine(resolveShell("win32", "powershell", ENV_WITH_COMSPEC))
    expect(powershell).toContain("PowerShell syntax")
    expect(powershell).toContain("not CMD")
  })

  test("a shell that will not start is reported with the remedy, and no fallback", () => {
    const powershell = shellStartFailure(
      resolveShell("win32", "powershell", ENV_WITH_COMSPEC),
      'Executable not found in $PATH: "powershell.exe"',
    )
    expect(powershell).toContain("powershell.exe")
    expect(powershell).toContain('Set "shell" to "cmd"')
    expect(powershell).toContain("no other shell is tried automatically")

    const cmd = shellStartFailure(resolveShell("win32", "cmd", ENV_WITH_COMSPEC), "boom")
    expect(cmd).toContain("%ComSpec%")
    expect(cmd).toContain("no other shell is tried automatically")
  })

  test("the POSIX bash description is byte-identical to the historical one", () => {
    // Gate: existing Linux prompt behaviour is unchanged. On Windows the
    // description states the shell and is covered by the branch test below.
    if (process.platform === "win32") return
    expect(bashTool.description).toBe(
      "Execute a shell command (/bin/sh on Unix, cmd.exe on Windows) in the repository and observe its output. " +
        "Use for builds, tests, git status/diff, and any repository-specific verification. " +
        "Output is truncated to the last 50KB. The exit code is appended to the output.",
    )
  })

  test("the POSIX environment block keeps its historical lines, with no shell line", () => {
    if (process.platform === "win32") return
    const session = Session.create({ cwd: "/workspace" })
    const prompt = buildSystemPrompt(session)
    expect(prompt).toContain(
      `<env>\nWorking directory: /workspace\nPlatform: ${process.platform}\nToday's date: `,
    )
    expect(prompt).not.toContain("Shell:")
  })
})

describe("the simulated Windows path in the bash tool", () => {
  const unixOnly = process.platform !== "win32"

  test("an unavailable selected shell fails actionably instead of running elsewhere", async () => {
    if (!unixOnly) return // needs a POSIX host to take the win32 branch
    const platform = Object.getOwnPropertyDescriptor(process, "platform")
    const path = process.env.PATH
    // This host may reach real Windows executables (a WSL interop PATH does),
    // so the shell binaries are made unresolvable rather than assumed absent.
    process.env.PATH = "/nonexistent-loongcode-test-path"
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      // The failure must name the shell that was selected — never fall back to
      // /bin/sh and succeed, which would run the command in a language the
      // environment block says is not in use.
      const selected = await bashTool.execute({ command: "dir" }, { shell: "powershell" })
      expect(selected.ok).toBe(false)
      if (!selected.ok) {
        expect(selected.error).toContain("powershell.exe")
        expect(selected.error).toContain("no other shell is tried automatically")
      }

      const byDefault = await bashTool.execute({ command: "dir" }, {})
      expect(byDefault.ok).toBe(false)
      if (!byDefault.ok) expect(byDefault.error).toContain("cmd.exe")
    } finally {
      if (platform !== undefined) Object.defineProperty(process, "platform", platform)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  })
})

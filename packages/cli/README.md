# LoongCode

An opinionated coding agent that works directly in your repository. Give it a
software task — fix a failing test, refactor a module, track down a bug — and
it explores the code, makes changes, runs commands, and verifies its own work
in an interactive terminal UI.

## Install

[Node.js](https://nodejs.org) 22 or newer is required (npm ships with it).
LoongCode is a single platform-independent package: the same install works on
Windows, macOS, and Linux, on both x64 and arm64.

Cross-platform compatibility improvements are implemented and automated
verification has been performed on Linux; native Windows and macOS verification
remains pending.

```sh
npm install -g @loonglab/loongcode-cli
cd my-project
loongcode
```

On first launch no model is active, and LoongCode says so: it opens the setup
flow (protocol `openai` or `anthropic`, endpoint, model name, API key) before
the workspace appears, and the normal interface is not reachable until a model
is active. `/model` is that same flow — it lists the models you have configured
and offers `Add model…` for a new one. Context and output limits are defaulted,
and only exposed under an optional *Configure limits…* step. Cancelling setup
exits; a task you had already typed is not run and is not saved.

## Scripting

```sh
loongcode -p "run the tests and report failures"   # print mode
loongcode --mode json -p "find TODO comments"      # JSON event stream
loongcode -c -p "now fix what you found"           # continue last session
```

## Project instructions

`AGENTS.md` (or `CLAUDE.md`) in the repository root is loaded into the
agent's system prompt. `.loongcode/settings.json`, `.loongcode/prompts/*.md`
and `.loongcode/skills/<name>/SKILL.md` add project settings, prompt
templates, and skills (loaded automatically).

Configuration and sessions live under your user config directory
(`~/.loongcode/`) — never inside
this package.

## Windows shell

On Windows, commands run in CMD (`cmd.exe`) by default. To run them in Windows
PowerShell instead, add `shell` to `settings.json`:

```json
{
  "shell": "powershell"
}
```

- `"cmd"` (default) — `cmd.exe`, taken from `%ComSpec%`; `"powershell"` —
  `powershell.exe`, started with `-NoLogo -NoProfile -NonInteractive`.
- Global (`~/.loongcode/settings.json`) with a per-project override
  (`.loongcode/settings.json`); the project value applies.
- Windows only: other platforms always run commands in `/bin/sh`.
- CMD and PowerShell are different languages — their syntax, built-ins and
  scripts are not interchangeable, and neither has POSIX commands (`ls`, `cat`,
  `grep`, …).
- Nothing switches shells automatically: if the selected shell is unavailable
  the command fails with an error naming it. `pwsh` (PowerShell 7) is not
  selected for you.
- Choose `powershell` for PowerShell syntax, cmdlets, or tooling that exists
  only there.

See the repository README for the full product documentation.

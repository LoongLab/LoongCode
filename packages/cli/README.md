# LoongCode

### The coding agent that won't burn your context window.

An opinionated coding agent that works directly in your repository. Give it a
software task — fix a failing test, refactor a module, track down a bug — and
it explores the code, makes changes, runs commands, and verifies its own work
in an interactive terminal UI.

Running a long task is where coding agents fall apart: the context window fills
with old file reads and command output, the agent starts forgetting what it did,
and every request costs more. LoongCode treats context as a budget to defend, not
a bucket to fill — so long sessions stay sharp, coherent, and affordable. See
[Context that lasts](#context-that-lasts).

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
and offers `Add model…`, `Edit model…` and `Remove model…`. Context and output
limits are defaulted to 128000 and 8192, and changeable in the flow's optional
*Configure limits…* step. Cancelling setup exits; a task you had already typed
is not run and is not saved.

Editing a model reuses the flow, seeded from what is saved: the stored API key
is never displayed — you choose to keep it or enter a replacement — and the
change is saved only after a connection test succeeds. Model changes are refused
while a task or a compaction is running, and removing the active model reopens
setup.

## Context that lasts

Context is managed at every boundary, each layer doing the cheapest thing that
works:

- **Cap at the source** — oversized tool output is capped as it is produced,
  spilled to a file with a short preview, so one huge result cannot flood the
  window.
- **Reduce at request time** — only when a request would exceed its budget, older
  tool results are replaced by compact markers, oldest first, and only as many as
  it takes to fit. The current turn is protected.
- **Summarize durably** — when history truly overflows, older turns are
  summarized into one message with a recent tail preserved, so the session
  continues instead of ending.

A withheld result is not a dead end: its marker names where the full output still
lives, so the agent can read it back. Failure evidence and errors are never
withheld, and this reduction only changes the request that is sent — the saved
session keeps every result.

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

On Windows, commands run in Windows PowerShell (`powershell.exe`) by default.
To run them in CMD instead, add `shell` to `settings.json`:

```json
{
  "shell": "cmd"
}
```

- `"powershell"` (default) — `powershell.exe`, started with `-NoLogo
  -NoProfile -NonInteractive`; `"cmd"` — `cmd.exe`, taken from `%ComSpec%`.
- Global (`~/.loongcode/settings.json`) with a per-project override
  (`.loongcode/settings.json`); the project value applies, so an explicit
  choice is never replaced by the default.
- Windows only: other platforms always run commands in `/bin/sh`.
- CMD and PowerShell are different languages — their syntax, built-ins and
  scripts are not interchangeable, and neither has POSIX commands (`ls`, `cat`,
  `grep`, …).
- Nothing switches shells automatically: if the selected shell is unavailable
  the command fails with an error naming it, including when PowerShell is the
  default. `pwsh` (PowerShell 7) is not selected for you.
- Choose `cmd` for CMD syntax, batch built-ins, or tooling that expects
  `%ComSpec%`.

See the repository README for the full product documentation.
LoongCode is licensed under Apache-2.0; third-party material retains its own
licenses — see `THIRD_PARTY_NOTICES.md` in this package.

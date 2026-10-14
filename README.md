<div align="center">

**English** · [简体中文](README.zh-CN.md) · [한국어](README.ko.md) · [日本語](README.ja.md)

# LoongCode

### The coding agent that won't burn your context window.

**Fix a failing test. Refactor a module. Track down a bug — and keep the agent sharp from the first message to the last.**

[![npm version](https://img.shields.io/npm/v/@loonglab/loongcode-cli?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@loonglab/loongcode-cli)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![context](https://img.shields.io/badge/context-bounded-5c4ee5?style=flat-square)](#context-that-lasts)

`npm install -g @loonglab/loongcode-cli`

[Quick start](#quick-start) · [See it work](#see-it-work) · [Context that lasts](#context-that-lasts) · [What it can do](#what-it-can-do) · [Why LoongCode](#why-loongcode) · [FAQ](#faq) · [Documentation](#documentation)

</div>

---

LoongCode is an opinionated coding agent that works directly in your repository. Give it a software task and it explores the code, makes changes, runs commands, and verifies its own work — while you watch and steer it in your terminal.

Running a long task is where coding agents fall apart. The context window fills with old file reads and command output, the agent starts forgetting what it already did, and every request costs more. **LoongCode treats context as a budget to defend, not a bucket to fill** — so long sessions stay sharp, coherent, and affordable.

It is deliberately focused: a tool for getting software engineering work done, not a general-purpose AI assistant.

## Quick start

**Prerequisite:** [Node.js](https://nodejs.org) 22 or newer (npm ships with it).
LoongCode is a single platform-independent package, so this one install works on
Windows, macOS, and Linux, on both x64 and arm64.

```sh
npm install -g @loonglab/loongcode-cli
cd ~/my-project
loongcode
```

On first launch LoongCode sets up a model before the workspace opens. It tells
you no model is active and opens the setup flow, where you choose one you have
already configured or add a new one (protocol, endpoint, model name, API key).
The workspace becomes available once a model is active; cancelling setup exits.

Then type a task, press Enter, and watch it work.

> Cross-platform compatibility is implemented, with automated verification
> performed on Linux; native Windows and macOS verification remains pending.

### Running from source

To develop LoongCode itself, run it from a checkout:

```sh
git clone https://github.com/LoongLab/LoongCode.git
cd LoongCode
bun install

# start LoongCode in your project
bun ./packages/cli/src/main.ts /path/to/your/project
```

Bun is the development runtime here (package manager, bundler, test runner); the
published package does not need it. On first launch the same setup flow as above
runs before the workspace opens — protocol (`openai` or `anthropic`), endpoint, a
provider model name, and your API key, with context and output limits defaulted
to 128000 and 8192 and changeable in the optional *Configure limits…* step of
that flow. The configuration is saved locally, and you can switch models later
with `/model` or Ctrl+P.

## See it work

```text
You:  Fix the failing tests in this repository.

LoongCode:
  ▸ read src/math.ts
  ✓ read src/math.ts
  ▸ bash bun test math.test.ts
  ✓ bash bun test math.test.ts      ← observes the failure
  ▸ edit src/math.ts                ← repairs the code
  ✓ edit src/math.ts
  ▸ bash bun test math.test.ts
  ✓ bash bun test math.test.ts      ← verifies: all tests pass

  Fixed the add() function ... All tests pass.
```

You stay in control: interrupt at any time, or type a message mid-task to steer
the agent in a different direction. A failure is information — LoongCode keeps
repairing and re-verifying until the task is done or it needs you.

## Context that lasts

Most agents handle a full context window in one of two bad ways: they truncate
old output and lose the thread, or they let history grow until the request no
longer fits and the run stalls. **LoongCode does neither.** Context is managed
at every boundary — capped as it is produced, reduced when a request would
overflow, summarized when history truly does — each layer doing the cheapest
thing that works:

| Layer | When it runs | What it does |
| --- | --- | --- |
| **Cap at the source** | every tool call | Oversized output is capped as it is produced — spilled to a file with a short preview — so one huge result can never flood the window. |
| **Reduce at request time** | only when a request is over budget | Older tool results are replaced by compact markers, oldest first, and only as many as it takes to fit. The current turn is protected. |
| **Summarize durably** | when history truly overflows | Older turns are summarized into one message, preserving a recent tail — so the session continues instead of ending. |

What makes this different is **what the markers contain**. A withheld result
isn't a dead end — it is a structured pointer back:

- **Recovery routes.** Each marker names where the full output still lives (the
  spilled file, or the file a `read` came from), so the agent can go back for the
  detail instead of guessing.
- **Failure evidence is never withheld.** Errors and failed commands are exactly
  the facts a long task depends on, so they survive even when everything around
  them is reduced.
- **Your history is never rewritten by pruning.** Reduction is a request-time
  view only. The durable session — what you resume tomorrow — keeps every result
  intact.

The result: long tasks stay coherent, and cost stays bounded by the work, not by
how much output the tools happened to print. Run a long session and the token
counts stay honest, because context is a budget here — not an accident.

## What it can do

Give LoongCode a task and it runs the loop — explore, change, run, verify —
against the real repository state:

| Give it a task | What LoongCode does | Needs |
| --- | --- | --- |
| Fix a failing test | reads code, runs your tests, edits, re-runs until green | Node.js 22+ |
| Refactor a module | searches and reads with line numbers, makes diff-reviewed edits | Node.js 22+ |
| Track down a bug | explores the tree, runs commands, reports what it found and changed | Node.js 22+ |
| Create or rewrite files | writes new files and full rewrites when needed | Node.js 22+ |
| Automate in scripts and CI | `-p` prints the final response; `--mode json` streams every event | Node.js 22+ |

Its seven-tool coding set covers the whole loop — `read`, `write`, `edit`,
`grep`, `find`, `ls`, and `bash` — and each tool call is shown live as it runs.

## Why LoongCode?

Coding agents spend a large share of their effort on exploration and execution —
reading files, searching, re-reading, retrying — before ever changing a line of
code. Every one of those steps lands in the context window and costs tokens on
every request that follows. LoongCode is built around making that loop work well:

- **context is defended, not filled** — output is capped, older results are reduced, and history is summarized, so long sessions don't spiral in cost or fall off a cliff;
- **nothing is lost when it's reduced** — withheld results keep a route back, and failure evidence is never hidden;
- the agent iterates against the real repository state, not a description of it;
- the coding loop is visible and steerable — you see what it does and can redirect it while it works;
- verification is part of the workflow: the agent is expected to run your tests and prove its changes, not just claim success.

LoongCode is intentionally focused on software development. It is not trying to
be a general-purpose AI assistant.

## Configure a model

LoongCode speaks two protocols, so it works with the official APIs and with any compatible endpoint:

| Protocol | Typical use |
| --- | --- |
| `anthropic` | Anthropic API and Anthropic-protocol endpoints |
| `openai` | OpenAI API and OpenAI-protocol compatible endpoints |

Model commands:

| Command | Purpose |
| --- | --- |
| `/model` | Select a model, or `Add model…` / `Edit model…` / `Remove model…` to configure one |
| Ctrl+P | Cycle through configured models |

`/model` is the single interactive model surface: the picker lists your models
and the actions that configure them. Adding and editing run the same sequence —
protocol, endpoint, provider model, API key, an optional `Configure limits…`
step, then a real connection test that must pass before anything is saved. An
edit is seeded from the saved configuration and never displays the stored API
key; it offers to keep that key or replace it. Model changes are refused while a
task or a compaction is running, and removing the active model reopens setup.

Configuration is persisted locally under your config directory
(`~/.loongcode/models.json`) — you can also edit that file directly.

## Working with the agent

While a task runs you see everything: the current iteration, each tool call with a live preview of its output, and the assistant's response as it streams in.

- **Steer**: type a message and press Enter while the agent works — it interrupts the current direction and follows your new instruction.
- **Queue**: press Alt+Enter to queue a follow-up that runs after the current task finishes.
- **Interrupt**: press Esc to abort the running task. Queued messages are returned to the editor so nothing is lost.
- **Expand**: press Ctrl+O to show full tool output instead of a short preview.

### Sessions

Your work is saved automatically. Exit and come back later — `--continue` picks up the most recent session in the workspace, and `--resume <id>` restores a specific one. Inside the TUI, `/session` opens an interactive manager for this workspace's sessions, where you can open, search, rename, delete, fork, clone, and browse related sessions.

If LoongCode is interrupted mid-task, the next start reconciles the interrupted work: finished steps are kept, unfinished ones are reported honestly, and you can continue where things stopped.

### Slash commands

| Command | Purpose |
| --- | --- |
| `/help` | List all commands |
| `/compact` | Manually summarize the context |
| `/copy` | Copy the last response to the clipboard |
| `/session` | Manage sessions in this workspace (open, search, rename, delete, fork, clone, related) |
| `/new` | Start a fresh session in the same workspace |
| `/model` | Select or add a model |
| `/quit` | Exit |

## Project instructions

LoongCode reads instruction files from your repository root to understand your project's conventions before it starts:

- `AGENTS.override.md` — takes precedence when present
- `AGENTS.md`
- `CLAUDE.md`

The first file found is loaded into the agent's system prompt, so the agent follows your project's rules from the first message.

You can also add project-local **prompt templates** (`.loongcode/prompts/*.md`) and **skills** (`.loongcode/skills/<name>/SKILL.md`). These load automatically. Global settings live in `~/.loongcode/settings.json` and can be overridden per project in `.loongcode/settings.json`.

## Windows shell

On Windows, commands run in **Windows PowerShell** (`powershell.exe`) by default. To run them in CMD instead, add `shell` to `settings.json`:

```json
{
  "shell": "cmd"
}
```

| Value | Shell |
| --- | --- |
| `"powershell"` (default) | `powershell.exe`, started with `-NoLogo -NoProfile -NonInteractive` |
| `"cmd"` | `cmd.exe`, taken from `%ComSpec%` |

- The setting is global (`~/.loongcode/settings.json`) and can be overridden per project (`.loongcode/settings.json`); the project value applies, so an explicit choice is never replaced by the default.
- It affects Windows only. Other platforms always run commands in `/bin/sh`.
- CMD and PowerShell are different languages: their syntax, built-ins, and scripts are not interchangeable, and POSIX commands (`ls`, `cat`, `grep`, …) exist in neither. The agent is told which shell is active, so it writes commands for the one that runs.
- Nothing switches shells automatically. If the selected shell is unavailable, the command fails with an error naming it rather than running somewhere else — including when PowerShell is the default. `pwsh` (PowerShell 7) is not selected automatically either.
- Choose `cmd` when you want CMD syntax, batch built-ins, or tooling that expects `%ComSpec%`; keep the default to use PowerShell syntax and cmdlets.

## Scripting and automation

For non-interactive use — scripts, CI, code review pipelines:

```sh
# run one task and print the final response
loongcode -p "explain what this project does" /path/to/project

# emit every runtime event as JSON lines (for tooling)
loongcode --mode json -p "find all TODO comments" /path/to/project

# continue the most recent session in this workspace
loongcode -c -p "now fix the issue you found" /path/to/project
```

## FAQ

<details>
<summary><strong>Which models can I use?</strong></summary>

LoongCode speaks the `openai` and `anthropic` protocols, so it works with the
official APIs and with any compatible endpoint. Configure one with `/model`, or
edit `~/.loongcode/models.json` directly.

</details>

<details>
<summary><strong>Do I need Bun?</strong></summary>

No. Bun is the development runtime for working on LoongCode itself. The
published package runs on Node.js 22 or newer.

</details>

<details>
<summary><strong>Does LoongCode send my code anywhere?</strong></summary>

LoongCode runs locally and talks only to the model endpoint you configure, using
the API key you provide. Your source is sent to that endpoint as context for the
tasks you run; the model provider's own data policy applies.

</details>

<details>
<summary><strong>What does it cost to run?</strong></summary>

LoongCode itself is free and open source (Apache-2.0). You pay only your model
provider for the tokens you use — and LoongCode is built to keep that number
down on long tasks. See [Context that lasts](#context-that-lasts).

</details>

<details>
<summary><strong>How does LoongCode keep token usage down?</strong></summary>

Context is managed at every boundary. Output is capped as it is produced, older
tool results are reduced only when a request would exceed its budget, and
overflowing history is summarized while keeping a recent tail. Reduced results
keep a structured route back to the full output, so nothing is lost — and your
durable history is never rewritten by that reduction. See
[Context that lasts](#context-that-lasts).

</details>

<details>
<summary><strong>Does reducing context lose information?</strong></summary>

No. A withheld result is replaced by a marker that names where the full output
still lives, so the agent can read it back. Failure evidence and errors are never
withheld, and pruning only changes the request that is sent — the saved session
keeps every result. See [Context that lasts](#context-that-lasts).

</details>

<details>
<summary><strong>Where is my work saved?</strong></summary>

Sessions are saved automatically under your config directory (`~/.loongcode/`).
Resume the latest with `--continue`, a specific one with `--resume <id>`, or
manage them interactively with `/session`.

</details>

<details>
<summary><strong>Is it ready for production use?</strong></summary>

LoongCode is in early experimental development. See [Status](#status) for the
current version and [CHANGELOG.md](CHANGELOG.md) for what is included.

</details>

## Documentation

This README covers the product end to end. For more detail:

- [CLI package reference](packages/cli/README.md): install, scripting, project instructions, and the Windows shell.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release.
- [LICENSE](LICENSE): Apache License 2.0.

## Status

**Early experimental development.** LoongCode is under active development. The current version is v0.1.3 — see [CHANGELOG.md](CHANGELOG.md) for what is included.

## Contributing

LoongCode is developed in the open. Bug reports and feature requests are welcome
in [GitHub issues](https://github.com/LoongLab/LoongCode/issues). If you build
something interesting with it, we'd love to hear about it.

Participation in the project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
Report unacceptable behavior to oliverxu1996@qq.com.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do
not open a public issue for a security report.

## License

Apache License 2.0 — see [LICENSE](LICENSE). Third-party material retains its own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the inventory
and the derived portions under MIT.

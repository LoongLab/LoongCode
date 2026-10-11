# LoongCode

English | [简体中文](README.zh-CN.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

LoongCode is an opinionated coding agent that works directly in your repository. Give it a software task — fix a failing test, refactor a module, track down a bug — and it explores the code, makes changes, runs commands, and verifies its own work, while you watch and steer it in your terminal.

LoongCode is deliberately focused: it is a tool for getting software engineering work done, not a general-purpose AI assistant.

## What can it do?

Give LoongCode a task and it can:

- explore an unfamiliar repository — list, find, and search files and code;
- read files with line numbers and paging, and edit them with safe, diff-reviewed changes;
- create new files and run shell commands (tests, builds, git, anything);
- react to failing tests and broken builds — a failure is information, and LoongCode keeps repairing and re-verifying;
- work through multiple iterations on its own until the task is done or it needs you;
- show you everything it is doing, live, as streaming output in your terminal.

A typical task looks like this:

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

You stay in control: interrupt at any time, or type a message mid-task to steer the agent in a different direction.

## Why LoongCode?

Coding agents spend a large share of their effort on exploration and execution — reading files, searching, re-reading, retrying — before ever changing a line of code. LoongCode is built around making that loop work well:

- the agent iterates against the real repository state, not a description of it;
- the coding loop is visible and steerable — you see what it does and can redirect it while it works;
- verification is part of the workflow: the agent is expected to run your tests and prove its changes, not just claim success;
- context is managed deliberately, so long sessions are summarized instead of silently overflowing.

LoongCode is intentionally focused on software development. It is not trying to be a general-purpose AI assistant.

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
and only exposed under an optional *Configure limits…* step. The configuration is
saved locally, and you can switch models later with `/model` or Ctrl+P.

Then type a task, press Enter, and watch it work.

## Configuring a model

LoongCode speaks two protocols, so it works with the official APIs and with any compatible endpoint:

| Protocol | Typical use |
| --- | --- |
| `anthropic` | Anthropic API and Anthropic-protocol endpoints |
| `openai` | OpenAI API and OpenAI-protocol compatible endpoints |

Model commands:

| Command | Purpose |
| --- | --- |
| `/model` | Select an existing model, or choose `Add model…` to configure a new one |
| Ctrl+P | Cycle through configured models |

`/model` is the single interactive model surface. Adding a model asks for the
protocol, endpoint, provider model, and API key, with sensible defaults for the
context and output limits (changeable through an optional `Configure limits…`
step).

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

## Status

**Status: early experimental development.** LoongCode is under active development. The current version is v0.1.1 — see [CHANGELOG.md](CHANGELOG.md) for what is included.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

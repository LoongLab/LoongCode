# Contributing to LoongCode

Thanks for helping improve LoongCode. Focused bug fixes, new tools, context-management improvements, tests, and documentation are all welcome.

For anything large — a new tool, a change to how context is managed, or an architectural change — open an issue first and describe the intended scope so we can agree on it before you write much code.

## What fits

LoongCode is a local coding agent. It reads and edits files in your repository and runs commands with your permissions. Contributions should keep that contract intact:

- **In scope:** the agent loop, the coding toolset, context management, CLI/TUI behavior, model protocols, tests, and documentation.
- **Out of scope:** anything that sends your code or data somewhere other than the model endpoint you configured; execution that bypasses the user's configured permissions; or behavior that hides what the agent is doing.
- **Not acceptable:** telemetry, silent network calls, or reading credentials the product does not need.

If a change alters what the agent can do on a user's machine — new command execution, new network behavior, new file writes — say so explicitly in the PR. Do not treat an undeclared effect as absent.

## Development setup

LoongCode is a [Bun](https://bun.sh) workspace. Install [Bun](https://bun.sh) 1.3.13 or newer, then:

```sh
git clone https://github.com/LoongLab/LoongCode.git
cd LoongCode
bun install
```

The published package runs on Node.js 22 or newer; Bun is only the development runtime (package manager, bundler, test runner).

Run the CLI from a checkout against any project:

```sh
bun ./packages/cli/src/main.ts /path/to/your/project
```

## Checks

Run these before opening a pull request:

```sh
bun run typecheck
bun test
```

To run a focused subset while iterating, pass a path or pattern to `bun test`:

```sh
bun test packages/model
bun test packages/agent/tests/context/projection.test.ts
```

Keep the tests that cover the behavior you changed green. If you change behavior, add or update tests in the same PR rather than describing the change only in prose.

To build the standalone CLI bundle:

```sh
bun run build:cli
```

## How the repository is organized

Four packages, with dependencies flowing one way:

| Package | Name | Depends on |
| --- | --- | --- |
| `packages/model` | `@loongcode/model` | — (provider protocols, usage, errors) |
| `packages/agent` | `@loongcode/agent` | `@loongcode/model` (loop, tools, context, sessions) |
| `packages/tui` | `@loongcode/tui` | — (terminal UI framework) |
| `packages/cli` | `@loonglab/loongcode-cli` | `agent`, `model`, `tui` (entry point, interactive UI, print mode) |

Keep provider-specific code inside `packages/model`, and keep the domain logic (loop, tools, context) independent of any single provider or UI. `packages/cli` is the composition layer — it wires the others together.

## Context management is a contract

The context-management layers (capping at capture time, request-time reduction, and durable compaction) have deliberate invariants: failure evidence is never withheld, reduced tool results keep a route back to the full output, and reduction never rewrites durable history. If you change these, preserve those properties and explain in the PR how you verified them.

## Third-party code

The published CLI bundles code from `@loongcode/tui`, which is derived from MIT-licensed third-party source; see `packages/tui/LICENSE`. If you add or move third-party code, keep its license and attribution notices with it and update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Committing

Write clear commit subjects that describe the change. Keep unrelated changes in separate commits. The default branch is `master`; open pull requests against it.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the project.

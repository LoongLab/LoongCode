# Changelog

All notable changes to LoongCode will be documented in this file.

## [Unreleased]

## [0.1.3] - 2026-10-13

A model-configuration and context-management release. The setup flow sets a
model's context window and output ceiling again; `/model` edits and removes
models — seeded from what is saved, never displaying a stored key, and always
tested before anything is written; and a run whose context overflows no longer
ends when compaction cannot help: the request is reduced instead, and every
compaction that cannot progress is reported rather than discarded. It also
records the rename and the command consolidation the code has carried since
0.1.2, which are listed below.

### Added

- Model configuration is complete again in the product. The setup flow's
  unnumbered `Configure limits…` sub-step sets a new model's `contextWindow` and
  `maxOutputTokens` (defaulting to 128000 and 8192, validated as positive
  integers with the output ceiling no larger than the window); the values are
  shown on the screen that confirms the connection test, and the probe tests
  exactly the configuration that will be saved. `/model` offers `Edit model…`,
  which runs the same sequence seeded from what is saved — the id and its
  derived name stay put, the stored API key is never displayed and is either
  kept or replaced through the masked prompt, and nothing is written until a
  connection test succeeds — and `Remove model…`, which confirms by name.
  Removing the active model reopens setup immediately instead of waiting for the
  next task; removing any other model leaves the active one alone. All three
  actions are refused while a task or a compaction is running, so a model change
  can never take the workspace view out from under a run.
- An empty transcript now opens with a large `LOONGCODE` block wordmark and the
  descriptor "an opinionated coding agent", followed by the existing keyboard
  hints. The hero is a true empty state: it is centered as a group in the
  transcript viewport — horizontally, and vertically within the available
  transcript height (never against the whole terminal, so it cannot overlap the
  composer/footer) — and it renders only while the session has no conversation
  messages. The first submitted message replaces it outright, so the
  conversation never appears beneath persistent branding and the hero cannot be
  reached again through scrollback; `/new` or a switch to an empty session
  brings it back. It scales to the terminal (5-row wordmark, then 3-row, then a
  single-line fallback) and never blocks the composer, which stays focused and
  usable immediately.

### Changed

- **The product is now LoongCode.** The rename is complete across the CLI,
  its runtime, its configuration and its documentation. Command, package,
  binary and configuration names are all `loongcode`: the CLI is published as
  `@loonglab/loongcode-cli`, the executable is `loongcode`, and the user-scope
  configuration directory is `~/.loongcode/` (project-scope configuration is
  `.loongcode/`). The `MINICODE_CONFIG_DIR` override is replaced by
  `LOONGCODE_CONFIG_DIR`. The wordmark, help text, and agent identity all read
  LoongCode. There is no compatibility shim for the previous names: the old
  configuration directory and environment variable are no longer read, so an
  existing installation starts from its defaults and must be pointed at its
  configuration again.
- Prompt templates are now discovered live. The editor's `/` autocomplete and
  template invocation read `.loongcode/prompts/*.md` (and `~/.loongcode/prompts/`)
  from disk as needed, so a template added, edited, or removed while LoongCode
  is running takes effect immediately with no manual refresh. Prompt contents
  were already resolved from disk at invocation time.
- Project-local prompts (`.loongcode/prompts/*.md`) and skills
  (`.loongcode/skills/<name>/SKILL.md`) now load unconditionally. The
  per-project trust decision was removed, so no consent step is required
  before these resources reach the model. Global resources under
  `~/.loongcode/` are unchanged.
- `/model` is now a single command with no subcommands or argument forms. It
  opens one picker that selects an existing configured model or offers
  `Add model…`, which launches the guided configuration wizard. Model
  selection still activates and persists through the runtime `ModelManager`;
  Ctrl+P still cycles configured models. The `add`, `edit <id>`,
  `remove <id>`, direct `<model-id>` activation, and `Configure models…`
  forms are gone, and `/help` no longer advertises arguments.
- `/session` is now the single interactive session-management surface. It
  opens a workspace-scoped manager for the current session's `cwd`, where
  sessions can be opened/switched, searched, renamed, deleted, forked,
  cloned, and browsed by lineage. `/new` remains the direct way to create a
  session. Session management is blocked while a task or compaction is
  running. `--resume <id>` and `--continue` are unchanged.

### Removed

- The `settings.json` key `model`. It documented a "default active model id"
  that nothing ever read, and its validation could fail a settings load — and
  through it a run — over a value with no effect. The active model has always
  been owned by `models.json`; a settings file that still carries the key keeps
  loading, because unknown keys are ignored.
- Slash command `/reload`. Prompt templates are discovered live, `AGENTS.md` /
  `CLAUDE.md` and agent-facing resources load on every run, so there is nothing
  left to refresh manually.
- Slash command `/trust` and the project-trust mechanism behind it
  (`isProjectTrusted`, `trustProject`, and the `projectTrusted` settings
  key). Existing `.loongcode/settings.json` files that still contain
  `projectTrusted` remain valid; the key is simply ignored.
- Slash commands `/import` and `/export`. Session portability is not a
  current product need; sessions are still persisted and recovered through
  `--continue`, `--resume`, and `/session`.
- Slash command `/hotkeys`. The always-visible header and `/help` already
  describe the keyboard shortcuts.
- Slash commands `/login` and `/logout`. They were never authentication —
  they configured and removed local models. `/model` is now the sole model
  surface (select or add).
- Slash commands `/resume`, `/name`, `/tree`, `/fork`, and `/clone`. Their
  capabilities now live inside the `/session` manager; they are not retained
  as aliases.

### Fixed

- A run no longer ends when its context overflows and compaction cannot help. In
  a single-task run the compactable region is the task itself — everything the
  run produced sits after the last user message — so compaction reported
  `no-progress / empty-tail` and the run stopped with `context overflow detected
  but compaction made no progress: empty-tail`. The request projection is now
  reduced instead: tool output the model can get back is withheld from the
  request — output a cap spilled to a captured artifact (`spillPath`), or a
  `read` that names the file it read (`sourcePath`, plus `resumeOffset` when the
  read was capped) — while the two most recent recoverable results, failed
  executions, and observed-failure evidence are kept, and each withheld result
  states what it held and how to get back to it. The two kinds of route do not
  promise the same thing: a spill artifact holds the output as it was, while a
  path re-reads the file's current contents — so a read whose file a later write
  or edit in the same history names is kept, rather than offered a route that
  would return something the model never read. Only the request is reduced:
  durable history is untouched, and a reference that no longer resolves fails as
  a normal read error rather than returning invented content. Recovery is
  bounded like compaction retries (five per run), never sends a reduced request
  identical to one a provider has already rejected, and ends the run naming the
  failed stage and carrying the provider's own diagnostic when nothing
  recoverable remains.
- Compaction that cannot progress is no longer silent. The proactive check used
  to discard a `no-progress` outcome entirely, so the only trace of it was the
  failure it eventually caused; every attempt now emits a `compaction_skipped`
  event naming the reason (`empty-tail`, `no-compactable-region`,
  `empty-summary`) and the trigger (`proactive`, `reactive`, `provider`), a
  recovery emits `projection_reduced`, and the run record carries
  `compactionSkips` and `projectionRecoveries` so a finished run still explains
  itself. A proactive verdict is reported once per unchanged history: the
  attempt is not repeated — with its checkpoint and its event — on every
  iteration that changes nothing compaction could act on, and is retried as soon
  as the history moves. `/compact` reports which reason applied instead of a
  bare "nothing to compact".

## [0.1.2] - 2026-10-12

A cross-platform compatibility release. Windows gets a real choice of shell —
Windows PowerShell by default, CMD on request — and the tool layer no longer
assumes a POSIX userland underneath: file search runs in-process instead of
shelling out to `grep`, command output is decoded by contract rather than
assumed to be UTF-8, cancelling a command always returns, and `@file`
references work with spaces and Windows paths.

Verification remains Linux: the automated suite runs there, the Windows paths
are covered by simulated tests, and native Windows and macOS runs are still
outstanding.

### Added

- **Windows shell selection.** `settings.shell` chooses which shell commands
  run in on Windows: `"powershell"` (Windows PowerShell, the default) or
  `"cmd"` (CMD, taken from `%ComSpec%`). It is global with a per-project
  override, and an explicit choice is never replaced by the default. It applies
  to Windows only — other platforms always run commands in `/bin/sh`, with the
  prompts and tool descriptions they have always had. Nothing switches shells
  automatically: if the selected shell cannot start, the command fails with an
  error naming it instead of running somewhere else, and PowerShell 7 (`pwsh`)
  is never chosen for you. CMD and PowerShell are different languages, so the
  system prompt and the tool description state which one is active.

### Changed

- **Windows PowerShell is the default shell on Windows.** An installation that
  never set `settings.shell` now runs commands in `powershell.exe` instead of
  CMD; one that already chose `"cmd"` — globally or per project — keeps CMD.
  The change is Windows only.
- **File search no longer needs an external `grep` binary.** The `grep` tool
  searches in-process, so it works where no `grep` exists — on Windows it
  previously failed with "Executable not found in $PATH", which the agent read
  as "no results". The interface, the output format (matching lines with
  `file:line` prefixes, the 100-match cap, `No matches found.`) and the search
  scope (`.git` and `node_modules` are still searched) are unchanged. Regular
  expressions are JavaScript's rather than POSIX ERE: `\d`, lookahead and
  non-greedy quantifiers now work, while `[[:alpha:]]`, `\<` and `\>` are
  rejected with an error naming the replacement instead of silently matching
  something else. This is not full GNU grep compatibility — the dialect, the
  `include` glob (now the same dialect as `find`, where `{a,b}` alternates) and
  the handling of unreadable paths all differ as described here.
- **A search that cannot read part of the tree says so, and still returns what
  it found.** Previously a single unreadable path failed the whole search and
  discarded the matches; the result now carries them with a "(Search
  incomplete: …)" note. Special files such as FIFOs and devices are skipped
  rather than read, which removes a way for a search to block indefinitely.
- **Subprocess output is decoded as UTF-8 unless the whole stream proves
  otherwise.** On Windows, output that is not valid UTF-8 — `cmd.exe`
  built-ins and many native tools write the console code page — is decoded
  with the console code page and the result says which one was used, instead
  of arriving as mojibake. That fallback is a labelled best guess, not
  detection of what a program intended: the console code page describes the
  console, not the program, and a stream can be valid UTF-8 while having been
  written in another encoding. When no code page can be determined, the output
  says that instead of pretending. POSIX decoding is unchanged.

### Fixed

- **Cancelling a command always returns.** Aborting a run (Esc) settles the
  tool call within a bounded grace period even when the command refuses to
  die; previously a Windows cancellation whose `taskkill` was missing or failed
  could leave the call waiting forever, with no error and no diagnostic.
  Termination is still best-effort — a process or descendant that escapes the
  process tree can survive — and the result says explicitly when cleanup could
  not be confirmed, rather than implying the tree is gone.
- **`@file` references now work with spaces and Windows paths.** `@"my
  notes.md"` and `@C:\src\a.ts` (either slash) expand to the file's content
  like any other reference; they used to be left as literal text. Unresolved
  references still stay literal, so `@` in ordinary prose is never mangled.

## [0.1.1] - 2026-10-12

Fixes Backspace in the terminal environments where the key arrives as a raw
`0x08` byte. It was decoded as Ctrl+Backspace whenever `WT_SESSION` was set —
an inherited environment variable, not a property of the byte stream — and no
binding wanted that key, so the editor discarded the byte and nothing was
deleted. A raw `0x08` now means plain Backspace everywhere; Ctrl+Backspace
remains distinguishable wherever the terminal encodes it explicitly.

### Fixed

- Backspace deletes the character before the cursor when the terminal sends
  `0x08` (Windows consoles, mintty/Git Bash, multiplexers, terminals started
  from a Windows Terminal shell), not only when it sends `0x7F`.
- Ctrl+Backspace is bound to delete-word-backward for terminals that encode it
  unambiguously (Kitty CSI-u, modifyOtherKeys). It previously matched nothing
  at all, on every terminal.

### Added

- Regression coverage for Backspace across terminal environments
  (`packages/cli/src/interactive/input/backspace.test.ts`): the `0x08`/`0x7F`
  matrix with `WT_SESSION` and the SSH variables present and absent, empty
  input, deletion before the cursor, start-of-line merging, and both
  Alt+Backspace encodings.

## [0.1.0] - 2026-09-27

First working MiniCode coding-agent baseline: point the terminal UI at a
repository, describe a task, and the agent explores the code, edits files,
runs tests, and repairs failures until the work is verified.

### Added

#### Core

- Coding-agent runtime: `MiniCode` root with autonomous task execution over
  durable, auto-persisted sessions stored as atomic JSON snapshots.
- Agent loop with repeated model/tool interaction, maximum-iteration and
  repeated-call (doom-loop) guards, and deterministic finish reasons.
- Tool execution ledger with explicit `pending → running → succeeded/failed`
  lifecycle, crash-safe checkpoint ordering, and deterministic recovery of
  interrupted runs (safe reissue of idempotent tools, explicit
  unknown-outcome reporting otherwise).
- Orphan-process supervision and a recovery note for the model after
  interrupted sessions.
- Reactive context compaction against a fixed 75/25 input/output budget
  split, plus serialization-time pruning of old tool outputs.
- Runtime events (`RunEvent`) covering iterations, tool calls, results,
  progress, compaction, retries, recovery, and run completion.

#### Model layer

- `ModelManager` for model configuration with atomic local JSON persistence.
- `Model` invocation over `openai` and `anthropic` protocol endpoints with
  normalized streaming events, tool calls, usage, finish reasons, and errors.
- Transient-failure retry with backoff, provider-overload detection, and
  cancellation propagation.
- Canonical structured message model: assistant tool-call parts and tool
  results correlated by `toolCallId`, with text/JSON/error outputs.

#### Coding tools

- `read`, `write`, `edit` (whitespace/fuzzy-tolerant replacement with diffs),
  `grep`, `find`, `ls`, and `bash` tools with output truncation, binary
  detection, and live streaming output for long-running commands.

#### Terminal UI

- Interactive main-screen terminal UI: streaming markdown assistant output,
  tool call/result rendering with live progress, working spinner, status
  footer (model, context usage, workspace), input editor with history,
  multiline input, and `@file` path completion with content embedding.
- Interaction semantics: Enter submits (and steers a running task),
  Alt+Enter queues follow-ups, Esc interrupts, Ctrl+C/Ctrl+D exit,
  Ctrl+O toggles tool output, Ctrl+P cycles models.
- Slash commands: `/help`, `/model`, `/login`, `/logout`, `/new`, `/resume`,
  `/name`, `/session`, `/compact`, `/copy`, `/export`, `/import`, `/trust`,
  `/reload`, `/fork`, `/clone`, `/tree`, `/hotkeys`, `/quit`.
- Session replay on load; session persistence survives interruption.

#### Non-interactive

- Print mode (`-p`) and JSON event mode (`--mode json`) for single-shot and
  scripted usage.
- Session continuation flags (`--continue`, `--resume`).

#### Project & resources

- Project instruction loading (`AGENTS.md` / `CLAUDE.md`) into the system
  prompt.
- Global and project settings with deterministic deep-merge precedence.
- Prompt templates and skills as user/project resources, gated behind an
  explicit project-trust decision for project-local content.

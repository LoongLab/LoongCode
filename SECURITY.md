# Security Policy

## Reporting a vulnerability

Do not disclose vulnerabilities in a public issue. Report them privately through
[GitHub's private vulnerability reporting](https://github.com/LoongLab/LoongCode/security/advisories/new),
or email **oliverxu1996@qq.com** if you cannot use GitHub.

Include the LoongCode version, operating system, model protocol and endpoint
(vendor names are enough — do not send API keys), impact, reproduction steps,
and any suggested mitigation. Remove credentials, tokens, and unrelated file
paths from logs or examples.

We will acknowledge the report, assess its scope, and coordinate remediation and
disclosure timing with you.

## Supported versions

Security fixes are provided for the latest published version of the
`@loonglab/loongcode-cli` package. Upgrade before reporting a problem that a
current release may already have fixed.

## Security boundary

LoongCode is a local coding agent. It runs on your machine, reads and edits
files in the repository it was started in, and runs commands with your operating
system permissions. It is not a sandbox.

- **Model traffic.** LoongCode sends repository content and tool output only to
  the model endpoint you configure in `~/.loongcode/models.json`. It does not
  send your code or data anywhere else, and it makes no silent network calls. An
  endpoint you point it at sees everything the agent reads or produces, so treat
  the endpoint as a disclosure boundary.
- **Commands.** The `bash` tool executes shell commands with your user's
  permissions. In v0.1 the tools are auto-approved, so a command the model
  chooses runs without an interactive prompt. Review what the agent did before
  trusting an unattended run, and do not run LoongCode against a repository you
  would not let an autonomous process modify.
- **Credentials.** API keys are stored in plain text in
  `~/.loongcode/models.json` by design (a local application). They are never
  written into sessions, events, errors, or logs. The file is readable by your
  account only; protect it the way you protect any local secret.
- **Sessions and checkpoints.** Session history and file checkpoints are stored
  under `~/.loongcode/sessions/`, or `<cwd>/.loongcode` for project-scoped
  prompts. They contain the content the agent processed, including anything the
  tools read.

This boundary does not protect against a malicious process already running as
your user, against a model endpoint you chose that mishandles your data, or
against commands the agent runs that you approved by running the agent.

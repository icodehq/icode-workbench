# Security Policy

## Reporting a vulnerability

Do not disclose vulnerabilities in a public issue. Report them privately through
[GitHub's private vulnerability reporting](https://github.com/icodehq/icode-workbench/security/advisories/new),
or email **oliverxu1996@qq.com** if you cannot use GitHub.

Include the iCode Workbench version or commit, operating system and target
(local machine or WSL distro), harness, impact, reproduction steps, and any
suggested mitigation. Remove credentials, API keys, tokens, and unrelated file
paths from logs or examples.

We will acknowledge the report, assess its scope, and coordinate remediation and
disclosure timing with you.

## Supported versions

iCode Workbench is pre-1.0. Security fixes are provided for the latest release
only; older builds are not maintained. Upgrade before reporting a problem that a
current build may already have fixed.

## Security boundary

iCode Workbench is a local desktop application. It is not a sandbox and does not
provide a security boundary between you and the coding agents you choose to run.

- **Model traffic belongs to the harness.** Workbench does not call model APIs.
  Claude Code, Codex, OpenCode, and any other harness you run send repository
  content and tool output to the endpoint configured for that harness. Treat that
  endpoint as a disclosure boundary and review the harness's own security model.
- **Agents run with your permissions.** Harnesses and shell sessions execute
  commands as your user. A task, harness, repository, or prompt can change files
  and run commands. Use worktrees, review changes, and do not run an agent
  against a repository you would not let an autonomous process modify.
- **Local state.** Projects, sessions, worktrees, tasks, and schedules live in
  local SQLite. Workbench has no telemetry and no hosted service. Session
  history, terminal scrollback, and worktree contents can contain anything the
  agent read or produced; protect the profile directory as you would any local
  source checkout.
- **Renderer isolation.** The renderer is sandboxed with context isolation and
  Node disabled. The preload exposes named operations only, and main validates
  every IPC payload with Zod and checks the calling frame. Only http(s) links
  can reach `shell.openExternal`.
- **WSL.** A WSL target runs the Host and harnesses inside the distro. The same
  permission and disclosure rules apply to processes running there.

Report vulnerabilities in third-party dependencies to their upstream projects;
also notify us if iCode Workbench's use of the dependency is affected.

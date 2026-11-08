# Changelog

All notable changes to iCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-11-08

### Added

- A global **Mira** assistant: one conversation across every project, opened
  from a person item in the app rail (`Projects · Schedules ┊ Mira ┊
  Settings`). She has an avatar, live status, unread badge and OS
  notifications.
- Mira uses the installed Claude Code, Codex or OpenCode harness in one-shot
  read-only mode. The harness returns a typed JSON envelope; the main process
  validates and executes every action, so the model has no project cwd, shell
  or control socket.
- Cross-project actions: inspect projects, tasks, sessions and diffs; create,
  cancel and retry tasks; message task sessions and project supervisors; record
  non-binding review recommendations; remember durable preferences.
- Low-risk auto-dispatch for Mira-created tasks, with per-project and global
  daily caps, protected keywords and paths, audit rows, and a visible off
  switch. Human approval still gates higher-risk work; review and merge remain
  human-only.
- Proactive notifications for approvals, failed or waiting tasks, review-ready
  work, completed Mira/supervisor tasks and failed first-commit setup, with
  deduplication, an hourly budget and quiet hours.
- Live Mira progress: the run stage, elapsed time, thinking-token count and a
  streaming reply draft are shown while the harness works. Claude uses
  `stream-json`; the final envelope is still validated before any action runs.
- Mira replies render as Markdown: headings, bold/italic, inline code, fenced
  code, lists, GFM tables, blockquotes, rules and http(s) links. The parser is
  dependency-free and renders React nodes, never HTML; it also parses
  incrementally while text streams.
- A Mira settings card for persona name, run target (local or a WSL distro),
  preferred harness, auto-dispatch, notifications and quiet mode; the project
  header now opens the global conversation with a project context instead of
  starting a separate supervisor session.
- Task history instead of a growing working list: the default Tasks view shows
  active/review-pending work, completed/cancelled work moves to History, and
  retry predecessors collapse into the latest attempt. Archive/Restore and
  “Archive all finished” keep the row, review, session and retry chain intact;
  reviewed completions and cancellations auto-archive after seven days.
- Mira can archive a finished task (reversible); deleting a task remains a
  human-only concept and is not exposed to her.
- SQLite migration v9: assistant threads, messages, runs, memory, settings and
  actions; task provenance columns (`created_by_actor`, `assistant_run_id`,
  `approval_policy`) and `tasks_session_idx`.
- SQLite migration v10: `tasks.archived_at` and its history index.

### Fixed

- Large Claude stream-json turns no longer lose their final `result` event to
  the old 1 MB stdout cap. The cap is now 16 MB, and the streaming parser keeps
  the result event as it arrives even if the accumulated stdout is truncated.
- A timed-out or stopped Mira turn now kills the whole harness process tree.
  Windows npm shims leave the agent as a grandchild; killing only `cmd.exe`
  kept its stdout pipes open and left “Mira is working…” well past the
  deadline. Harness failures also surface the CLI's own error text.
- Task retries now carry Mira provenance and the policy that approved the
  original attempt.
- Task-linked sessions no longer raise a second OS notification from the
  activity broadcaster; the assistant notifier owns that delivery.

## [0.5.0] - 2026-11-07

### Added

- A project-scoped **Supervisor** session: a normal agent session with a narrow
  local control CLI. It can inspect tasks, propose tasks (which wait for human
  approval), cancel or retry only the tasks it created, steer their sessions,
  and record non-binding review recommendations.
- Task proposals use a new approval gate: pending proposals are visible in the
  Projects/Tasks views and never reach the dispatcher until a person approves
  them. Rejection is recorded as `approval-rejected`.
- Supervisor review recommendations sit beside the existing human Accept/Reject
  decision and never set that decision themselves.

### Changed

- The Projects wall's Work column is now **In flight**: live direct sessions plus
  running and queued tasks, excluding waiting tasks and finished work.
- **Needs** now aggregates everything that requires a person — task Answer/Retry/
  Review, direct agents waiting for input, and setup failures — shown as a total
  counter with a tooltip breakdown. The "Needs you" section includes waiting
  sessions.
- **Updated** is now **Last active**, based on agent activity, task, and setup
  timestamps instead of summary refresh time.
- Wall sorting and filters follow the new needs and in-flight aggregates.
- The appearance preference now defaults to Light; System and Dark remain
  available.

### Fixed

- Supervisor bootstrap prompts now wait for the agent TUI, use bracketed paste
  with CR line breaks, and submit with a separate Enter; Claude activity is used
  to retry a lost submit.
- Clicking Supervisor now opens the newly created session instead of leaving the
  project on the Tasks view.
- Review recommendations refresh the task UI immediately.
- Selecting any part of a task row now switches the workbench; Approve, Reject,
  Cancel and Retry still own their own clicks.
- Windows named-pipe control requests now use newline framing, so the response
  is not lost when a client half-closes the connection.

## [0.3.0] - 2026-11-06

### Changed

- The project row's leading dot now reports agent activity only: Needs you,
  Working, Done, Done · failed, or Activity unknown. Setup state and task
  attention remain in the Work/Needs columns and row bars, and projects with no
  live sessions have no dot.

## [0.2.0] - 2026-11-06

### Added

- Manage repositories directly from the All projects wall: a primary **Add
  project** action and a per-row **Remove repository** action, still guarded by
  the removal confirmation and worktree checks.
- Project rows now open a shared actions menu from either the `⋯` button or a
  right-click, with Open project, Pin/Unpin, Copy path, Retry preparation (when
  setup failed), and Remove repository. `Shift+F10` opens it from the keyboard.
- Files: VS Code-style explorer with live editing and search.
- Files: trash, undo, hot exit, and a virtualized explorer.
- Source Control: focused session changes view and AI-generated commit messages.

### Changed

- Repository registration is part of the All projects wall rather than a separate
  Repositories surface.
- Project, Source Control, and Files menus now share one floating-surface
  treatment: translucent background with a solid fallback, 10 px radius, tonal
  hover, muted icons, and a 150 ms entrance animation.
- The wall's per-project actions menu is compact (192 px) and portal-based.

### Removed

- The dedicated Repositories destination, its router surface, and its command
  palette entry.

### Fixed

- Project action menus are no longer clipped or layered under the project table;
  they render above the app, clamp to the viewport, and flip when space is tight.

## [0.1.0] - 2026-11-06

Initial release: the next-gen agentic development environment (ADE).

### Added

**Terminal and sessions**

- Real PTY sessions in an xterm.js workspace with resize, scrollback,
  alternate-screen round-tripping, and per-client flow control.
- Detached terminal Host that owns PTY truth and survives app exit; relaunching
  reattaches to the same session incarnation.
- Idempotent create-or-attach, terminal snapshots, orphan reporting, and
  profile-scoped sockets with token authentication.
- Session lifecycle: create, attach, restart, sleep/wake, and remove, with
  persisted observations always reconciled against Host truth.
- Isolated session worktrees: one checkout and `icode/ses_<id>` branch per
  session, with guarded removal and discard rules plus explicit recovery for
  missing worktrees.

**Development surfaces**

- In-session Files browser with create, rename, delete, search, Monaco editing,
  and file history.
- Changes review for uncommitted work: Conflicts, Staged, Changes, and Untracked
  sections with area-scoped diffs, staging, unstaging, and separate discard.
- Full Source Control parity: commit and amend, branches, history, stashes,
  submodules, tags, worktrees, sync/pull/push/publish, and discard.
- Tasks with concurrency slots and a task workbench, plus recurring schedules
  across projects.
- Claude Code hook-derived agent activity (`working`/`waiting`/`idle`), turn
  ordering, unread state, OS notifications, and a cross-project attention view.
- Claude Code, Codex, OpenCode, and shell Harness support with tri-state
  availability detection and real `--version` probes.

**Platform and operations**

- Repository registration for existing Git checkouts and first-commit
  initialization of folders, with local and WSL execution targets.
- SQLite persistence with WAL, append-only migrations, foreign keys, and
  corruption refusal that preserves the original database file.
- Linux under WSL2/WSLg with a pinned Linux Host artifact tree, native Windows
  hosts with PowerShell/ConPTY and named pipes, and macOS x64/arm64.
- Command palette, quick open, global shortcuts, themes, status bar, settings,
  and the redesigned product shell.
- Packaged Linux (AppImage/deb/rpm), Windows x64 (NSIS), and macOS x64/arm64
  (dmg/zip) artifacts, with compatibility gates and packaged smokes. Packages are
  unsigned.

### Security

- Sandboxed renderer with context isolation and Node disabled, a typed preload
  exposing named operations only, and fixed IPC channels validated with Zod
  schemas.
- Host authentication with a 32-byte `0600` token, versioned hello, and
  constant-time comparison; the Host refuses filesystems that cannot enforce
  `0700/0600`.

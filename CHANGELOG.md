# Changelog

All notable changes to iCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

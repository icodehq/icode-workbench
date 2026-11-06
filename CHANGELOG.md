# Changelog

All notable changes to iCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Manage repositories directly from the All projects wall: a primary **Add
  project** action and a per-row **Remove repository** action, still guarded by
  the removal confirmation and worktree checks.
- Files: VS Code-style explorer with live editing and search.
- Files: trash, undo, hot exit, and a virtualized explorer.
- Source Control: focused session changes view and AI-generated commit messages.

### Changed

- Repository registration is part of the All projects wall rather than a separate
  Repositories surface.
- The wall's per-project actions menu is compact and portal-based.

### Removed

- The dedicated Repositories destination, its router surface, and its command
  palette entry.

### Fixed

- Project action menus are no longer clipped or layered under the project table;
  they render above the app, clamp to the viewport, and flip when space is tight.

## [0.1.0] - 2026-11-06

Initial release.

### Added

- Electron terminal workspace with a detached PTY Host that survives app exit and
  reattaches to the same session incarnation.
- SQLite persistence, durable session IDs, and per-session worktrees with isolated
  branches.
- File changes review, working-tree editing, and full Source Control parity
  (history, branches, stashes, submodules, tags, and worktrees).
- Claude Code, Codex, OpenCode, and shell Harness support, with Claude Code
  activity reporting.
- Tasks, schedules, cross-project attention, themes, and settings.
- WSL2/WSLg support with a pinned Linux Host artifact tree, plus native Windows
  PowerShell sessions.
- Packaged Linux (AppImage/deb/rpm), Windows x64 (NSIS), and macOS x64/arm64
  (dmg/zip) artifacts. Packages are unsigned.

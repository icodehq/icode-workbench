# Changelog

All notable changes to iCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Right-clicking the **Default checkout** row in the left sidebar now opens its
  actions — New session in the checkout, Copy path, Collapse/Expand — matching
  worktree rows. Both row types read one shared menu plan, so their actions
  cannot drift apart again.
- Worktree and Default checkout rows answer the keyboard Menu key (Shift+F10)
  as well as the pointer.

## [0.26.1] - 2026-11-24

### Fixed

- Right-clicking anywhere on a worktree row in the left sidebar opens
  **Worktree actions**. Previously only the branch label answered the
  right-click, so the add-session button and the row's padding did nothing.

### Changed

- Controls that answer a click show the hand cursor. Tailwind v4 leaves
  buttons on the default arrow, so the workbench sets the pointer in its base
  layer; disabled controls and drag handles keep their own cursors.

## [0.26.0] - 2026-11-24

### Fixed

- **A large monorepo no longer freezes the window when a session starts.** The
  Files and Source Control watchers skipped generated directories only when they
  sat at the checkout root, so a package-level `node_modules` was walked and
  watched file by file. On a 35,000-file checkout that meant 37,000 native
  watchers and a main process that stopped answering for minutes. Generated
  directories are now skipped at any depth; with the chokidar fallback that
  checkout needs about 500 watches instead of 37,000.
- **WSL checkouts are polled instead of watched through Windows.** A guest
  repository is owned by its distro, so translating its path and watching the
  Windows spelling could still descend into a large checkout from the main
  process. Files and Source Control now use their existing two-second polling
  fallback for every WSL target, and no watcher or native module is added to the
  guest artifacts.
- **Filesystem watchers run outside the Electron main process.** A dedicated
  watcher child now owns every physical watch. A crawl, a native watcher crash,
  or a failed subscription leaves Files and Source Control on their polling
  fallback and retries live mode a few times, instead of stalling the window.
  The watcher stops when the app does; it is never a detached process.
- **Local recursive watches use the operating system's native watcher.** The
  watcher child prefers `@parcel/watcher` (ReadDirectoryChangesW, FSEvents,
  inotify per directory) and prunes generated directories natively at any depth.
  A 35,000-file checkout no longer opens one handle per file; chokidar remains
  an automatic fallback when the native module cannot load.
- **The Files pane watches only visible directories.** It subscribes to the
  checkout root plus expanded folders and the parents of open tabs, and drops a
  folder's watch when it is collapsed. Windows and Linux use one shallow
  `fs.watch` per visible folder; macOS uses one recursive native subscription
  filtered to the visible set, avoiding descriptor pressure.

## [0.25.0] - 2026-11-23

> **Upgrading from 0.23.1 or 0.24.0:** those builds can be blocked by historical
> `unavailable` sessions. If the automatic update fails, remove the stale
> unavailable sessions or install this release manually once. The fix below
> applies to every later update.

### Added

- **Packaged update end-to-end check.** `pnpm smoke:update:win` installs an
  older build, serves the new installer through a local feed, and waits for the
  relaunched build to report its version. CI runs it on manual dispatch or with
  the `update-e2e` pull-request label.
- **Update diagnostics.** Auto-update logs now go to
  `userData/logs/update.log`, and a durable last-install journal lets the next
  launch report an interrupted install instead of silently reopening the old
  version.

### Fixed

- **Historical `unavailable` sessions no longer block updates.** Only a session
  whose own host cannot prove its state blocks an install; persisted tombstones
  no longer make `sleepLiveSessions` refuse every update. Unrelated host
  failures and the previous double-counted failure number are fixed at the same
  time. A live orphan is listed in the restart confirmation and stopped after
  the user consents.
- **The manual proxy now covers update downloads.** electron-updater uses its
  own net-session partition; the proxy runtime now applies the same policy to
  it, so a proxy configured only inside iCode no longer breaks downloads.
- **Update checks and downloads time out and can be cancelled.** A stalled feed
  request no longer leaves the app in `checking` forever, and a stalled download
  is aborted after two minutes without progress. The banner and Settings show a
  Cancel action while downloading.
- **Installer failures are surfaced.** The backend verifies that the downloaded
  installer exists before destroying windows, propagates electron-updater's
  synchronous install error, and records the attempt. Install errors show their
  session/process detail in the banner tooltip and Settings.
- **Concurrent install requests cannot run twice.** A double-clicked
  confirmation or a second window no longer schedules two teardowns from one
  ready state.
- **AppImage preflight checks the containing directory.** Replacing an AppImage
  needs directory write access, not only file write access.

### Changed

- **Prerelease tags publish as GitHub prereleases.** A `v*-beta.*` tag no longer
  becomes `latest` and breaks stable clients' update checks.
- **CI accepts signing secrets.** Windows and macOS packaging sign and verify
  artifacts when `WINDOWS_CSC_*`, `MACOS_CSC_*` and `APPLE_*` secrets are
  configured; unsigned development builds still work.
- Removed a state where the update detail was only visible in Settings; the
  banner tooltip now carries it. "Check now" is disabled while a downloaded
  update is ready instead of silently doing nothing.

## [0.24.0] - 2026-11-23

### Added

- **Resizable Projects and Tasks panes.** A horizontal seam divides the Projects
  list from the Tasks pane. Drag it to set the Tasks height, double-click to
  return to content-sized, and the committed height survives a relaunch. Tasks
  keeps at least 96px and Projects at least 140px; the stored preference is kept
  intact when the window shrinks. Collapsing Tasks makes the seam inert and
  preserves the last height for re-expansion.

### Changed

- **Project groups start collapsed.** Launching iCode shows the project list
  with every project group closed; expand a project with its chevron. Expansion
  is remembered while the window runs (including terminal focus mode) and resets
  on relaunch. The Projects section itself, the Default checkout and worktree
  group defaults, and the Tasks section behave as before.

## [0.23.1] - 2026-11-23

### Changed

- **WSL responsiveness.** Source Control, Files and checkout resolution no
  longer spawn one `wsl.exe` per guest request. A status refresh runs status and
  both numstat diffs in one guest script, simultaneous directory listings share
  one `find`, and checkout existence probes are cached for five seconds and
  single-flighted between Git and Files. Remote project availability is reused
  for ten seconds. The measured steady-state poll drops from about three
  spawns per second to under one; local targets are unchanged.

## [0.23.0] - 2026-11-23

### Added

- **In-app updates.** iCode checks the GitHub release feed shortly after launch
  and every six hours (disable it in **Settings → Updates**). Windows NSIS and
  packaged AppImage builds download on request and install after a restart.
  Unsigned macOS builds and deb/rpm installs link to the arch-matched download
  or release page instead. Restarting asks before ending live sessions, sleeps
  them first, and stops the detached terminal host and WSL holders so the
  installer can replace the app. The first build with this feature must still be
  installed manually once.

## [0.22.3] - 2026-11-23

### Fixed

- **Renderer busy-loop.** The removal-jobs subscription re-ran its load effect
  on every render because the shell's `onChanged` callback was recreated each
  time, so each state update scheduled another IPC read and pinned a CPU core.
  The hook now keeps its callbacks in latest-value refs, and the shell builds
  its refresh callback from stable members, so an idle window stops spinning
  and clicks no longer queue behind the loop.

## [0.22.2] - 2026-11-23

### Fixed

- **Private clone into a WSL project.** An authenticated clone no longer fails
  with "Invalid Git environment override." The one-attempt auth environment
  sets `SSH_ASKPASS` to suppress askpass prompts, but the guest Git executor
  admitted only `GIT_*` keys, so the credential preflight threw before
  `git ls-remote` ran. The guest allowlist now admits that exact key, and the
  streaming guest clone forwards it on both its direct and login-shell routes.

## [0.22.1] - 2026-11-23

### Fixed

- **Light appearance legibility.** Light-theme text is darker across the shell,
  source control, diffs and settings: primary ink is near-black, secondary and
  tertiary ink clear 7:1 and 5:1 on the panel, and the green/red status hues are
  deepened for text use. Filled danger and info buttons now pick their ink per
  appearance instead of assuming black. The terminal palette follows with a
  near-black default foreground and a 4.5:1 dynamic contrast floor, and the
  Monaco light theme uses the same ink.

## [0.22.0] - 2026-11-23

### Added

- **Authenticated clone.** Cloning a private repository now opens an in-dialog
  authentication step when Git reports an authentication failure. HTTPS
  credentials (username plus password or access token) are verified with
  `git ls-remote` before the clone and delivered through a one-attempt
  credential helper. The helper answers only the exact host and path, and its
  files are removed on success, failure, cancel or timeout. On WSL the handoff
  is a 0600 file plus a fixed helper script inside the distro. SSH is an equal
  entry point: check the key and agent, generate an ed25519 key with explicit
  consent, copy the public key, confirm and trust the host fingerprint, test
  access, then clone. After a successful HTTPS clone iCode offers to save the
  credential with the environment's existing helper, switch the origin to SSH,
  or opt in to the plaintext `store` helper with a warning. Background and
  agent Git operations still never prompt.

### Fixed

- WSL Git now carries the login shell's `SSH_AUTH_SOCK` into the direct spawn,
  so an agent started from the shell profile is visible to clone and fetch.
  The login-shell fallback also sets `GIT_TERMINAL_PROMPT=0` like the direct
  route instead of leaving the outcome to the profile.

## [0.21.0] - 2026-11-23

### Added

- **Copy Screen Content.** The terminal menu can copy the visible screen even
  when the program owns the selection, and terminal copy actions now report
  success or failure.

### Fixed

- **Terminal right-click with a program-owned selection.** A plain right-click
  now copies an existing terminal selection and otherwise opens the pane menu;
  Ctrl+right-click always opens the menu. In mouse-aware TUI programs such as
  Claude Code the right button is no longer forwarded to the program, so its
  own selection survives the menu. Alt+right-click still passes through.

## [0.20.0] - 2026-11-23

### Added

- **Sidebar drag reordering.** Projects, worktrees and sessions can be dragged
  to reorder the workspace sidebar. The order is stored in the app database, so
  it survives restarts; worktrees reorder within their project and sessions
  within their checkout group (the default checkout or a worktree).

## [0.19.2] - 2026-11-23

### Fixed

- **Session tab drag reordering.** Dragging a session tab now moves it to the
  target tab's slot. The drag source is tracked in a ref instead of React
  state, so `dragover` accepts the drop while the native drag loop is running;
  previously the drop never landed with real mouse input.

## [0.19.1] - 2026-11-22

### Fixed

- URL links in mouse-aware terminal programs, such as Claude Code, now open
  the link action popover on a plain click instead of doing nothing. The click
  is withheld from the program, and Ctrl/Cmd-click still opens the browser
  directly.

## [0.19.0] - 2026-11-22

### Added

- Terminal links. HTTP(S) URLs printed in terminal output are clickable, and a
  URL that soft-wraps across rows is detected as one link. A plain click opens a
  small action popover with **Open in Browser** and **Copy Link**;
  Cmd/Ctrl-click opens the browser directly. OSC 8 hyperlinks follow the same
  policy. Only http and https URLs can reach the OS browser, and a link click
  never overrides a text selection or a plain click in a mouse-aware TUI.

## [0.18.0] - 2026-11-22

### Added

- Terminal panes now provide a find bar, a pane context menu, platform-correct
  copy and paste shortcuts, copy-on-select with gutter trimming, OSC 52 TUI
  clipboard writes, and locally persisted terminal settings. Split, zoom, clear,
  reset, copy-context and close actions target the pane that opened the menu,
  not only the active session.

### Changed

- Upgraded xterm.js to the 6.1 beta family and added search and Unicode 11
  support. Live panes and read-only previews now share one terminal options
  builder.

## [0.17.3] - 2026-11-22

### Fixed

- OS notification clicks now land where the user can act: direct-session
  finishes and waits open the session terminal, task approvals open the task
  workbench, waiting and failed tasks open their terminal, review-ready tasks
  open Changes, and repo setup failures open the Mira card. Clicking a
  notification also restores a minimized window.

## [0.17.2] - 2026-11-22

### Changed

- A second readability pass on the workspace sidebar: project, session and task
  titles are 13px, worktree and default-checkout names 12px, state, branch,
  activity and task-status lines 11px, section headers 11px, and counts and
  badges 10px, with taller rows to match. The first pass in 0.17.1 still left
  secondary sidebar text hard to read.

## [0.17.1] - 2026-11-22

### Changed

- The workspace sidebar uses a readable type scale: session and task titles are
  12px, state, branch and activity lines are 10px, and section headers are 9px,
  with taller rows to match. Secondary sidebar text was previously as small as
  7.5px, and the footer status bar follows the same scale.

## [0.17.0] - 2026-11-21

### Added

- **Default checkout sessions.** Each project now shows an always-present
  **Default checkout** group — the repository's primary checkout, labelled with
  its live branch. Its **+** and the New Session dialog's **Run in** list start
  a terminal or agent in that folder without creating a worktree. Default-checkout
  sessions share the checkout with the user and each other, so agent sessions
  carry a persistent shared-checkout warning. Files, Search and Source Control
  work there, with Source Control showing repository-level changes that are not
  attributed to the session; review, annotate and merge remain worktree-only.
  Task, supervisor, Mira and CLI-created sessions still create isolated
  worktrees. No database migration is required: a default-checkout session is a
  session row without a worktree link. Legacy linkless sessions are presented in
  the same group and gain Files and repository-level Source Control.

## [0.16.0] - 2026-11-21

### Added

- Session rows and the session header now offer **Resume** for an exited or
  failed session whose harness conversation token was captured. Resume continues
  that conversation in a new process; **Restart** remains the explicit fresh
  start, and Resume never guesses a conversation when no token was recorded.

## [0.15.0] - 2026-11-21

### Added

- **New session** and task creation can start from a remote-tracking branch.
  The Start-from picker groups Local and Remote branches, refreshes the selected
  remote branch before creating the worktree, falls back to the last fetched ref
  when the refresh fails, and sets the branch upstream when its name matches the
  remote branch.

## [0.14.0] - 2026-11-21

### Added

- Session removal can delete the session's owned branch with its checkout.
  **Delete branch** is an explicit, default-off choice in the Remove dialog; the
  cleanup dialog still names uncommitted files and unmerged commits before one
  confirmation. Shared checkouts, active task chains and branches checked out in
  another worktree are refused before anything is deleted.

## [0.13.1] - 2026-11-21

### Changed

- The **New session** dialog lists only the Harnesses installed for the selected
  repository. Everything else folds behind **More agents**, and searching still
  reaches the full catalog.

## [0.13.0] - 2026-11-21

### Added

- App-wide network proxy settings under **Settings → Network** with System,
  Manual, and Off modes. Manual mode accepts separate HTTP and HTTPS proxy URLs
  plus a NO_PROXY list and applies them to provider tests, local Git, terminals,
  and WSL; System mode reuses the operating-system proxy and fills the
  non-Chromium environment where possible.
- WSL sessions and Git receive the proxy guest-side. Loopback proxies are
  rewritten to the Windows host gateway under WSL NAT, mirrored networking is
  left untouched, and a loopback-only proxy produces an actionable warning.
- POSIX GUI launches import proxy variables exported by the login shell.
- Provider tests and Git remote failures now distinguish proxy failures
  (`proxy_unreachable`, `proxy_auth_required`, `GIT_PROXY_FAILED`) from remote
  authentication or endpoint errors.

### Changed

- Local Git executors read the proxy environment for every command, so a
  settings change reaches clone, fetch, push, and session worktree operations
  without restarting the app.

### Fixed

- WSL guest commands without a configured proxy start synchronously again, so
  the guest-home probe cannot race the launcher.

### Notes

- Proxy authentication is not supported in this release; proxy URLs containing
  credentials are rejected.

## [0.12.0] - 2026-11-20

### Changed

- Add project registers a repository from the inspection's own resolution
  instead of running the same Git resolution twice, and runs the independent
  Git reads in parallel. The new project appears as soon as registration
  returns; the repository and session lists refresh in the background.
- WSL Add project resolves the repository in one guest script instead of a
  sequence of `wsl.exe` calls, and reuses a successful distro discovery for a
  few seconds.

## [0.11.0] - 2026-11-19

### Added

- Agent providers now use a shared recipe registry with 19 implemented
  endpoint recipes: Claude Code, Codex, OpenCode, OpenClaude, CodeBuddy,
  Kimi, ZCode, Qwen Code, Kilo, Continue, Pi, OMP, Ante, Copilot, Gemini,
  Aider, Goose, Grok and Mistral Vibe. A recipe becomes selectable in
  Settings only after its hands-on check against a local mock endpoint
  passes; the shipped list remains Claude Code, Codex and OpenCode until
  then.
- The provider settings card uses a harness picker with a recipe-aware form,
  protocol and documentation links, generated config-file previews, and
  protocol-family presets. API keys stay masked in the preview.
- Added a local provider verification harness: `pnpm verify:providers` runs
  the installed CLIs against a mock endpoint, and a support matrix records
  the verified CLI version for each recipe.

### Changed

- Provider harnesses are decoupled from the Mira, AI commit-message and
  supervisor model-harness set, so adding a provider cannot claim assistant
  behavior it does not support.
- Provider storage widened to the implemented recipe set (migration 20);
  existing provider rows and selections are preserved.
- Provider probes now run by protocol and cover Google GenAI endpoints.

### Fixed

- Agent-provider strings are translated in every supported language.

## [0.10.1] - 2026-11-19

### Changed

- Agent settings now live in one Agents & harnesses card with a single Agent
  status switch and one expandable list. The separate Harnesses, Agent status
  hooks and OpenCode cards are gone; “Show all 45 harnesses” reveals the full
  catalog.
- Managed status hooks now share one provider registry, one format-adapter map
  and one config-path default, removing four duplicate provider lists and five
  duplicated dispatch chains. On-disk hook and plugin layouts are unchanged.

### Fixed

- Harness counts in Settings and the sidebar use the detected catalog total
  instead of the stale placeholder of four.

## [0.10.0] - 2026-11-19

### Added

- iCode now exposes a 45-entry agent launch catalog alongside its terminal.
  The New Session picker has a primary/community split, alias-aware search,
  and per-harness launch arguments and required-command checks.
- Managed status hooks cover 21 agent CLIs, local and WSL: Gemini, Qwen Code,
  Cursor, Copilot, Grok, Kimi, Amp, Droid, OpenClaude, Qoder, Qoder China,
  CodeBuddy, Antigravity, Command Code, Devin, Muse, ZCode, Kiro, DeepSeek
  Harness, Jcode and Hermes. The default-on setting reports working, waiting
  and done without changing user-owned hooks, and the Settings card shows each
  provider's state and config path.
- OpenCode has a managed status plugin for 1.x and 2.x, with prompt/assistant
  previews, permission and question attention, and indented subagent rows.
- Sessions can report harness activity from managed plugins and terminal
  program/title evidence, and sleep/wake uses the expanded resume recipes.

### Changed

- Session harness IDs are validated by a seeded `harnesses` table (migration
  19). Provider injection and Mira remain deliberately limited to Claude,
  Codex and OpenCode.
- Workspace trust no longer falls through to Codex for unknown harnesses, and
  previews launch through the catalog's aliases and arguments.

### Fixed

- The OpenCode plugin reports an initial idle state when it loads, instead of
  leaving the session unknown.
- The WSL host build script strips CRLF so guest artifacts do not carry
  Windows line endings into shell execution.

## [0.9.17] - 2026-11-18

### Fixed

- A task-owned session stays out of its project's session list after the task is
  archived.
- The terminal's leftover viewport strip uses the terminal background, so the
  light theme no longer shows a black bar below the last rendered row.
- Mira's conversation selector formats its timestamp in the app language rather
  than the operating-system locale.

### Changed

- README screenshots are refreshed for the current workbench, with new figures
  for the session row menu and the warning-only removal dialog.
- The Files panel and workspace sidebar are split into focused controller hooks
  and view components. Session lifecycle actions share one typed plan and reach
  the surfaces as a single action bundle. No behavior change.

## [0.9.16] - 2026-11-17

### Changed

- Removing a session whose worktree has uncommitted changes or unmerged
  commits no longer requires typing the branch name. The cleanup dialog names
  the affected files or the retained branch, and one confirm completes the
  removal. The branch is still kept, and the standard removal dialog now says
  that uncommitted changes block removal instead of promising protection.

## [0.9.15] - 2026-11-17

### Added

- Session rows now offer Details, Sleep/Wake, Restart, and Remove in their
  right-click/Menu-key menu, alongside Pin. Lifecycle actions apply to the
  row's session without opening it, so a stuck, sleeping, or finished session
  can be restarted, put to sleep, inspected, or cleaned up from the sidebar.
  The session header menu and the row menu share one availability plan, and a
  row now shows its in-flight state while an action runs.

## [0.9.14] - 2026-11-17

### Added

- Session and task rows now answer a right-click, or the Menu key, with their
  own actions. Session rows offer Pin/Unpin. Task rows offer Retry, Continue,
  Cancel, Archive, Restore, and Pin as the task's state allows, so retrying a
  failed task or cleaning up a finished one no longer requires opening it
  first. Review decisions stay in the task view, where the proposal and diff
  are visible.

### Changed

- Pin/unpin is now only a menu action. The hover pin buttons on session and
  task rows, the unpin buttons in the Pinned section, and the accent pin
  marker on pinned project rows are gone, so a row click can no longer toggle
  pinning by accident.

## [0.9.13] - 2026-11-17

### Changed

- The project context menu no longer repeats view navigation. Clicking a
  project row opens its sessions and clicking a task row opens the Tasks view,
  so the menu keeps only actions the row click cannot perform.

## [0.9.12] - 2026-11-16

### Changed

- The project context menu is action-first: New session and Queue task lead,
  Sessions and Tasks are a checked pair that shows the open view, project
  actions follow, and Retry preparation moves to the top when a project needs
  attention. Session and task creation disable with a reason when the Host or
  first-commit preparation blocks them.
- Right-clicking anywhere on a project row opens its menu, including the
  chevron, branch chip, and trailing actions. The row stays highlighted while
  the menu is open, the ⋯ trigger reports its expanded state, and each menu is
  labelled with its project's name.
- Copy path confirms with a short success notice and reports clipboard
  failures instead of failing silently.

### Added

- Removing a project now asks for confirmation, showing the affected session
  and worktree counts and noting that uncommitted worktree changes are saved
  to a recovery ref first. The repository folder itself is not deleted.

## [0.9.11] - 2026-11-16

### Changed

- Panel resize bounds now match Termio's. The inspector's minimum is 240px and
  its default is 320px; its maximum is measured against the session surface,
  keeping 360px for the terminal. The Files and Changes list columns use
  180–460px with a 240px default, leave 260px for the detail, and switch to
  two columns at 600px.
- The Changes list divider double-clicks back to the default width, like the
  Files divider.

### Fixed

- The inspector's available-width measurement attaches when the session
  surface mounts, instead of only on first render, so its drag maximum is no
  longer computed from the whole window.

## [0.9.10] - 2026-11-16

### Changed

- Panel resizing is smooth across all five seams: workspace sidebar,
  inspector, Files list, Changes list, and split dividers. Live geometry is
  written straight to the DOM and React/persistence commits once on release,
  instead of re-rendering each panel's subtree on every pointer frame.
- Inspector panes re-measure once when a drag ends, so Files and Changes get
  one layout update rather than one per frame; the one/two-column switch now
  happens on release.
- Terminals follow a drag with a throttled refit and send the PTY a single
  settled resize on release, instead of resizing the shell throughout the
  drag.

### Added

- `pnpm perf:resize` drives all five seams with trusted CDP input and records
  frame-interval and long-task metrics in `artifacts/resize-perf/report.json`.

## [0.9.9] - 2026-11-16

### Changed

- The workspace sidebar is drag-resizable (240–400px) and remembered across
  launches; double-click the seam to reset it. At the narrowest widths the
  header drops the refresh verb so the brand and traffic lights keep their room.

## [0.9.8] - 2026-11-16

### Changed

- Search is its own inspector pane (and a Search tab in the task workbench),
  so the Files tree is only a tree. A result opens in Files, and a completed
  replace refreshes the tree and clean editor tabs.
- Changes is review-first: a one-line dock carries the staged/uncommitted
  counts and the primary action, and the commit composer expands only when
  asked. Merge banners and the dock stay visible while a diff is open.
- The Files tree column is drag-resizable (220–420px), both details have a close
  button, and Escape backs out of a detail (restoring a maximized one first).
- Each session remembers its inspector pane and open diff.

## [0.9.7] - 2026-11-16

### Changed

- The right inspector is now a master–detail surface, matching Termio's right
  panel. Files and Changes each get the full panel for their list, and an open
  file or diff takes the whole panel instead of sharing it with a 312px tree.
  The list is one toggle away; both columns return once the inspector is wider
  than 760px.
- The inspector width is drag-resizable (360–1000px) and remembered across
  launches; double-click the seam to reset it. Its old eyebrow and repo/branch
  header row is merged with the pane switch, and the detail can maximize to the
  window with Escape to restore.
- The Files tree header is one compact row with icon actions; rename, delete and
  duplicate appear only while something is selected.
- Changes opens on the changed-file list instead of auto-opening the first
  diff, so a diff never covers the list unbidden.

## [0.9.6] - 2026-11-16

### Changed

- Terminal colors now follow the app appearance. Light mode uses a palette
  drawn for the light canvas instead of inverting the dark one: ANSI white and
  bright white map to ink so agent output stays readable, every ANSI color
  clears 4.5:1, and light themes carry a contrast floor for colors programs set
  at runtime. Open terminals recolor in place when the appearance changes;
  dark mode keeps the existing afterglow palette.

## [0.9.5] - 2026-11-16

### Added

- Split view is now a nested tree. Sessions can split left, right, above or
  below the focused pane, and panes can combine both axes into any
  arrangement.
- Every divider resizes its own branch. Closing a session collapses its pane
  into the surviving sibling, and a tree that falls back to one pane returns
  to the single-pane view.
- Panes can be rearranged by dragging the grip in a pane header. Dropping on
  an edge re-splits the target on that side; dropping on its centre swaps the
  two panes.
- Split shortcuts: macOS uses `⌘D`, `⇧⌘D`, `⌥⌘` + arrows and `⇧⌘↩`; Windows
  and Linux use `Ctrl+Shift+D`, `Ctrl+Shift+Arrow`, `Ctrl+Alt+Arrow` and
  `Ctrl+Shift+Enter`. `⇧⌘W` / `Ctrl+Shift+W` closes the focused tab and
  collapses its pane, and the focused pane can also be zoomed from the tab
  strip.
- Split shortcuts start a sibling session with the focused harness in the same
  worktree, then place it beside the focused pane. The tab menu still places
  existing sessions.
- The command palette now lists split left/right/up/down, pane zoom and
  close-split actions for the active direct session.
- Split trees and divider ratios persist per project and are pruned against the
  live sessions when the app restarts.
- Projects can keep multiple independent split groups. Selecting a session
  reveals the group it belongs to; an ungrouped session opens as a single pane
  while the other groups stay saved.

### Changed

- A tab already shown in the split can move left, right, up or down of the
  focused pane instead of only to a fixed side; **Swap panes** exchanges it
  with the focused pane.

## [0.9.4] - 2026-11-15

### Added

- Split view can open in either direction. A session tab's menu now offers
  **Split left** and **Split right**, **Move to left pane** and **Move to right
  pane** while a split is open, and **Swap panes**.
- Selecting a session in either pane makes it the active session, so the tab
  strip, inspector and status strip agree with the pane you are using.

### Changed

- Selecting the session already shown in the right pane no longer reorders the
  panes. Pane order changes only through the explicit split actions, and
  **Close split view** is available from the same tab menu.

## [0.9.3] - 2026-11-15

### Fixed

- Switching between split panes, closing a split, or opening it again no
  longer re-attaches the terminal. Pane moves now keep the same xterm
  instance, buffer, scrollback and live status instead of briefly showing
  "Connecting" and replaying the host snapshot.

## [0.9.2] - 2026-11-15

### Added

- Worktree rows in the left sidebar can be collapsed. Their right-click menu
  offers New session, Copy path, Collapse/Expand, and Recover worktree when
  the checkout directory is missing.

### Fixed

- Selecting the session shown in the right split pane no longer collapses the
  split. The selected session becomes the left pane and the previous left
  session takes its place on the right, preserving the divider and size.

## [0.9.1] - 2026-11-15

### Added

- Several sessions — terminals and coding agents — can now run in one
  worktree. Start another from the worktree's add button in the sidebar, or
  choose **Run in** when creating a session. The sessions share one checkout
  and branch while keeping their own terminal, state, sleep and wake lifecycle.

### Changed

- Removing one of several sessions from a shared worktree detaches it without
  removing the checkout or disturbing the other sessions. Removing the last
  session still runs the existing dirty/unmerged cleanup flow.
- Source Control and Files now share one file watch per checkout, and merge
  actions are serialized per checkout so two sessions cannot mutate the same
  working tree at once.
- Existing sessions keep their worktree path, branch, baseline and branch
  ownership; the schema upgrade moves them to the shared model in place.

## [0.9.0] - 2026-11-14

### Changed

- The workbench now uses one persistent sidebar for projects, direct sessions
  and the cross-project task queue. Pinned projects, sessions and tasks are
  shortcuts and no longer hide the project tree.
- Direct sessions are organized as tabs with browser-style context menus and
  drag reordering, a resizable split view, and a persistent Changes/Files
  inspector. Focus mode leaves only the terminal.
- Mira, Settings and Schedules open as auxiliary tabs; task work opens as its
  own main surface rather than a page or app tab.
- The session status strip keeps branch, ahead/behind and blame context beside
  the terminal, while host, task slots and live counts stay in the sidebar
  footer.

### Removed

- Removed the primary activity rail, global top bar, project wall and global
  status bar.

### Fixed

- The session inspector gets more room at common window sizes, and split-pane
  headers keep the session title readable.

## [0.8.2] - 2026-11-12

### Fixed

- The Windows installer now recognizes a partial install by its Chromium
  resource files (`chrome_100_percent.pak` and `chrome_200_percent.pak`), so a
  cancelled first install whose executable is already gone is still cleaned
  up. This is the residue an interrupted install leaves when it stops after
  unpacking the framework assets.

## [0.8.1] - 2026-11-12

### Fixed

- The Windows installer now removes files left in the default per-user install
  directory by an interrupted install or by a previous install at another
  location; the uninstaller cleans the same orphaned directory. Only a
  directory that still carries iCode's own files is touched.
- Claude activity hooks no longer wait indefinitely when the ingress accepts
  a connection and then stalls; the hook exits after at most one second.
- Zero-byte connections to the activity ingress and the supervisor control
  plane are ignored instead of logged as errors. Windows named pipes are
  world-open, so security software and stray probes can open one and close it
  without sending a request; the shipped clients never do.
- Documented the `ELECTRON_RUN_AS_NODE` startup trap and the WAL caveat when
  checking `user_version` with an external tool.

## [0.8.0] - 2026-11-11

### Added

- New sessions and tasks can start from a chosen local branch and use an
  optional branch name. Session creation resolves the exact branch tip, and a
  duplicate or invalid name is refused before a worktree exists.
- Sessions and tasks can now **Merge…** into a target branch chosen at finish
  time. The session branch is updated from the target first, conflicts are
  resolved in the existing merge editor, and the target is fast-forwarded with
  a compare-and-swap. Merge records are durable, survive a restart, and expose
  Continue/Abort; accepting a task still does not merge it by itself.
- Dependency chains now share one chain branch. Each task keeps its own
  short-lived worktree, but a dependent starts only after every blocker has
  been merged into the chain branch; fan-in works when the blockers share the
  chain, and legacy chains retain their pre-merge behavior. SQLite migration
  v16 adds the chain fields and `merge_records`.
- **Push…** sends the session branch to an explicitly chosen remote and branch,
  setting upstream without merging. Push never satisfies a task dependency;
  only a local merge into the chain branch does.
- **Repository settings** (project menu → **Repository settings…**) lists the
  remotes Git stores for a checkout, recognizes GitHub and GitLab URLs, redacts
  embedded credentials, and offers Fetch, Edit, and Remove. **Push to…** now
  offers **Add remote…** and **Manage remotes…** when a repository has no
  remote. Git remains the source of truth; no remote is stored in SQLite.
- **Add project** can **Clone from URL** into a local or WSL target with
  streamed progress and cancellation. An interrupted or failed clone removes
  only the destination it created, a distinct fetch/push URL is shown
  read-only, and an empty remote continues through the existing unborn-repository
  setup so the first commit is still an explicit step.
- Clone, fetch, push, and pull authentication failures name the environment to
  fix (the system Git credential helper/SSH agent, or the selected WSL distro),
  and credential-bearing URLs are redacted from every Git error detail.
- **Instant project removal.** Removing a project unregisters it immediately
  and runs the remaining cleanup as a durable background job. The job stops
  sessions, aborts active merges, saves uncommitted worktree changes to
  recovery refs, removes iCode-created worktrees, retains branches, and deletes
  the project's tasks, schedules, supervisor bindings, and assistant audit
  rows. A status-bar cleanup indicator shows progress, retries failures, and
  offers Discard snapshots; the primary checkout and remote repository are
  never touched.

### Changed

- Merge and Push now live in Source Control. A contextual
  **Merge into `<target>`** primary action and anchored **Merge into branch…**
  / **Push to…** pickers replace the session/task header buttons and their full-screen
  modals. Push to… also absorbs the separate Push and Publish menu entries and
  defaults to the configured upstream, or origin plus the local branch when
  unpublished. Merge still requires a clean worktree.

### Fixed

- Opening a project now follows its contents: when a project has both direct
  sessions and tasks it opens Sessions, a task-only project opens Tasks, and a
  project with neither opens Sessions instead of an empty Tasks view.
- Terminal host startup failures, such as an unusable host directory, are
  reported as an unreachable host rather than an internal session error, so
  project cleanup waits and retries instead of failing.
- Continuing or aborting a merge from the Source Control operation banner now
  uses the merge service, so the target fast-forwards, the merge record lands
  in the correct state, and dependent tasks unblock.
- Stale conflicted merge records left by the old generic continue/abort path
  are reconciled at boot and can be aborted without a restart.

## [0.7.0] - 2026-11-10

### Added

- GitHub Releases now include the Linux, Windows, and macOS installers built by
  CI from the released tag. Pushing a `v*` tag publishes the release, and the
  workflow can be dispatched with an existing tag to backfill one.
- Mira now keeps a native harness conversation instead of replaying a
  truncated transcript. Claude, Codex and OpenCode are resumed by the
  harness's own session id; a changed harness or target starts a bridged
  conversation with a visible boundary, **New conversation** starts a clean
  one, and a failed resume falls back to reconstructed replay once. SQLite
  migration v11 adds `assistant_conversations`; retired rows keep the reason
  Mira started over.
- Mira's thread is now split into selectable conversation segments. The header
  chooses the current or an earlier conversation, each segment pages 50
  messages at a time with **Load earlier messages**, and **New conversation**
  starts a new visible segment. Proactive notifications are hidden from the
  transcript and stay in the notifications drawer, fed by a dedicated recent
  notifications query. A resumed turn's `## Since your last turn` digest now
  includes action results, failures and notifications, so write outcomes are
  not lost. SQLite migration v12 adds segment ranges (`start_seq`/`end_seq`);
  pre-v12 conversation rows are shown as one legacy segment.
- Failed or cancelled tasks can now be **continued** in their existing
  session and worktree: the same harness conversation where the harness
  supports resume, and the same uncommitted changes. **Retry** still starts a
  fresh attempt in a new worktree. SQLite migration v13 records each attempt's
  mode (`fresh` or `resume`).
- Tasks can now depend on one or more other tasks. A dependent starts only
  after every blocker reaches `completed`, a blocker can hold its dependents
  until its result is accepted, and the task detail shows blockers and
  dependents with a read-only chain graph tab. Dependencies can be changed
  while the dependent is queued and follow the newest attempt on retry or
  continue. SQLite migration v14 adds `task_dependencies`, the
  `hold_dependents` gate and a per-project concurrency limit. An edge orders
  starts; it does not transfer uncommitted work between worktrees.
- Full app-chrome localization for English, Simplified Chinese, Japanese,
  Korean, Spanish, Brazilian Portuguese, German and French: renderer UI,
  native menus, dialogs, folder pickers, OS notifications and user-facing
  application errors. A Language card in Settings offers System or a pinned
  language and applies changes without restarting. English is authoritative
  and the fallback; the other catalogs are AI-assisted and marked for native
  review in `src/shared/i18n/README.md`. Terminal, harness, Git and model output
  and user content are never translated. Persisted task, schedule and assistant
  text keeps the language it was written in.

- Agent providers: configure an API provider per harness (Claude Code, Codex,
  OpenCode) in **Settings → Agent providers**. iCode injects the endpoint, key,
  and model into the launched session's environment instead of writing the
  tool's global config, so plugins, hooks, and user settings stay untouched.
  Includes curated presets, encrypted key storage via Electron `safeStorage`,
  a real **Test connection** request, and a Settings preview of the exact
  launch inputs. SQLite migration v14 adds `providers` and
  `harness_provider_selection`; terminal-host protocol v2 adds per-session
  environment so Codex and OpenCode receive credentials without exposing them
  in argv or on disk.

### Changed

- Task admission is now bounded per project: by default at most one task per
  project runs at a time, in addition to the global limit. Raising the global
  limit lets different projects run in parallel; raising **Tasks per project**
  in Settings also lets one project run several. The lower of the two limits
  applies.
- The installer, executable and desktop icons now use the transparent green
  brand mark from the README instead of the retired black tile.
- Codex runs for Mira no longer use `--ephemeral` when resume is available, so
  the harness persists a resumable thread. Mira conversations now live in each
  harness's default state directory (`~/.claude`, `~/.codex`, OpenCode's data
  directory).
- iCode Workbench is now licensed under the GNU Affero General Public License
  v3.0 only (AGPL-3.0-only). A modified version made available to users over a
  network must offer them the corresponding source under section 13.
- Starting a new session no longer blocks on the whole WSL pipeline. The New
  Session dialog closes immediately and shows a pending surface while the main
  process works; the create path now caches the guest home and Harness
  discovery, batches the workspace/repository read and the worktree
  create+verify into one guest script each, prewarms the WSL host/relay, and
  reuses the create-time checkout proof on the first attach. On a warm WSL
  repository this cuts session creation from roughly 34 `wsl.exe` spawns to
  about 5; the first attach still verifies that the checkout exists.

### Fixed

- File watchers canonicalize their roots before subscribing, so a Windows 8.3
  short path cannot trip a libuv assertion and crash the process. The watcher
  integration test now closes chokidar before deleting its temp tree.
- Host tests wait longer for slow CI runners instead of a fixed three-second
  frame budget, and the scrollback test waits for xterm to drain rather than
  sleeping for a fixed 400 ms.
- A WSL shell session no longer reports its worktree as inconsistent after
  reconciliation. The desktop host runs `wsl.exe` from a Windows pty directory
  because a ConPTY cannot start in a Linux path; that cwd was being compared
  with the guest worktree, which blocked the terminal. The cwd comparison is
  now local-only, and guest checkouts keep the distro-side Git inspection.
- **Detect again** in the New Session dialog now re-detects the selected
  repository's execution target, including a WSL distro, instead of this
  machine.
- The Sessions workspace keeps its viewport height when the pending-session
  surface is visible, so the Files tree virtualizes instead of mounting every
  row.

### Security

- Updated the transitive `dompurify` dependency used by Monaco to 3.4.17,
  fixing the advisory inherited through `monaco-editor@0.57.0`.

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

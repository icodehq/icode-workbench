# Changelog

All notable changes to iCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

## [0.8.0] - 2026-11-10

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

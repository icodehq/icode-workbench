# ADE

An agent development environment for local Coding Agent TUIs.

**Status:** Works 1-5 complete — scaffold, domain contracts, SQLite persistence,
the detached terminal host, and main-process orchestration with a typed preload
API. The product UI (terminal workspace) is Work 6.

## Stack

- Electron 43.7.8 (Node 24.21.0, ABI 148)
- TypeScript 5.9.3, electron-vite 6, React 19, Tailwind 4
- `node:sqlite` for durable state (Work 3)
- `node-pty` + xterm.js for real terminal sessions
- pnpm 11.16.0 via Corepack, Node 24.15.x

## Architecture (Work 1 slice)

```
src/main      Electron main: window, compatibility gates, host supervisor/client
src/host      Detached terminal host (PTY owner, NDJSON protocol, token auth)
src/preload   Frozen typed bridge; contextIsolation on, Node off, sandbox on
src/renderer  Minimal Work 1 runtime surface
src/shared    Domain model, Zod boundary contracts, host protocol/framing
scripts       Native rebuild and executable compatibility gates
```

Ownership:

- **Main** owns configuration, IPC validation, host supervision. It does not
  interpret terminal bytes.
- **Host** owns PTYs, output sequencing, exit truth. It survives ADE exit while
  alive. It is launched through `ELECTRON_RUN_AS_NODE=1` so `node-pty` loads the
  Electron-ABI native module.
- **Renderer** owns presentation only and has no Node or raw IPC access.
- Durable session IDs are allocated by ADE; PTY incarnation IDs are allocated per
  spawn by the host. Work 1 already tags every data/exit event with both.

### Local endpoint

The host socket prefers `$XDG_RUNTIME_DIR/ade/<profile-scope>/terminal-host.sock`
(a digest of the profile directory), with `ADE_HOST_SOCKET` as an explicit
override and `ADE_HOST_DIR` for token/meta/log files. Scoping keeps two ADE
profiles that share one runtime directory from colliding, so one instance can
never unlink another's endpoint. This matters on WSL: `/mnt/d` (DrvFs) cannot
bind Unix sockets and does not honor `0600`. The default `userData` path is on a
Linux filesystem; the gates use `/tmp/ade-work1/host` for runtime state while
keeping evidence in the repo.

Authentication uses a 32-byte token in a `0600` file, a versioned hello, and
timing-safe comparison. Frames are NDJSON with a 4 MiB limit.

## Domain model and contracts

`src/shared/domain` holds pure vocabulary and invariants:

- Durable IDs (`repo_*`, `ws_*`, `ses_*`) versus host-owned PTY incarnation IDs.
- Primary-checkout repositories and workspaces.
- Session lifecycle (host truth: starting/live/exited/failed; reconciled UI state adds unavailable).
- Persisted observations are historical; `reconcileSessionState` requires host
  confirmation before claiming liveness or accepting input.
- Harness detection is tri-state: available, unavailable (verified inability),
  or detection_failed (retryable ambiguity). Incompatibility is recognized from
  generic install diagnostics, not hardcoded per-harness facts.
- Stable `AppError` codes with retryability derived from the code.

`src/shared/schemas` validates IPC and domain payloads; `host-protocol.ts`
derives wire types from Zod schemas and `host-framing.ts` rejects malformed,
oversized, unknown, and identity-colliding frames. Wire IDs stay opaque so the
host never depends on ADE's durable ID formats.

## Terminal host (Work 4)

The detached host (`src/host`) owns PTYs and terminal state. It has no database,
repository, renderer, or Electron-app imports.

| Module | Responsibility |
|---|---|
| `paths.ts` | socket/token/meta locations, effective-permission verification, safe stale-socket handling |
| `pty-registry.ts` | session registry, incarnation rotation, idempotent create-or-attach, exit truth, eviction, backpressure |
| `terminal-emulator.ts` | `@xterm/headless` state, 5,000-line scrollback, serialized snapshots |
| `client-connection.ts` | NDJSON framing, per-client bounded queue, lag notices |
| `protocol-server.ts` | hello/auth/version, validated requests, fan-out, idle shutdown |
| `server.ts` | composition and process lifecycle |

### Identity and lifecycle

- `createOrAttach` is idempotent by durable session ID: live sessions attach;
  exited sessions restart with a **new incarnation**; `attachOnly` never spawns
  and returns the final snapshot of an exited session.
- `write` and `resize` require the live incarnation; a stale ID returns
  `STALE_INCARNATION` and cannot touch the restarted PTY.
- PTY exit is authoritative. A failed spawn throws `SPAWN_FAILED` and registers
  nothing; a missing binary that node-pty starts and the OS then fails surfaces
  as a `failed` session with its exit code, never a phantom live row.
- Killing one session never touches another. Finished sessions are retained (up
  to 64) so their final screen remains attachable; the oldest finished session is
  evicted when the registry is full.

### Snapshots and alternate screen

Each session runs a headless xterm fed by PTY output, independent of clients.
Attach waits for that terminal to drain, then returns a serialized snapshot with
dimensions, cursor, sequence, alternate-screen flag, retained scrollback, and a
`truncated` flag when history was lost.

The serialize addon emits the `?1049h/l` transitions, so alternate-screen
content and screen type round-trip in this xterm version (covered by emulator and
real-PTY tests). A static snapshot is the last painted state; a TUI that repaints
on attach is still expected to refresh itself. Snapshot bytes are capped at
3 MiB, reducing serialized history before dimensions.

### Flow control

PTY output feeds the emulator first, so a slow client never blocks the process.
If the emulator's parse backlog exceeds 1 MiB, the PTY is paused and resumed
below 256 KiB. Per-client output queues are capped at 1 MiB; excess **data**
events are dropped and the client receives one `lagged` event with a sequence
range. Responses are never dropped. A client that sees a gap or `lagged` notice
re-attaches to obtain a fresh snapshot.

### Endpoint and permissions

Socket: `ADE_HOST_SOCKET`, else `$XDG_RUNTIME_DIR/ade/<profile-scope>/terminal-host.sock`,
else the host directory. Token: 32 random bytes in a `0600` file; hello uses a
versioned handshake and constant-time comparison. The host verifies effective
directory and token modes and refuses to start if the filesystem cannot enforce
`0700/0600` (this is why DrvFs paths are unsupported). A non-socket at the
socket path is never deleted; a stale socket is removed only when the recorded
owner is dead and the socket actively refuses connections.

`shutdownIfIdle` refuses while any PTY is live or another client is connected.
`shutdown` remains available for the compatibility gates. Closing an ADE window
never stops the host.

## Application services (Work 5)

`src/main/app/runtime.ts` is the main-process composition root: it opens
persistence, starts the session service and host gateway, authenticates to or
starts the terminal host, and reconciles stored sessions against it. A host
failure is non-fatal and leaves the app able to list repositories and retry.

- **Ownership.** SQLite holds durable metadata; the host owns PTY truth. Startup
  reconciliation queries the host and persists observations; a persisted `live`
  is never treated as proof. Host query failure yields `unavailable`
  (`authority: 'unreachable'`), never `exited`.
- **Sessions.** `SessionService` implements create, attach, write, resize, stop,
  restart, list, get, and event streaming. Create persists `starting` before
  spawning and records `failed` with the structured error if spawn fails.
  Attach is always `attachOnly`, so it can never create a duplicate PTY.
  Restart kills a live PTY, waits for confirmed termination, then creates a new
  incarnation and rejects a response that attached instead of spawning.
- **Incarnations.** Writes and resizes require the session's recorded
  incarnation; a stale ID is rejected in main before reaching the host. Host
  events with a different incarnation are dropped. A requested stop is host
  truth (`stopRequested`/`requested`), so a SIGHUP exit (129) is `exited`, while
  an unrequested nonzero exit remains `failed`.
- **Orphans.** A live host PTY with no durable row is reported as an orphan in
  the session list, not silently adopted or hidden.
- **Repository removal.** `RepositoryRemovalService` asks the host before
  deleting: live affected PTYs block removal; an unreachable host blocks
  removal (`host_unavailable`); terminal/unknown sessions require explicit
  acknowledgement; only then does Work 3 cascade the rows. Unknown repository
  IDs are `INVALID_ARGUMENT`.
- **Harness detection.** `HarnessDetector` resolves commands on PATH without a
  shell (absolute paths only from trusted inputs such as `$SHELL`), runs a real
  bounded `--version` probe, and classifies via the Work 2 tri-state model.
  `harness.list()` re-resolves and re-probes every call, so retry is real.
  `findExecutable` rejects separators in registry names; the renderer can never
  supply a command.
- **IPC/preload.** Main registers only the fixed channel table, validates each
  payload with Work 2 schemas, checks the calling frame, and maps failures to
  stable `AppError`s. The preload factory (`src/preload/api.ts`) exposes named
  operations only; subscriptions are reference-counted, dispose individually,
  and remove the underlying channel listener when the last listener leaves.
  `zod` is bundled into the sandboxed preload rather than required at runtime.

## Persistence (Work 3)

`app.getPath('userData')/ade.sqlite` is owned by the Electron main process via
`node:sqlite`. The single writer opens lazily (`getAppPersistence`) and closes on
`before-quit` (`closeAppPersistence`).

- WAL, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`, verified on open.
- `PRAGMA user_version` migrations, append-only; each migration runs in its own
  transaction so a failure leaves the prior version intact.
- Four tables: `repos`, `workspaces`, `sessions`, `ui_state`. One
  `primary-checkout` workspace per repository (`UNIQUE(repo_id)`), canonical
  repo paths unique, sessions cascade from workspaces, workspaces from repos.
- Session rows store observations only. `reconcileSessionState` must confirm
  liveness with the host; a persisted `live` is never authoritative.
- Repository validation lives in `src/main/repositories/repository-path.ts`
  (existence, directory, `git rev-parse --show-toplevel`, `realpath`). The
  service never accepts an unvalidated path.
- Missing paths are refreshed on list and remain registered with
  `availability: 'missing'` so the UI can offer Locate/Remove.
- Deletion is a narrow persistence contract: `describeDeletion` reports stored
  sessions as historical observations and sets `requiresHostLivenessCheck`.
  `removeRepository` refuses to cascade unless the caller acknowledges
  dependent sessions. Work 5 must check host liveness before calling it.

### Corruption safety

`openDatabase` refuses a zero-byte file, checks the SQLite magic header before
SQLite opens the file, runs `PRAGMA integrity_check` read-only and again on the
writable handle before any migration. On failure it throws `DB_CORRUPT` with the
path and recovery guidance and never deletes, renames, overwrites, or recreates
the file. Byte-for-byte preservation is covered by tests for non-SQLite,
truncated, and zero-byte files.

## Commands

```bash
pnpm install          # also rebuilds node-pty for Electron ABI 148
pnpm typecheck
pnpm test             # Vitest domain/contract tests
pnpm build
pnpm dev
pnpm gate:sqlite
pnpm gate:pty
pnpm gate:host:start
pnpm gate:host:verify
pnpm gate:reattach
pnpm gate:host:stop   # cleanup after evidence
pnpm package:dir
pnpm gate:packaged
```

Evidence is written to `artifacts/work1/` (ignored by Git).

## Work 1 gate results

See `artifacts/work1/*.json`. The five required checks are:

1. SQLite transaction/rollback/WAL in Electron main.
2. Real `node-pty` shell under Electron-as-Node, ABI 148, echo + exit 7.
3. Host and original PTY alive after the Electron app exits.
4. Fresh Electron app reattaches with the same session, incarnation, and PTY;
   no duplicate process.
5. Packaged directory app runs from `/tmp` and exercises SQLite, native PTY, and
   the unpacked host.

## Reference and attribution

[Orca](https://github.com/stablyai/orca) is the architectural reference:
detached terminal ownership, create-or-attach, token handshake, incarnation
scoping, and headless snapshot strategy. No Orca UI components or daemon code
were copied; see `NOTICE` for the MIT attribution. SSH, remote execution,
checkpoints, telemetry, worktrees, and task orchestration are deliberately
excluded.

## Session worktrees (Work 12)

Every new session in a registered Git repository runs in its own checkout:

- **Location:** `<userData>/worktrees/<repoId>/<sessionId>` on the Linux
  filesystem (never beside a DrvFs repository).
- **Branch:** `ade/ses_<sessionId>`, created at the commit that was HEAD when
  the session started. The baseline OID is stored per session.
- **Ownership:** branch records outlive session rows. ADE only deletes a branch
  it created, and only with the exact name typed by the user.
- **Legacy sessions:** sessions created before this feature have no worktree
  record and keep using the repository's primary checkout, including restart.
  ADE never silently moves them into a worktree.
- **Missing worktrees:** presented as a distinct state with a "re-create from
  branch" action. ADE never falls back to the primary checkout, and never
  deletes a missing or unverifiable worktree.

Removal rules (all re-checked at the moment of the action):

| Situation | Result |
|---|---|
| Live/starting PTY | Blocked |
| Host unreachable | Blocked; everything preserved |
| Uncommitted changes | Blocked; files listed |
| Unmerged commits | Blocked; commit count shown |
| Missing / unregistered worktree | Blocked; explicit recovery only |
| Clean and merged | Worktree removed, **branch retained** |

Discard is a separate destructive action: it requires typing the exact branch
name, removes the checkout (uncommitted files are lost), and still keeps the
branch. Branch deletion is a separate action; unmerged branches also require the
exact name.

Session creation is refused for a repository with no commit (`UNBORN_REPOSITORY`)
or with a merge/rebase/cherry-pick/revert/bisect in progress
(`GIT_OPERATION_IN_PROGRESS`), because no trustworthy baseline exists.

```
pnpm smoke:worktree   # packaged acceptance: two sessions, isolation, relaunch, discard
```

## Reviewing uncommitted changes (Work 13)

Each isolated session has a **Changes** view alongside **Terminal**. It opens
directly on the uncommitted working tree; there is no separate session-review
scope.

- **Sections:** Conflicts, Staged Changes, Changes and Untracked Files. A
  partially staged file appears in both Staged and Changes with its own diff.
- **Actions:** `+ Stage` / `− Unstage` move a row between sections; Discard is
  separate and discards the working-tree side. Ignored files are not shown.
- **Diffs are area-scoped:** staged compares HEAD to the index, Changes compares
  the index to the worktree, untracked compares an empty file to the file. The
  diff header names its scope.
- **Read-only reads:** ADE only runs `git diff`, `status`, `ls-files`,
  `cat-file` and `rev-parse`, with `GIT_OPTIONAL_LOCKS=0`, `--no-ext-diff` and
  `--no-textconv`. Reviewing never writes the index and never starts a process in
  the worktree.
- **Missing or unregistered worktrees** show an explanation; ADE never falls
  back to the primary checkout.
- **Symlinks** are shown as their Git entry (mode `120000`), meaning the link
  target text. ADE never reads the target file.
- **Caching:** diff bodies are kept by area/path and Git snapshot, with
  stale-while-revalidate and in-flight dedupe. A refresh does not blank an
  unchanged body.
- **Refresh** happens when you open the view, when you press Refresh, and when
  the session's lifecycle state changes. There is no polling or file watcher.
- **Limits:** 2 MiB of captured Git output per file and only the first 1,500 diff
  lines are mounted; ADE never presents a truncated diff as complete.

```
pnpm smoke:features   # packaged acceptance: Changes, stage, commit, amend
```

## Agent activity and attention (Work 14)

The session sidebar and header answer a question the lifecycle cannot: **what is
the agent doing?** Activity is `unknown`, `idle`, `working` or `waiting`, and it
is deliberately independent of `SessionLifecycleState`:

- A live session can be `waiting`; an exited session is always `unknown`.
- Only Claude Code reports activity. Other Harnesses stay `unknown`, which means
  "no trustworthy evidence", not "idle".
- Activity never changes process state, exit handling, PTY ownership or the
  reconciliation result. It is advisory metadata on the session summary.

### Hook-derived, never terminal-text inference

ADE writes its own Hook script and a Claude `--settings` overlay under
`$XDG_CONFIG_HOME/ade/agent-hooks/`. Claude merges that file with the user's
settings, so **existing user Hooks keep running**. ADE never reads or writes
`~/.claude/settings.json`.

The script drains Claude's Hook payload from stdin, forwards one bounded JSON
object over a Unix socket, writes nothing to stdout, and exits `0` within a
100 ms deadline even when ADE is down. A broken ADE must never block the agent.
In a packaged build the script runs through Electron-as-Node; turn-end Hooks are
detached because Claude terminates that process as it exits.

| Hook | Activity |
| --- | --- |
| `SessionStart` | `idle` |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse*` | `working` (tool name shown) |
| `PermissionRequest` | `waiting`, unread |
| `PreToolUse` of `AskUserQuestion` / `ExitPlanMode` | `waiting`, unread |
| `Stop` / `StopFailure` | `idle` with `completed` / `failed` |

`Notification` is intentionally not used: its interactive behaviour was not
verified, so ADE relies on the events above.

### Ordering, unread and notifications

- Events from a previous PTY incarnation are rejected.
- An event older than the newest accepted event (by more than 250 ms) is
  rejected, so a delayed `Stop` cannot end a newer turn. A `Stop` whose prompt
  id is not the current turn is rejected too.
- Duplicate deliveries are idempotent: one transition, one notification.
- The selected session's unread marker clears only while the window has focus.
- OS notifications are raised once per logical transition into `done` or
  `waiting`, and only while no ADE window is focused. Clicking one reveals the
  session.

Activity is in memory only: after an app relaunch every session is `unknown`
rather than showing a stale `working`. The sidebar shows `Working · <tool>`,
`Needs you` or `Done`/`Done · failed`; the header chip shows the same state and
`Activity unknown` when no evidence exists.

```
pnpm smoke:activity   # packaged acceptance: Hook overlay, real Claude, ordering, unread
```

## Packaged Linux application (WSL2 + WSLg)

Work 9 verified the packaged Linux x64 application end to end. The GUI is an X11
window on WSLg's display, so it appears on the Windows desktop while the Electron
main process, the detached terminal Host, and every PTY run inside WSL2 Ubuntu.

### Build

```bash
pnpm install
pnpm build          # typecheck + electron-vite + detached Host bundle
pnpm package:dir    # electron-builder --dir -> dist/linux-unpacked
```

`dist/linux-unpacked/ade` is the application; it needs no repository checkout at
runtime. `resources/app.asar.unpacked/` holds the Host bundle and the Electron-ABI
`node-pty`, both required because the Host runs via `ELECTRON_RUN_AS_NODE`.

**Packaging on DrvFs.** `electron-builder` scans pnpm's module tree while
packaging. On a `/mnt/d` checkout that scan did not complete in 20+ minutes;
the same source tree packages in about one minute on ext4. If `pnpm package:dir`
stalls after `searching for node modules`, stage the checkout on a Linux
filesystem (for example `~/src/icode`) or package there and point the gate at the
result:

```bash
ADE_GATE_PACKAGED_DIR=/path/to/dist/linux-unpacked pnpm gate:packaged
```

`scripts/compat/packaged-smoke.cjs` verifies the packaged binary from `/tmp`:
WAL SQLite, the bundled native PTY, and the unpacked Host starting a real session.

### Launch and data locations

```bash
./dist/linux-unpacked/ade
```

Packaged runs use the normal Electron user-data path, not test overrides:

- Profile: `$XDG_CONFIG_HOME/ade` (defaults to `~/.config/ade`)
- Database: `<profile>/ade.sqlite`
- Host runtime directory: `<profile>/run` (mode `0700`)
- Host socket: `$XDG_RUNTIME_DIR/ade/<profile-scope>/terminal-host.sock` when
  set, otherwise `<profile>/run/terminal-host.sock`. The scope is a 12-hex-digit
  SHA-256 digest of the profile directory.

Quitting the window leaves the detached Host and its PTYs alive; relaunching
reattaches to the same session incarnation.

### Isolated packaged acceptance

```bash
export XDG_CONFIG_HOME=/tmp/ade-work9/profile
export XDG_RUNTIME_DIR=/tmp/ade-work9/runtime   # chmod 700
./dist/linux-unpacked/ade
```

This keeps repositories and sessions out of your normal profile. To clean up,
stop each test session in the UI, quit ADE, then verify the run's Host has exited
(`<profile>/ade/run/meta.json` records its PID) and delete only the temporary
XDG directories. Never delete `~/.config/ade` unless you intend to remove your
real ADE data.

The packaged acceptance harness is the Work 7 Claude harness in packaged mode:

```bash
ADE_SMOKE_TARGET=packaged \
ADE_SMOKE_EXECUTABLE=$PWD/dist/linux-unpacked/ade \
ADE_SMOKE_ARTIFACTS=$PWD/artifacts/work9 \
node scripts/compat/claude-tui-smoke.cjs
```

It checks the visible WSLg window, default first-run profile, real Claude Code
TUI interaction, quit/relaunch with the same incarnation and one PTY spawn,
stop, and cleanup. `node scripts/compat/wslg-window-probe.cjs --match ADE`
prints the mapped windows on the WSLg display without any X11 utilities.

Only Linux x64 with WSLg has been verified. Native Windows, macOS, other Linux
distributions/architectures, code signing, and auto-updates are not supported by
this build.

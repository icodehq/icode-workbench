# File-watching architecture

iCode never opens a filesystem watcher in the Electron main process. A
dedicated, non-detached child process owns every physical watch; main owns
session state, debounce/coalescing, revisions, and the renderer payload.

The design follows Orca and Termio's split: the UI process is never the thing
that crawls a tree, native recursive watching is preferred over per-file
handles, WSL is polled on the owning side, and the Files surface only watches
what it can display.

## Renderer ownership

The center tab work moved the editor out of the inspector, and the worktree tab
surface made tabs and buffers worktree-scoped. The main process's
one-subscription-per-session contract is mirrored by one host per active
workspace in the renderer:

- `WorktreeFilesWatchHost` (one per active worktree surface) is the only caller
  of `window.icode.files.watch` for direct sessions. The inspector tree
  registers its expanded folders and visibility through
  `files/session-watch-registry.ts`; open file tabs contribute their parent
  folders. The host runs while the tree is visible **or** any file tab is open,
  so an editor keeps reconciling while the inspector shows Search/Changes or is
  collapsed.
- Tabs, buffers and the tree position use the workspace key. The subscription
  still needs an owner session for IPC; when the owner changes the host stops
  the old subscription and subscribes the new owner. A generation guard keeps
  stale watcher events from reconciling the new owner's view.
- The host owns root updates, the polling fallback, retries, and file-tab
  reconciliation. The tree only reloads its expanded folders when the host calls
  back; no second renderer consumer may call `files.watch`.
- Source Control keeps its single controller in the Changes pane. Center diff
  tabs read that controller through `scm/controller-registry.ts` for hunk and
  conflict actions, but poll their own patch while visible; they never start a
  second status/watcher loop. A hidden Changes pane still stops the SCM watcher,
  and a visible diff keeps working through its own polling fallback.
- `TaskWorkbench` keeps its own `ChangesPanel`/Files composition; it is a
  different surface and never shares the direct worktree registries.

## Process model

- `src/watch/index.ts` — the child. Build with `pnpm build:watcher`; it is
  launched as `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, `detached:
  false`, and stdio pipes. It exits when stdin closes, on `bye`, or after two
  minutes without a parent frame.
- `src/main/watch/watcher-supervisor.ts` — spawn, NDJSON framing, request
  timeouts, heartbeat, restart fuse, idle shutdown, and a bounded stderr log at
  `userData/logs/watcher.log`.
- `src/main/watch/watch-client.ts` — the injection seam used by the two
  services; tests inject a fake.

The terminal Host is deliberately **not** reused: its protocol v2 has an
external consumer, and a native watcher teardown crash must not take agent PTYs
with it.

## Wire protocol

`src/shared/watch-protocol.ts`, version 1, one JSON object per line (1 MiB
frame cap, 512-event batch cap). Commands: `sub`, `roots`, `unsub`, `ping`,
`bye`. Events: `hello`, `ok`, `ready`, `ev`, `ovf`, `err`, `werr`, `stat`,
`pong`. Malformed frames are ignored; an oversized frame kills the child (the
restart fuse decides whether polling is used instead).

The child registers a subscription *before* the backend binds so an initial
event or `ready` cannot be lost while the ack is in flight. The services create
their per-session state before calling `subscribe` for the same reason.

## Backends

- **Recursive (Source Control):** `@parcel/watcher` (ReadDirectoryChangesW on
  Windows, FSEvents on macOS, inotify per directory on Linux). Two native
  subscriptions per target: the worktree with `.git` pruned, and the Git
  directory with `objects`/`logs`/`lfs` and lock/tmp files pruned. Ignore
  patterns are **regex sources** passed as `ignoreGlobs` (the 2.5.6 wrapper
  compiles them; globs are only accepted by the `ignore` option). Chokidar is
  the automatic fallback when the native module cannot load.
- **Files on Windows/Linux:** one shallow `fs.watch` per visible directory
  (checkout root + expanded folders + parents of open tabs). Roots are
  refcounted across sessions, retried if missing, and rebound when a directory
  identity changes.
- **Files on macOS:** one recursive native subscription, filtered in the child
  to events whose parent directory is visible. This avoids the GUI descriptor
  budget while keeping the delivery set screen-sized.

## WSL

For every WSL target both watch-target resolvers return `null` before any
`wslpath` or guest `rev-parse`. Files and Source Control use their existing
two-second polling fallbacks. No watcher bundle or native module is shipped in
the WSL guest artifacts; `verify-package` rejects one that contains
`@parcel/watcher`.

## Failure and recovery

- A failed subscription emits `failed` on the existing renderer event; both
  panes poll and retry live mode at 5 s / 20 s / 60 s (three attempts) while
  the pane stays open.
- A child crash fails every subscription and rejects pending requests. The next
  watch request spawns a replacement; more than five starts in a minute opens
  the fuse and leaves the panes polling until restart.
- Overflow (`ovf`) and `ready` both force one full reconcile in the renderer.

## Diagnostics

- `ICODE_WATCH_CHILD=0` disables the child entirely (polling only).
- `ICODE_WATCH_BACKEND=chokidar` forces the fallback backend.
- `ICODE_WATCH_PERF=1` exposes `globalThis.__icodeWatchStats()` on the main
  process for the inspector.
- `pnpm perf:watch` launches an isolated app on a synthetic monorepo and writes
  `artifacts/watch-perf/report.json`: main event-loop delay, visible-root
  count, child watch count, the Source Control subscription count, and a
  kill-the-child poll fallback check. It is a manual probe, like `perf:resize`;
  the acceptance logic for ignores, shallow roots, and backends runs in the
  normal test suite on Linux, Windows, and macOS.

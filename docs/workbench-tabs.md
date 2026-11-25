# Workbench tabs

The center is one ordered tab list per **worktree** (or the repository's
default checkout). Agent sessions, raw terminals, files and diffs share that
list. The right inspector follows the same worktree, so every session in it
sees the same open files, buffers, review drafts and Source Control state.

`TaskWorkbench` is the exception: a task owns a session-scoped Files/Changes
composition and does not share the direct worktree tab list.

## Identity

```ts
// workspace/workspace-key.ts
sessionGroupKey(repoId, worktreePath) // worktree:<path> | default:<repoId>
workspaceKeyForSession(session)       // direct sessions
sessionTabKey(sessionId)              // session:<id>
fileTabKey(path)                      // file:<path>
diffTabKey(request)                   // diff:<area>:<path> | diff:committed:<oid>:<path>
```

A tab list and its split layout are stored under the workspace key. A direct
session's buffers live there even when another session in the same worktree is
focused. Task sessions keep their session id as the scope.

IPC, watchers, Source Control and file writes still need one concrete session:
the **owner**. `workspace/workspace-owner.ts` resolves it as the active session
in the workspace first, then any other session there. Owner changes resubscribe
the watcher and SCM controller; they do not change the tab list or buffers.

## Kinds

```ts
type CenterTab = FileTab | DiffTab | SessionTab
type SessionTab = { kind: 'session'; key: `session:${string}`; sessionId: string }
```

Agent sessions and raw terminals are both session tabs; the harness decides how
the tab is labelled. Session tabs are persisted by session id, not by tab key.

## Closing

- Closing a **running session tab** asks first: the X kills the agent or
  terminal process, then closes the tab. The worktree, branch and open editor
  buffers stay. Agent sessions keep a stopped row in the sidebar; raw terminals
  exist only as tabs.
- Closing an **already stopped/failed session tab** closes it immediately.
- Closing a **file or diff tab** closes it. A dirty file asks to save, discard
  or cancel through the pane that owns its editor.
- **Close all** closes files and diffs only; sessions stay in the list.
- Removing a session explicitly removes its tab and hidden marker.

## Sidebar

The sidebar is organized by **project → workspace**, not by session:

- The default checkout and each worktree are selectable workspace rows showing
  the branch. Selecting one opens that workspace's tab list.
- Raw terminals never get a sidebar row; they are tabs.
- Agent sessions (non-shell harnesses) get compact status rows under their
  workspace, including stopped agents. Clicking a row opens that agent's tab.
- Session commands live on the session tab's context menu: details, sleep,
  wake, restart, resume and remove. Shell terminals therefore need no sidebar
  row to be managed.
- The workspace row still offers New agent/New terminal and the checkout
  actions; the tab bar's `+` acts on the active workspace.

This mirrors Orca: the sidebar chooses a workspace, while the center tab list is
the actual set of terminals, agents, files and diffs.

## Preview and pin

- A single click opens an **italic preview**. The next single click replaces the
  focused pane's clean preview.
- Double-clicking, typing, saving, or a hunk/conflict action pins the tab.
- Hot-exit restores file tabs as permanent; preview state is never restored.
- Diff tabs are transient and never persisted.

## Split panes

`state/workspace-split.ts` owns one persisted tree per workspace
(`icode.workspace-split.v2.<workspaceKey>`). A leaf is
`{ paneId, activeTabKey }`; `focusedPaneId` selects the pane that receives new
tabs. A tab is displayed in at most one pane: activating a displayed tab focuses
that pane, otherwise it replaces the focused pane's tab.

Splitting creates an **empty pane** whose picker lists undisplayed tabs plus
New agent/New terminal. Closing a pane's last tab collapses that pane in a split
and shows the picker in a single pane. Zoom is transient.

Panes may show a session, a file, a diff, or the picker. Every direct session
that is not displayed in a pane stays mounted in a hidden host, including
sessions in other worktrees, so its PTY attachment and xterm state survive
switching.

## Persistence and ownership

- `files/open-files.ts` is the single tab store: order, active key, preview
  flags, buffers, hidden session ids and dirty buffers. Hot-exit v2 keeps direct
  buffers under workspace keys; v1 session-scoped payloads are migrated once
  after sessions load.
- The explorer position (`icode.files.tree.v1.<scope>`), file clipboard,
  Monaco model cache, file index cache and review drafts use the workspace key
  for direct sessions and the session id for tasks.
- `WorktreeFilesWatchHost` is the one files-watch owner for the active
  workspace. `TaskWorkbench` keeps its own composition.
- The SCM controller is registered per owner session; diff tabs consume it
  through `scm/controller-registry.ts` and key notes/commit messages by the
  workspace draft key.
- The app-close guard resolves each dirty scope to a live owner session before
  saving.

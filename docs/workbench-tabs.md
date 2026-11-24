# Workbench tabs

The session center is the one ordered tab list for reading and editing. This
note fixes the interface the Orca workspace-tabs work builds on; the current
implementation is session-scoped, and the workspace layer lifts the scope
without introducing a second order.

## Kinds and scope

```ts
type WorkspaceTabKind = 'file' | 'diff' // later: | 'agent-session' | 'terminal'
type WorkspaceTab = {
  key: string        // file: path; diff: `diff:<area>:<path>` / `diff:committed:<baseOid>:<path>`
  kind: WorkspaceTabKind
  preview: boolean
  sessionId: string  // IPC owner today; resolved per workspace later
}
```

`src/renderer/src/workspace/workspace-tabs.ts` owns `scopeKeyForSession` (today
`session.id`) and `workspaceKeyForSession` (`sessionGroupKey(repoId,
worktree.path)`, the final key). One list, one `activeKey`, one mode per scope.
File and diff tabs are implemented in `files/open-files.ts`; the workspace
session adds agent-session/terminal kinds to the same list.

## Preview and pin

- A single click opens an **italic preview** tab. The next single click replaces
  the current preview when it has no unsaved text.
- Double-clicking a file row or tab, typing, saving, or a hunk/conflict action
  pins the tab.
- Hot-exit restores file tabs as permanent; preview state is never restored.
- Diff tabs are projections of the working tree or a committed range. They are
  transient (never persisted) and follow the same preview/pin rules.

## Center surface

`SessionCenterTabs` renders `[Terminal]` plus the open tabs. The terminal stays
mounted and hidden while an editor is showing, so the PTY and scrollback
survive; the editor buffer lives in the open-files store, so switching back
never drops unsaved text. The Files and Changes inspectors are list-only;
clicking a file or change routes to the center through `SessionsSurface`.

## Persistence and ownership

File buffers, order, mode and preview flags live in `open-files.ts`; the
IndexedDB hot-exit payload stores file tabs only. Diff tabs are not persisted.
The Files watcher has one owner per session (`SessionFilesWatchHost`); the SCM
controller has one owner per session (the Changes pane) and diff tabs consume it
through a registry. See `docs/watch-architecture.md`.

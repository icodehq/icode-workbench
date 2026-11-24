import type { SessionSummary } from '../../../shared/schemas/ipc'
import { workspaceKeyForSession } from './workspace-key'

export { workspaceKeyForSession }

/**
 * The shared center-tab interface.
 *
 * This plan implements `file` and `diff` kinds. The Orca workspace-tabs work
 * adds `agent-session` and `terminal` to the same ordered list; it must not
 * introduce a second navigation order. See docs/workbench-tabs.md.
 */
export type WorkspaceTabKind = 'file' | 'diff'

export type WorkspaceTab = {
  /** File: path. Diff: scope/area + path (or base + path). */
  key: string
  kind: WorkspaceTabKind
  /** A single click opens a preview; the next single click replaces it. */
  preview: boolean
  /** IPC owner today; resolved per workspace once the scope is lifted. */
  sessionId: string
}

/**
 * The scope the tab list is keyed by today. The workspace-tabs session changes
 * this to `workspaceKeyForSession`, lifting the one order to a worktree.
 */
export function scopeKeyForSession(session: Pick<SessionSummary, 'id'>): string {
  return session.id
}

/** A preview tab is only replaceable while nothing in it would be lost. */
export function isPreviewReplaceable(tab: WorkspaceTab, dirty: boolean): boolean {
  return tab.preview && !dirty
}

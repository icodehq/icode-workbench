import type { SessionSummary } from '../../../shared/schemas/ipc'
import { orderByStoredIds } from '../lib/row-order'

/**
 * Workspace identity and tab identity.
 *
 * A workspace is one checkout: a git worktree, or the repository's primary
 * default checkout. The key is stable across branch changes because a worktree
 * is identified by its path and the default checkout by its repository.
 */

/**
 * Checkout groups are keyed by the checkout they belong to, not by a session:
 * the default checkout is stable per repository, and a worktree is stable by
 * path even when its branch changes.
 */
export function sessionGroupKey(repoId: string, worktreePath: string | null): string {
  return worktreePath === null ? defaultWorkspaceKey(repoId) : worktreeWorkspaceKey(worktreePath)
}

export function defaultWorkspaceKey(repoId: string): string {
  return `default:${repoId}`
}

export function worktreeWorkspaceKey(worktreePath: string): string {
  return `worktree:${worktreePath}`
}

/** The workspace a session runs in: its worktree, or the repository default checkout. */
export function workspaceKeyForSession(
  session: Pick<SessionSummary, 'repoId' | 'worktree'>
): string {
  return sessionGroupKey(session.repoId, session.worktree?.path ?? null)
}

export const SESSION_TAB_PREFIX = 'session:'
export const FILE_TAB_PREFIX = 'file:'
export const DIFF_TAB_PREFIX = 'diff:'

export function sessionTabKey(sessionId: string): string {
  return `${SESSION_TAB_PREFIX}${sessionId}`
}

export function fileTabKey(path: string): string {
  return `${FILE_TAB_PREFIX}${path}`
}

export function isSessionTabKey(key: string): boolean {
  return key.startsWith(SESSION_TAB_PREFIX)
}

export function isFileTabKey(key: string): boolean {
  return key.startsWith(FILE_TAB_PREFIX)
}

export function sessionIdFromTabKey(key: string): string | null {
  return isSessionTabKey(key) && key.length > SESSION_TAB_PREFIX.length
    ? key.slice(SESSION_TAB_PREFIX.length)
    : null
}

export function filePathFromTabKey(key: string): string | null {
  return isFileTabKey(key) && key.length > FILE_TAB_PREFIX.length
    ? key.slice(FILE_TAB_PREFIX.length)
    : null
}

export type ParsedTabKey =
  | { kind: 'session'; key: string; sessionId: string }
  | { kind: 'file'; key: string; path: string }
  | { kind: 'diff'; key: string }

/** Parses the namespaced keys used by the worktree tab list. */
export function parseTabKey(key: string): ParsedTabKey | null {
  const sessionId = sessionIdFromTabKey(key)
  if (sessionId !== null) return { kind: 'session', key, sessionId }
  const path = filePathFromTabKey(key)
  if (path !== null) return { kind: 'file', key, path }
  if (key.startsWith(DIFF_TAB_PREFIX) && key.length > DIFF_TAB_PREFIX.length) {
    return { kind: 'diff', key }
  }
  return null
}

/** Reconciles a remembered tab order against the tab keys that currently exist. */
export function orderTabKeys(
  available: readonly string[],
  stored: readonly string[]
): string[] {
  return orderByStoredIds(available, stored, (key) => key)
}

/**
 * Moves a dragged tab into the target's slot: dropping onto a tab to the right
 * inserts after it, dropping onto a tab to the left inserts before it.
 */
export function moveTabKey(
  ids: readonly string[],
  sourceId: string,
  targetId: string
): string[] {
  const from = ids.indexOf(sourceId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return [...ids]
  const next = ids.filter((id) => id !== sourceId)
  const targetIndex = next.indexOf(targetId)
  next.splice(from < to ? targetIndex + 1 : targetIndex, 0, sourceId)
  return next
}

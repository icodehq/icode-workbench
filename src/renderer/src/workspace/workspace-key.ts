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

export const GROUP_WORKSPACE_PREFIX = 'group:'
export const BOT_WORKSPACE_PREFIX = 'bot:'
export const ROOM_TAB_PREFIX = 'room:'
export const CHAT_TAB_PREFIX = 'chat:'
export const SESSION_TAB_PREFIX = 'session:'
export const FILE_TAB_PREFIX = 'file:'
export const DIFF_TAB_PREFIX = 'diff:'

/** A bot group's own center workspace; its tabs are that group's rooms. */
export function groupWorkspaceKey(groupId: string): string {
  return `${GROUP_WORKSPACE_PREFIX}${groupId}`
}

export function groupIdFromWorkspaceKey(key: string): string | null {
  return key.startsWith(GROUP_WORKSPACE_PREFIX) && key.length > GROUP_WORKSPACE_PREFIX.length
    ? key.slice(GROUP_WORKSPACE_PREFIX.length)
    : null
}

/**
 * One room of a group: the original room when `isDefault`, otherwise a thread.
 * The group id and thread id are app-generated ids, so the first colon is the
 * separator and the rest belongs to the thread id.
 */
export function roomTabKey(
  groupId: string,
  threadId: string | null,
  isDefault: boolean
): string {
  return isDefault || threadId === null
    ? `${ROOM_TAB_PREFIX}${groupId}`
    : `${ROOM_TAB_PREFIX}${groupId}:${threadId}`
}

export type RoomTabParts = {
  key: string
  groupId: string
  threadId: string | null
}

export function roomTabParts(key: string): RoomTabParts | null {
  if (!key.startsWith(ROOM_TAB_PREFIX)) return null
  const rest = key.slice(ROOM_TAB_PREFIX.length)
  if (rest.length === 0) return null
  const separator = rest.indexOf(':')
  if (separator === -1) return { key, groupId: rest, threadId: null }
  const groupId = rest.slice(0, separator)
  const threadId = rest.slice(separator + 1)
  if (groupId.length === 0 || threadId.length === 0) return null
  return { key, groupId, threadId }
}

/** A bot's own center workspace; its tabs are the Home chat and side chats. */
export function botWorkspaceKey(botId: string): string {
  return `${BOT_WORKSPACE_PREFIX}${botId}`
}

export function botIdFromWorkspaceKey(key: string): string | null {
  return key.startsWith(BOT_WORKSPACE_PREFIX) && key.length > BOT_WORKSPACE_PREFIX.length
    ? key.slice(BOT_WORKSPACE_PREFIX.length)
    : null
}

/** One assistant thread of a bot's home workspace. */
export function chatTabKey(botId: string, threadId: string): string {
  return `${CHAT_TAB_PREFIX}${botId}:${threadId}`
}

export type ChatTabParts = {
  key: string
  botId: string
  threadId: string
}

export function chatTabParts(key: string): ChatTabParts | null {
  if (!key.startsWith(CHAT_TAB_PREFIX)) return null
  const rest = key.slice(CHAT_TAB_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0 || separator === rest.length - 1) return null
  return {
    key,
    botId: rest.slice(0, separator),
    threadId: rest.slice(separator + 1)
  }
}

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
  | { kind: 'room'; key: string; groupId: string; threadId: string | null }
  | { kind: 'chat'; key: string; botId: string; threadId: string }

/** Parses the namespaced keys used by the worktree tab list. */
export function parseTabKey(key: string): ParsedTabKey | null {
  const sessionId = sessionIdFromTabKey(key)
  if (sessionId !== null) return { kind: 'session', key, sessionId }
  const path = filePathFromTabKey(key)
  if (path !== null) return { kind: 'file', key, path }
  if (key.startsWith(DIFF_TAB_PREFIX) && key.length > DIFF_TAB_PREFIX.length) {
    return { kind: 'diff', key }
  }
  const room = roomTabParts(key)
  if (room !== null) {
    return { kind: 'room', key, groupId: room.groupId, threadId: room.threadId }
  }
  const chat = chatTabParts(key)
  if (chat !== null) {
    return { kind: 'chat', key, botId: chat.botId, threadId: chat.threadId }
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

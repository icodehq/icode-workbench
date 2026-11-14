import {
  PINNED_PROJECTS_KEY,
  readPinnedProjectIds,
  type StorageLike,
  writePinnedProjectIds
} from '../projects-wall-model'

export const PINNED_SESSIONS_KEY = 'icode.pinnedSessionIds'
export const PINNED_TASKS_KEY = 'icode.pinnedTaskIds'

export type SidebarPins = {
  projects: string[]
  sessions: string[]
  tasks: string[]
}

function storageOrNull(storage?: StorageLike): StorageLike | null {
  if (storage !== undefined) return storage
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

function readIds(key: string, storage?: StorageLike): string[] {
  const target = storageOrNull(storage)
  if (target === null) return []
  try {
    const raw = target.getItem(key)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))]
  } catch {
    return []
  }
}

function writeIds(ids: readonly string[], key: string, storage?: StorageLike): void {
  const target = storageOrNull(storage)
  if (target === null) return
  try {
    target.setItem(key, JSON.stringify([...new Set(ids)]))
  } catch {
    // A disabled storage backend must not block the sidebar.
  }
}

export function readSidebarPins(storage?: StorageLike): SidebarPins {
  return {
    projects: readPinnedProjectIds(storage),
    sessions: readIds(PINNED_SESSIONS_KEY, storage),
    tasks: readIds(PINNED_TASKS_KEY, storage)
  }
}

export function writeSidebarPins(pins: SidebarPins, storage?: StorageLike): void {
  writePinnedProjectIds(pins.projects, storage)
  writeIds(pins.sessions, PINNED_SESSIONS_KEY, storage)
  writeIds(pins.tasks, PINNED_TASKS_KEY, storage)
}

export function readPinnedSessionIds(storage?: StorageLike): string[] {
  return readIds(PINNED_SESSIONS_KEY, storage)
}

export function readPinnedTaskIds(storage?: StorageLike): string[] {
  return readIds(PINNED_TASKS_KEY, storage)
}

export function writePinnedTaskIds(ids: readonly string[], storage?: StorageLike): void {
  writeIds(ids, PINNED_TASKS_KEY, storage)
}

export function writePinnedSessionIds(ids: readonly string[], storage?: StorageLike): void {
  writeIds(ids, PINNED_SESSIONS_KEY, storage)
}

export function togglePin(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id]
}

/**
 * Drops pins whose repo/session no longer exists, preserving order. Project
 * pins use the existing `icode.pinnedProjectIds` key so the wall and sidebar
 * stay compatible during the migration.
 */
export function pruneSidebarPins(
  pins: SidebarPins,
  repoIds: readonly string[],
  sessionIds: readonly string[],
  taskIds: readonly string[]
): SidebarPins {
  const repos = new Set(repoIds)
  const sessions = new Set(sessionIds)
  const tasks = new Set(taskIds)
  return {
    projects: pins.projects.filter((id) => repos.has(id)),
    sessions: pins.sessions.filter((id) => sessions.has(id)),
    tasks: pins.tasks.filter((id) => tasks.has(id))
  }
}

export { PINNED_PROJECTS_KEY }

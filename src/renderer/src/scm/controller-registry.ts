import { useSyncExternalStore } from 'react'
import type { WorkingTreeEntry } from '../review/working-tree'
import type { ScmController } from './use-scm-controller'

/**
 * The Changes pane owns the one SCM controller for a session. Center diff tabs
 * are consumers: they read the latest controller for notes, hunk actions and
 * conflict resolution, but never create a second status/watcher loop.
 *
 * The slot is intentionally not a React store: diff tabs re-render on their own
 * diff polling and the Changes pane's controller object is fresh every render.
 * Mutations look the controller up at call time, so they always act on the
 * current status chain.
 */
const controllers = new Map<string, ScmController>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setScmController(sessionId: string, controller: ScmController): void {
  controllers.set(sessionId, controller)
  emit()
}

export function clearScmController(sessionId: string, controller?: ScmController): void {
  if (controller !== undefined && controllers.get(sessionId) !== controller) return
  if (!controllers.delete(sessionId)) return
  emit()
}

/** Re-renders a diff tab whenever the session's controller publishes fresh data. */
export function useScmControllerVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0)
}

export function getScmController(sessionId: string): ScmController | null {
  return controllers.get(sessionId) ?? null
}

/** A working-tree entry as the controller currently sees it, or null. */
export function findScmEntry(
  sessionId: string,
  area: 'conflicts' | 'staged' | 'unstaged' | 'untracked',
  path: string
): WorkingTreeEntry | null {
  const controller = getScmController(sessionId)
  if (controller === null) return null
  return controller.groups[area].find((entry) => entry.entry.path === path) ?? null
}

/**
 * The same path in another area. After a hunk moves between the index and the
 * worktree the original row disappears; the diff tab follows the remaining
 * change instead of dead-ending on the old area.
 */
export function findScmEntryByPath(
  sessionId: string,
  path: string,
  excludeArea?: 'conflicts' | 'staged' | 'unstaged' | 'untracked'
): WorkingTreeEntry | null {
  const controller = getScmController(sessionId)
  if (controller === null) return null
  const order = ['staged', 'unstaged', 'untracked', 'conflicts'] as const
  for (const area of order) {
    if (area === excludeArea) continue
    const found = controller.groups[area].find((entry) => entry.entry.path === path)
    if (found !== undefined) return found
  }
  return null
}

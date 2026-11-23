import { useSyncExternalStore } from 'react'

/**
 * Expanded project groups in the workspace sidebar.
 *
 * Empty means every project is collapsed, which is the launch default. The set
 * lives outside React so it survives the sidebar's focus-mode unmount; a
 * renderer reload (app relaunch) recreates it empty. Expansion is deliberately
 * not persisted.
 */
let expanded: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getExpandedProjectIds(): ReadonlySet<string> {
  return expanded
}

export function subscribeSidebarExpansion(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useExpandedProjectIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeSidebarExpansion, getExpandedProjectIds)
}

export function setProjectExpanded(repoId: string, open: boolean): void {
  if (expanded.has(repoId) === open) return
  const next = new Set(expanded)
  if (open) next.add(repoId)
  else next.delete(repoId)
  expanded = next
  emit()
}

export function toggleProjectExpanded(repoId: string): void {
  setProjectExpanded(repoId, !expanded.has(repoId))
}

/** Test hook: restore the launch default. */
export function resetSidebarExpansion(): void {
  if (expanded.size === 0) return
  expanded = new Set()
  emit()
}

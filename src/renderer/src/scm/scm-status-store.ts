import { useSyncExternalStore } from 'react'
import type { GitOperationKind } from '../../../shared/domain/git-workspace'

/** The active session's Source Control summary, derived by its controller. */
export type ScmStatusSummary = {
  sessionId: string
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  conflicts: number
  staged: number
  changed: number
  untracked: number
  operation: GitOperationKind | null
}

let current: ScmStatusSummary | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function setScmStatusSummary(next: ScmStatusSummary | null): void {
  if (current === next) return
  if (current !== null && next !== null && JSON.stringify(current) === JSON.stringify(next)) return
  current = next
  emit()
}

export function clearScmStatusSummary(sessionId: string): void {
  if (current?.sessionId !== sessionId) return
  current = null
  emit()
}

export function getScmStatusSummary(): ScmStatusSummary | null {
  return current
}

export function subscribeScmStatusSummary(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useScmStatusSummary(): ScmStatusSummary | null {
  return useSyncExternalStore(subscribeScmStatusSummary, getScmStatusSummary, () => null)
}

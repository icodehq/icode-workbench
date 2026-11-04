import { useSyncExternalStore } from 'react'

/** The caret-line blame currently shown by the active editor. */
export type EditorBlameStatus = {
  path: string
  line: number
  oid: string
  author: string
  authorTime: number
  summary: string
  committed: boolean
}

let current: EditorBlameStatus | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function setEditorBlameStatus(next: EditorBlameStatus | null): void {
  if (current === next) return
  if (current !== null && next !== null && JSON.stringify(current) === JSON.stringify(next)) return
  current = next
  emit()
}

export function clearEditorBlameStatus(): void {
  if (current === null) return
  current = null
  emit()
}

export function getEditorBlameStatus(): EditorBlameStatus | null {
  return current
}

export function subscribeEditorBlameStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useEditorBlameStatus(): EditorBlameStatus | null {
  return useSyncExternalStore(subscribeEditorBlameStatus, getEditorBlameStatus, () => null)
}

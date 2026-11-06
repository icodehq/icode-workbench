import { useCallback, useSyncExternalStore } from 'react'

/**
 * In-app file clipboard, scoped to one session's worktree.
 *
 * The operating-system clipboard is only used for Copy Path; moving or copying
 * files across app sessions is deliberately out of Phase B.
 */

export type FilesClipboard = {
  sessionId: string
  paths: string[]
  mode: 'copy' | 'cut'
}

class FilesClipboardStore {
  private state: FilesClipboard | null = null
  private readonly listeners = new Set<() => void>()

  get(): FilesClipboard | null {
    return this.state
  }

  set(next: FilesClipboard | null): void {
    const same =
      this.state === next ||
      (this.state !== null &&
        next !== null &&
        this.state.sessionId === next.sessionId &&
        this.state.mode === next.mode &&
        this.state.paths.length === next.paths.length &&
        this.state.paths.every((path, index) => path === next.paths[index]))
    if (same) return
    this.state = next
    this.emit()
  }

  clear(): void {
    this.set(null)
  }

  /** A removed session must not leave a paste target that can never resolve. */
  clearSession(sessionId: string): void {
    if (this.state?.sessionId === sessionId) this.clear()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const filesClipboardStore = new FilesClipboardStore()

export function useFilesClipboard(): FilesClipboard | null {
  const subscribe = useCallback((listener: () => void) => filesClipboardStore.subscribe(listener), [])
  const getSnapshot = useCallback(() => filesClipboardStore.get(), [])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

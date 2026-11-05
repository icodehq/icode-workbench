import { useCallback, useSyncExternalStore } from 'react'

/**
 * Open files belong to a session, not to the Files panel.
 *
 * `SessionWorkspace` keeps its view state but the Files panel is re-created
 * when the active session changes. A tiny external store keeps each session's
 * tabs, unsaved text and active tab alive across that switch, the same way
 * review drafts survive their panel. It is deliberately in-memory: unsaved
 * text is never invented from persistence after a restart.
 */

export type OpenFileTab = {
  /** Worktree-relative, normalized by main. */
  path: string
  text: string
  savedText: string
  /** HEAD text for quick diff; null for a new, untracked, binary or large file. */
  original: string | null
  /** Opaque disk version; null means the file did not exist when opened. */
  etag: string | null
  disk: 'current' | 'changed' | 'deleted'
  load: 'loading' | 'ready' | 'failed'
  failure: string | null
}

export type FilesSessionState = {
  tabs: OpenFileTab[]
  activePath: string | null
}

export type DirtyFileTab = {
  sessionId: string
  path: string
  text: string
  savedText: string
  etag: string | null
  original: string | null
}

const EMPTY_STATE: FilesSessionState = Object.freeze({
  tabs: Object.freeze([]) as unknown as OpenFileTab[],
  activePath: null
})

/**
 * Upper bound on buffered file text. This is a guard against opening a wall of
 * large files, not a user-facing quota; normal use is far below it.
 */
export const FILES_MAX_BUFFERED_CHARS = 16 * 1024 * 1024

function isDirty(tab: OpenFileTab): boolean {
  return tab.text !== tab.savedText
}

function replaceTab(
  state: FilesSessionState,
  path: string,
  update: (tab: OpenFileTab) => OpenFileTab
): FilesSessionState {
  let changed = false
  const tabs = state.tabs.map((tab) => {
    if (tab.path !== path) return tab
    const next = update(tab)
    if (next !== tab) changed = true
    return next
  })
  return changed ? { ...state, tabs } : state
}

export class OpenFilesStore {
  private readonly states = new Map<string, FilesSessionState>()
  private readonly listeners = new Set<() => void>()

  get(sessionId: string): FilesSessionState {
    return this.states.get(sessionId) ?? EMPTY_STATE
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** True when `extraChars` more text fits inside the global buffer bound. */
  canStore(sessionId: string, path: string, extraChars: number): boolean {
    const existing = this.find(sessionId, path)
    if (existing !== null) return true
    let total = 0
    for (const state of this.states.values()) {
      for (const tab of state.tabs) total += tab.text.length
    }
    return total + extraChars <= FILES_MAX_BUFFERED_CHARS
  }

  find(sessionId: string, path: string): OpenFileTab | null {
    return this.get(sessionId).tabs.find((tab) => tab.path === path) ?? null
  }

  /**
   * Opens a file, or activates it when it is already open.
   *
   * Returns whether a new tab was created, so the caller knows whether it owes
   * a read. An existing tab is never replaced or reloaded here: its buffer is
   * the user's.
   */
  open(sessionId: string, path: string): { tab: OpenFileTab; created: boolean } {
    const state = this.get(sessionId)
    const existing = state.tabs.find((tab) => tab.path === path)
    if (existing !== undefined) {
      if (state.activePath !== path) {
        this.states.set(sessionId, { ...state, activePath: path })
        this.emit()
      }
      return { tab: existing, created: false }
    }
    const tab: OpenFileTab = {
      path,
      text: '',
      savedText: '',
      original: null,
      etag: null,
      disk: 'current',
      load: 'loading',
      failure: null
    }
    this.states.set(sessionId, {
      tabs: [...state.tabs, tab],
      activePath: path
    })
    this.emit()
    return { tab, created: true }
  }

  setActive(sessionId: string, path: string): void {
    const state = this.get(sessionId)
    if (state.activePath === path) return
    if (!state.tabs.some((tab) => tab.path === path)) return
    this.states.set(sessionId, { ...state, activePath: path })
    this.emit()
  }

  setLoading(sessionId: string, path: string): void {
    this.update(sessionId, path, (tab) => ({
      ...tab,
      load: 'loading',
      failure: null
    }))
  }

  setContent(
    sessionId: string,
    path: string,
    content: { text: string; etag: string | null }
  ): void {
    this.update(sessionId, path, (tab) => ({
      ...tab,
      text: content.text,
      savedText: content.text,
      etag: content.etag,
      disk: 'current',
      load: 'ready',
      failure: null
    }))
  }

  setOriginal(sessionId: string, path: string, original: string | null): void {
    this.update(sessionId, path, (tab) => (tab.original === original ? tab : { ...tab, original }))
  }

  setFailure(sessionId: string, path: string, failure: string): void {
    this.update(sessionId, path, (tab) => ({
      ...tab,
      load: 'failed',
      failure
    }))
  }

  updateText(sessionId: string, path: string, text: string): void {
    this.update(sessionId, path, (tab) => (tab.text === text ? tab : { ...tab, text }))
  }

  markSaved(sessionId: string, path: string, etag: string): void {
    this.update(sessionId, path, (tab) => ({
      ...tab,
      savedText: tab.text,
      etag,
      disk: 'current'
    }))
  }

  markDiskChanged(sessionId: string, path: string): void {
    this.update(sessionId, path, (tab) =>
      tab.disk === 'changed' ? tab : { ...tab, disk: 'changed' }
    )
  }

  markDiskDeleted(sessionId: string, path: string): void {
    this.update(sessionId, path, (tab) =>
      tab.disk === 'deleted' ? tab : { ...tab, disk: 'deleted' }
    )
  }

  markDiskCurrent(sessionId: string, path: string): void {
    this.update(sessionId, path, (tab) =>
      tab.disk === 'current' ? tab : { ...tab, disk: 'current' }
    )
  }

  /**
   * Adopts the disk version while keeping the user's buffer.
   *
   * Used by “Keep mine”: the next save intentionally replaces that version
   * instead of asking again, and the watcher no longer re-marks the tab until
   * the disk changes once more.
   */
  adoptDiskVersion(sessionId: string, path: string, etag: string): void {
    this.update(sessionId, path, (tab) =>
      tab.etag === etag && tab.disk === 'current' ? tab : { ...tab, etag, disk: 'current' }
    )
  }

  /** Follows an in-app rename or move for every open tab under that path. */
  renamePath(sessionId: string, from: string, to: string): void {
    const state = this.get(sessionId)
    const prefix = `${from}/`
    let changed = false
    const tabs = state.tabs.map((tab) => {
      let nextPath: string
      if (tab.path === from) nextPath = to
      else if (tab.path.startsWith(prefix)) nextPath = `${to}/${tab.path.slice(prefix.length)}`
      else return tab
      changed = true
      // The quick-diff baseline is path-scoped; the next read refreshes it.
      return { ...tab, path: nextPath, original: null }
    })
    let activePath = state.activePath
    if (activePath === from) activePath = to
    else if (activePath !== null && activePath.startsWith(prefix)) {
      activePath = `${to}/${activePath.slice(prefix.length)}`
    }
    if (!changed) return
    this.states.set(sessionId, { tabs, activePath })
    this.emit()
  }

  closeTab(sessionId: string, path: string): void {
    const state = this.get(sessionId)
    const index = state.tabs.findIndex((tab) => tab.path === path)
    if (index === -1) return
    const tabs = state.tabs.filter((tab) => tab.path !== path)
    const activePath =
      state.activePath !== path
        ? state.activePath
        : (tabs[Math.min(index, tabs.length - 1)]?.path ?? null)
    if (tabs.length === 0) this.states.delete(sessionId)
    else this.states.set(sessionId, { tabs, activePath })
    this.emit()
  }

  closeAll(sessionId: string): void {
    if (!this.states.has(sessionId)) return
    this.states.delete(sessionId)
    this.emit()
  }

  removeSession(sessionId: string): void {
    if (!this.states.has(sessionId)) return
    this.states.delete(sessionId)
    this.emit()
  }

  retain(sessionIds: ReadonlySet<string>): void {
    let changed = false
    for (const sessionId of [...this.states.keys()]) {
      if (sessionIds.has(sessionId)) continue
      this.states.delete(sessionId)
      changed = true
    }
    if (changed) this.emit()
  }

  dirtyTabs(sessionId: string): OpenFileTab[] {
    return this.get(sessionId).tabs.filter(isDirty)
  }

  dirtyCount(sessionId: string): number {
    return this.dirtyTabs(sessionId).length
  }

  allDirtyTabs(): DirtyFileTab[] {
    const result: DirtyFileTab[] = []
    for (const [sessionId, state] of this.states) {
      for (const tab of state.tabs) {
        if (!isDirty(tab)) continue
        result.push({
          sessionId,
          path: tab.path,
          text: tab.text,
          savedText: tab.savedText,
          etag: tab.etag,
          original: tab.original
        })
      }
    }
    return result
  }

  dirtySummary(): { files: number; sessions: number } {
    const sessions = new Set<string>()
    let files = 0
    for (const [sessionId, state] of this.states) {
      for (const tab of state.tabs) {
        if (!isDirty(tab)) continue
        files += 1
        sessions.add(sessionId)
      }
    }
    return { files, sessions: sessions.size }
  }

  private update(
    sessionId: string,
    path: string,
    updater: (tab: OpenFileTab) => OpenFileTab
  ): void {
    const state = this.get(sessionId)
    const next = replaceTab(state, path, updater)
    if (next === state) return
    this.states.set(sessionId, next)
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const openFilesStore = new OpenFilesStore()

export function useSessionFiles(sessionId: string): FilesSessionState {
  const subscribe = useCallback((listener: () => void) => openFilesStore.subscribe(listener), [])
  const getSnapshot = useCallback(() => openFilesStore.get(sessionId), [sessionId])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useFilesDirtyCount(sessionId: string): number {
  const subscribe = useCallback((listener: () => void) => openFilesStore.subscribe(listener), [])
  const getSnapshot = useCallback(
    () => openFilesStore.dirtyCount(sessionId),
    [sessionId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

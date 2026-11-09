import { translate } from '../i18n/i18n-store'
import { useCallback, useSyncExternalStore } from 'react'
import { z } from 'zod'

/**
 * Open files belong to a session, not to the Files panel.
 *
 * `SessionWorkspace` keeps its view state but the Files panel is re-created
 * when the active session changes. A tiny external store keeps each session's
 * tabs, unsaved text and active tab alive across that switch. Phase D adds a
 * debounced hot-exit backup in IndexedDB so a normal app restart restores the
 * same tabs and dirty buffers; the in-memory store remains authoritative.
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

/** Hot-exit backup contract. Only this version is loaded. */
export const FILES_TABS_STORAGE_KEY = 'icode.files.tabs.v1'

export type OpenFilesPersistence = {
  load(): Promise<unknown>
  save(value: unknown): Promise<void>
}

const tabSchema = z.object({
  path: z.string().min(1).max(4096),
  text: z.string().max(FILES_MAX_BUFFERED_CHARS),
  savedText: z.string().max(FILES_MAX_BUFFERED_CHARS),
  original: z.string().max(FILES_MAX_BUFFERED_CHARS).nullable(),
  etag: z.string().max(512).nullable(),
  disk: z.enum(['current', 'changed', 'deleted']),
  load: z.enum(['loading', 'ready', 'failed']),
  failure: z.string().max(2000).nullable()
})

const stateSchema = z.object({
  tabs: z.array(tabSchema).max(200),
  activePath: z.string().max(4096).nullable()
})

const payloadSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), stateSchema)
})

export type PersistedOpenFiles = z.infer<typeof payloadSchema>

/** Turns a stored payload into usable state, dropping malformed tabs whole. */
export function parsePersistedOpenFiles(raw: unknown): Map<string, FilesSessionState> {
  const parsed = payloadSchema.safeParse(raw)
  if (!parsed.success) return new Map()
  const result = new Map<string, FilesSessionState>()
  for (const [sessionId, state] of Object.entries(parsed.data.sessions)) {
    const tabs = state.tabs.map((tab) =>
      tab.load === 'loading'
        ? {
            ...tab,
            load: 'failed' as const,
            failure: translate('fileIndex.editorClosed')
          }
        : tab
    )
    result.set(sessionId, { tabs, activePath: state.activePath })
  }
  return result
}

/**
 * IndexedDB has the quota for a real hot-exit buffer; localStorage does not.
 * The singleton still works without it (tests, non-browser environments).
 */
export function createIndexedDbPersistence(): OpenFilesPersistence | null {
  if (typeof indexedDB === 'undefined') return null
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('icode-files-hot-exit', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('state')) {
        request.result.createObjectStore('state')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'))
  })
  return {
    async load() {
      const db = await database
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('state', 'readonly')
        const request = transaction.objectStore('state').get(FILES_TABS_STORAGE_KEY)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Hot-exit read failed'))
      })
    },
    async save(value) {
      const db = await database
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('state', 'readwrite')
        transaction.objectStore('state').put(value, FILES_TABS_STORAGE_KEY)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('Hot-exit write failed'))
      })
    }
  }
}

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
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saveChain: Promise<void> = Promise.resolve()
  private warning: string | null = null
  private retained: ReadonlySet<string> | null = null
  private readonly hydration: Promise<void>

  constructor(
    private readonly persistence: OpenFilesPersistence | null = null,
    private readonly saveDelayMs = 300
  ) {
    this.hydration = persistence === null ? Promise.resolve() : this.hydrate()
  }

  private async hydrate(): Promise<void> {
    if (this.persistence === null) return
    try {
      const loaded = parsePersistedOpenFiles(await this.persistence.load())
      let changed = false
      for (const [sessionId, state] of loaded) {
        if (this.states.has(sessionId) || state.tabs.length === 0) continue
        if (this.retained !== null && !this.retained.has(sessionId)) continue
        this.states.set(sessionId, state)
        changed = true
      }
      if (changed) this.emit()
    } catch (error) {
      this.warning = translate('fileIndex.restoreFailed', {
        detail: error instanceof Error ? error.message : String(error)
      })
      this.notifyListeners()
    }
  }

  /** Reports a hot-exit problem once; Files shows it as a quiet banner. */
  takeHotExitWarning(): string | null {
    const value = this.warning
    this.warning = null
    return value
  }

  /** Persists immediately; `pagehide` calls this so the last keystroke survives. */
  async flush(): Promise<void> {
    if (this.persistence === null) return
    // Never overwrite the stored payload before this window has read it.
    await this.hydration
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const payload: PersistedOpenFiles = {
      version: 1,
      sessions: Object.fromEntries(this.states)
    }
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.persistence!.save(payload)
        } catch (error) {
          this.warning = translate('fileIndex.backupFailed', {
            detail: error instanceof Error ? error.message : String(error)
          })
          this.notifyListeners()
        }
      })
    await this.saveChain
  }

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
    this.retained = sessionIds
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

  private notifyListeners(): void {
    for (const listener of this.listeners) listener()
  }

  private emit(): void {
    this.notifyListeners()
    if (this.persistence === null) return
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, this.saveDelayMs)
  }
}

export const openFilesStore = new OpenFilesStore(createIndexedDbPersistence())

if (typeof window !== 'undefined') {
  const flush = (): void => {
    void openFilesStore.flush()
  }
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
}

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

import { translate } from '../i18n/i18n-store'
import { useCallback, useSyncExternalStore } from 'react'
import { z } from 'zod'
import type { GitRangeFile } from '../../../shared/domain/git-workspace'
import type { WorkingTreeEntry } from '../review/working-tree'

/**
 * Center tabs belong to a session, not to a panel.
 *
 * `SessionWorkspace` is re-created when the active session changes. A tiny
 * external store keeps each session's open tabs, unsaved text, active tab and
 * center mode alive across that switch. A debounced hot-exit backup in
 * IndexedDB restores the same file tabs and dirty buffers after a restart; the
 * in-memory store remains authoritative.
 *
 * File and diff tabs share one ordered list so the center strip is the only
 * navigation order. Diff tabs are read-only projections of the working tree or
 * a committed range: they are transient, never dirty and never persisted.
 *
 * The list is scoped by session today. The workspace-tabs layer will later
 * re-key it to a worktree-scoped list; the `kind` discriminator and preview
 * rules are the shared interface (see docs/workbench-tabs.md).
 */

export type CenterMode = 'terminal' | 'editor'

export type FileTab = {
  kind: 'file'
  /** A single click opens a preview tab the next single click replaces. */
  preview: boolean
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

/** What a diff tab shows; the host fetches the payload. */
export type DiffTabRequest =
  | { kind: 'working'; entry: WorkingTreeEntry }
  | { kind: 'committed'; baseOid: string; file: GitRangeFile }

export type DiffTab = {
  kind: 'diff'
  preview: boolean
  /** Stable identity: scope + path, or base + path for committed rows. */
  key: string
  request: DiffTabRequest
}

export type CenterTab = FileTab | DiffTab

/** File tabs keep this name for the existing Files panel composition. */
export type OpenFileTab = FileTab

export type FilesSessionState = {
  tabs: CenterTab[]
  /** Key of the active tab; null means the terminal is showing. */
  activeKey: string | null
  /** Active file path for the tree/highlight and legacy consumers. */
  activePath: string | null
  mode: CenterMode
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
  tabs: Object.freeze([]) as unknown as CenterTab[],
  activeKey: null,
  activePath: null,
  mode: 'terminal'
})

export function isFileTab(tab: CenterTab): tab is FileTab {
  return tab.kind === 'file'
}

export function fileTabs(state: FilesSessionState): FileTab[] {
  return state.tabs.filter(isFileTab)
}

export function activeTab(state: FilesSessionState): CenterTab | null {
  if (state.activeKey === null) return null
  return state.tabs.find((tab) => tabKey(tab) === state.activeKey) ?? null
}

export function activeFileTab(state: FilesSessionState): FileTab | null {
  const tab = activeTab(state)
  return tab !== null && isFileTab(tab) ? tab : null
}

/** The file or diff path the tree should highlight for the active tab. */
export function activeRevealPath(state: FilesSessionState): string | null {
  const tab = activeTab(state)
  if (tab === null) return null
  if (isFileTab(tab)) return tab.path
  return tab.request.kind === 'working'
    ? tab.request.entry.entry.path
    : tab.request.file.path
}

export function tabKey(tab: CenterTab): string {
  return isFileTab(tab) ? tab.path : tab.key
}

export function diffTabKey(request: DiffTabRequest): string {
  if (request.kind === 'committed') {
    return `diff:committed:${request.baseOid}:${request.file.path}`
  }
  return `diff:${request.entry.area}:${request.entry.entry.path}`
}

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
  /** Absent on payloads written before center tabs. */
  kind: z.literal('file').optional(),
  preview: z.boolean().optional(),
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
  /** Legacy active file; still written so older builds can restore buffers. */
  activePath: z.string().max(4096).nullable().optional(),
  activeKey: z.string().max(4096).nullable().optional(),
  mode: z.enum(['terminal', 'editor']).optional()
})

const payloadSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), stateSchema)
})

export type PersistedOpenFiles = z.infer<typeof payloadSchema>

/**
 * Turns a stored payload into usable state, dropping malformed tabs whole.
 *
 * Restored tabs are always permanent: a preview tab is a transient browsing
 * state, not a promise about the next launch. Older payloads lack `activeKey`
 * and `mode`, so the active file stands in and the editor opens when it did.
 */
export function parsePersistedOpenFiles(raw: unknown): Map<string, FilesSessionState> {
  const parsed = payloadSchema.safeParse(raw)
  if (!parsed.success) return new Map()
  const result = new Map<string, FilesSessionState>()
  for (const [sessionId, state] of Object.entries(parsed.data.sessions)) {
    const tabs: FileTab[] = state.tabs.map((tab) => ({
      kind: 'file',
      preview: false,
      path: tab.path,
      text: tab.text,
      savedText: tab.savedText,
      original: tab.original,
      etag: tab.etag,
      disk: tab.disk,
      load: tab.load === 'loading' ? 'failed' : tab.load,
      failure: tab.load === 'loading' ? translate('fileIndex.editorClosed') : tab.failure
    }))
    const keys = new Set(tabs.map((tab) => tab.path))
    const activePath =
      state.activePath !== undefined && state.activePath !== null && keys.has(state.activePath)
        ? state.activePath
        : null
    const activeKey =
      state.activeKey !== undefined && state.activeKey !== null && keys.has(state.activeKey)
        ? state.activeKey
        : (activePath ?? tabs[0]?.path ?? null)
    const mode =
      state.mode === 'terminal' || activeKey === null ? 'terminal' : ('editor' as const)
    result.set(sessionId, {
      tabs,
      activeKey,
      activePath: activeKey !== null && keys.has(activeKey) ? activeKey : null,
      mode
    })
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

export function isDirty(tab: FileTab): boolean {
  return tab.text !== tab.savedText
}

function replaceTab(
  state: FilesSessionState,
  path: string,
  update: (tab: FileTab) => FileTab
): FilesSessionState {
  let changed = false
  const tabs = state.tabs.map((tab) => {
    if (!isFileTab(tab) || tab.path !== path) return tab
    const next = update(tab)
    if (next !== tab) changed = true
    return next
  })
  return changed ? { ...state, tabs } : state
}

function replaceablePreview(tab: CenterTab): boolean {
  return tab.preview && (!isFileTab(tab) || !isDirty(tab))
}

/**
 * Picks the active tab and mode after a close/rename: a still-valid key wins,
 * one tab replaced by its neighbour, no tabs by the terminal.
 */
function normalizeTabs(
  tabs: CenterTab[],
  activeKey: string | null,
  mode: CenterMode
): FilesSessionState {
  const valid =
    activeKey !== null && tabs.some((tab) => tabKey(tab) === activeKey) ? activeKey : null
  const active = valid === null ? null : tabs.find((tab) => tabKey(tab) === valid) ?? null
  return {
    tabs,
    activeKey: active === null ? null : valid,
    activePath: active !== null && isFileTab(active) ? active.path : null,
    mode: active === null ? 'terminal' : mode === 'terminal' ? 'terminal' : 'editor'
  }
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
    const sessions: PersistedOpenFiles['sessions'] = {}
    for (const [sessionId, state] of this.states) {
      // Diff tabs are transient; only file buffers and the file active tab survive.
      const active = activeFileTab(state)
      sessions[sessionId] = {
        tabs: fileTabs(state).map((tab) => ({
          kind: 'file' as const,
          preview: false,
          path: tab.path,
          text: tab.text,
          savedText: tab.savedText,
          original: tab.original,
          etag: tab.etag,
          disk: tab.disk,
          load: tab.load,
          failure: tab.failure
        })),
        activePath: active?.path ?? null,
        activeKey: active?.path ?? null,
        mode: active !== null && state.mode === 'editor' ? 'editor' : 'terminal'
      }
    }
    const payload: PersistedOpenFiles = { version: 1, sessions }
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
      for (const tab of fileTabs(state)) total += tab.text.length
    }
    return total + extraChars <= FILES_MAX_BUFFERED_CHARS
  }

  find(sessionId: string, path: string): FileTab | null {
    return (
      this.get(sessionId).tabs.find(
        (tab): tab is FileTab => isFileTab(tab) && tab.path === path
      ) ?? null
    )
  }

  /**
   * Opens a file, or activates it when it is already open.
   *
   * Returns whether a new tab was created, so the caller knows whether it owes
   * a read, and the key of a preview tab it replaced. An existing tab is never
   * replaced or reloaded here: its buffer is the user's. A permanent open pins
   * an existing preview tab.
   */
  open(
    sessionId: string,
    path: string,
    options?: { preview?: boolean }
  ): { tab: FileTab; created: boolean; replacedKey: string | null } {
    const state = this.get(sessionId)
    const existing = state.tabs.find(
      (tab): tab is FileTab => isFileTab(tab) && tab.path === path
    )
    if (existing !== undefined) {
      const pin = options?.preview === false && existing.preview
      if (state.activeKey !== path || pin) {
        this.states.set(
          sessionId,
          normalizeTabs(
            state.tabs.map((tab) =>
              tab === existing ? { ...existing, preview: pin ? false : existing.preview } : tab
            ),
            path,
            'editor'
          )
        )
        this.emit()
      }
      return { tab: pin ? { ...existing, preview: false } : existing, created: false, replacedKey: null }
    }
    const preview = options?.preview === true
    const tab: FileTab = {
      kind: 'file',
      preview,
      path,
      text: '',
      savedText: '',
      original: null,
      etag: null,
      disk: 'current',
      load: 'loading',
      failure: null
    }
    const replaced = preview ? state.tabs.find(replaceablePreview) : undefined
    const replacedKey = replaced === undefined ? null : tabKey(replaced)
    const tabs =
      replaced === undefined
        ? [...state.tabs, tab]
        : state.tabs.map((candidate) => (candidate === replaced ? tab : candidate))
    this.states.set(sessionId, normalizeTabs(tabs, path, 'editor'))
    this.emit()
    return { tab, created: true, replacedKey }
  }

  /** Opens or focuses a diff tab. Diff tabs are never dirty and never persisted. */
  openDiff(
    sessionId: string,
    request: DiffTabRequest,
    options?: { preview?: boolean }
  ): { tab: DiffTab; created: boolean; replacedKey: string | null } {
    const state = this.get(sessionId)
    const key = diffTabKey(request)
    const existing = state.tabs.find(
      (tab): tab is DiffTab => !isFileTab(tab) && tab.key === key
    )
    if (existing !== undefined) {
      const pin = options?.preview === false && existing.preview
      const tabs = pin
        ? state.tabs.map((tab) => (tab === existing ? { ...existing, preview: false } : tab))
        : state.tabs
      if (state.activeKey !== key || pin) {
        this.states.set(sessionId, normalizeTabs(tabs, key, 'editor'))
        this.emit()
      }
      return { tab: pin ? { ...existing, preview: false } : existing, created: false, replacedKey: null }
    }
    const tab: DiffTab = {
      kind: 'diff',
      preview: options?.preview === true,
      key,
      request
    }
    const replaced = tab.preview
      ? state.tabs.find(replaceablePreview)
      : undefined
    const tabs = replaced === undefined
      ? [...state.tabs, tab]
      : state.tabs.map((candidate) => (candidate === replaced ? tab : candidate))
    this.states.set(sessionId, normalizeTabs(tabs, key, 'editor'))
    this.emit()
    return { tab, created: true, replacedKey: replaced === undefined ? null : tabKey(replaced) }
  }

  /** Keeps a preview tab open, so later previews no longer replace it. */
  pin(sessionId: string, keyOrPath: string): void {
    const state = this.get(sessionId)
    let changed = false
    const tabs = state.tabs.map((tab) => {
      if (tabKey(tab) !== keyOrPath || !tab.preview) return tab
      changed = true
      return { ...tab, preview: false }
    })
    if (!changed) return
    this.states.set(sessionId, { ...state, tabs })
    this.emit()
  }

  setActiveKey(sessionId: string, key: string): void {
    const state = this.get(sessionId)
    if (state.activeKey === key && state.mode === 'editor') return
    if (!state.tabs.some((tab) => tabKey(tab) === key)) return
    this.states.set(sessionId, normalizeTabs(state.tabs, key, 'editor'))
    this.emit()
  }

  setActive(sessionId: string, path: string): void {
    this.setActiveKey(sessionId, path)
  }

  setMode(sessionId: string, mode: CenterMode): void {
    const state = this.get(sessionId)
    if (state.mode === mode) return
    if (mode === 'editor' && state.activeKey === null) return
    this.states.set(sessionId, { ...state, mode })
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
    this.update(sessionId, path, (tab) =>
      tab.text === text && !tab.preview ? tab : { ...tab, text, preview: false }
    )
  }

  markSaved(sessionId: string, path: string, etag: string): void {
    this.update(sessionId, path, (tab) => ({
      ...tab,
      savedText: tab.text,
      etag,
      disk: 'current',
      preview: false
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

  /**
   * Follows an in-app rename or move for every open file tab under that path.
   * A diff tab for the renamed path would now describe a file that no longer
   * exists there, so it is closed instead of retargeted.
   */
  renamePath(sessionId: string, from: string, to: string): void {
    const state = this.get(sessionId)
    const prefix = `${from}/`
    const renamed = (path: string): string | null => {
      if (path === from) return to
      if (path.startsWith(prefix)) return `${to}/${path.slice(prefix.length)}`
      return null
    }
    let changed = false
    let activeKey = state.activeKey
    let mode = state.mode
    const tabs: CenterTab[] = []
    for (const tab of state.tabs) {
      if (isFileTab(tab)) {
        const nextPath = renamed(tab.path)
        if (nextPath === null) {
          tabs.push(tab)
          continue
        }
        changed = true
        if (activeKey === tab.path) activeKey = nextPath
        // The quick-diff baseline is path-scoped; the next read refreshes it.
        tabs.push({ ...tab, path: nextPath, original: null })
        continue
      }
      const path =
        tab.request.kind === 'working'
          ? tab.request.entry.entry.path
          : tab.request.file.path
      if (renamed(path) === null) {
        tabs.push(tab)
        continue
      }
      changed = true
      if (activeKey === tab.key) {
        activeKey = null
        mode = 'terminal'
      }
    }
    if (!changed) return
    this.states.set(sessionId, normalizeTabs(tabs, activeKey, mode))
    this.emit()
  }

  closeTab(sessionId: string, keyOrPath: string): void {
    const state = this.get(sessionId)
    const index = state.tabs.findIndex(
      (tab) => tabKey(tab) === keyOrPath || (isFileTab(tab) && tab.path === keyOrPath)
    )
    if (index === -1) return
    const removed = state.tabs[index]
    if (removed === undefined) return
    const tabs = state.tabs.filter((_, position) => position !== index)
    if (tabs.length === 0) {
      this.states.delete(sessionId)
      this.emit()
      return
    }
    const wasActive = state.activeKey === tabKey(removed)
    const nextActive = wasActive
      ? tabKey(tabs[Math.min(index, tabs.length - 1)]!)
      : state.activeKey
    this.states.set(
      sessionId,
      normalizeTabs(tabs, nextActive, wasActive ? 'editor' : state.mode)
    )
    this.emit()
  }

  /** Closes every file and diff tab for a deleted path or any descendant. */
  closeTabsUnder(sessionId: string, path: string): void {
    const state = this.get(sessionId)
    const under = (candidate: string | null | undefined): boolean =>
      candidate !== undefined &&
      candidate !== null &&
      (candidate === path || candidate.startsWith(`${path}/`))
    const matches = (tab: CenterTab): boolean => {
      if (isFileTab(tab)) return under(tab.path)
      if (tab.request.kind === 'working') {
        return (
          under(tab.request.entry.entry.path) || under(tab.request.entry.entry.oldPath)
        )
      }
      return under(tab.request.file.path) || under(tab.request.file.oldPath)
    }
    const firstRemoved = state.tabs.findIndex(matches)
    if (firstRemoved === -1) return
    const tabs = state.tabs.filter((tab) => !matches(tab))
    if (tabs.length === 0) {
      this.states.delete(sessionId)
      this.emit()
      return
    }
    const wasActive = state.tabs.some(
      (tab) => tabKey(tab) === state.activeKey && matches(tab)
    )
    const nextActive = wasActive
      ? tabKey(tabs[Math.min(firstRemoved, tabs.length - 1)]!)
      : state.activeKey
    this.states.set(
      sessionId,
      normalizeTabs(tabs, nextActive, wasActive ? 'editor' : state.mode)
    )
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

  dirtyTabs(sessionId: string): FileTab[] {
    return fileTabs(this.get(sessionId)).filter(isDirty)
  }

  dirtyCount(sessionId: string): number {
    return this.dirtyTabs(sessionId).length
  }

  allDirtyTabs(): DirtyFileTab[] {
    const result: DirtyFileTab[] = []
    for (const [sessionId, state] of this.states) {
      for (const tab of fileTabs(state)) {
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
      for (const tab of fileTabs(state)) {
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
    updater: (tab: FileTab) => FileTab
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

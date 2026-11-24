import { translate } from '../i18n/i18n-store'
import { useCallback, useSyncExternalStore } from 'react'
import { z } from 'zod'
import type { GitRangeFile } from '../../../shared/domain/git-workspace'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import type { WorkingTreeEntry } from '../review/working-tree'
import {
  fileTabKey,
  moveTabKey,
  parseTabKey,
  sessionTabKey,
  workspaceKeyForSession
} from '../workspace/workspace-key'

/**
 * Center tabs belong to a workspace, not to a panel.
 *
 * The store is scoped by an opaque `scopeKey`: a worktree key for the direct
 * sessions surface, and the session id for `TaskWorkbench`. `SessionWorkspace`
 * is re-created when the active workspace changes. A tiny external store keeps
 * each scope's open tabs, unsaved text, active tab and center mode alive across
 * that switch. A debounced hot-exit backup in IndexedDB restores file tabs and
 * dirty buffers after a restart; the in-memory store remains authoritative.
 *
 * Session tabs, file tabs and diff tabs share one ordered list so the worktree
 * bar is the only navigation order. Diff tabs are read-only projections and are
 * never persisted; session tabs reconcile against the live session list.
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

/**
 * A live session rendered as a tab: an agent terminal, or a raw shell.
 * Session tabs are never previews; their title/state come from the session.
 */
export type SessionTab = {
  kind: 'session'
  preview: false
  key: string
  sessionId: string
}

export type CenterTab = FileTab | DiffTab | SessionTab

/** File tabs keep this name for the existing Files panel composition. */
export type OpenFileTab = FileTab

export type FilesSessionState = {
  tabs: CenterTab[]
  /** Key of the active tab; null means no tab is focused. */
  activeKey: string | null
  /** Active file path for the tree/highlight and legacy consumers. */
  activePath: string | null
  mode: CenterMode
  /** Sessions hidden from the worktree bar; they keep running. */
  hiddenSessionIds: string[]
}

export type DirtyBufferTab = {
  /** Workspace key for direct surfaces, session id for TaskWorkbench. */
  scopeKey: string
  path: string
  text: string
  savedText: string
  etag: string | null
  original: string | null
}

/** @deprecated Use DirtyBufferTab. */
export type DirtyFileTab = DirtyBufferTab

const EMPTY_STATE: FilesSessionState = Object.freeze({
  tabs: Object.freeze([]) as unknown as CenterTab[],
  activeKey: null,
  activePath: null,
  mode: 'terminal',
  hiddenSessionIds: Object.freeze([]) as unknown as string[]
})

export function isFileTab(tab: CenterTab): tab is FileTab {
  return tab.kind === 'file'
}

export function isSessionTab(tab: CenterTab): tab is SessionTab {
  return tab.kind === 'session'
}

export function fileTabs(state: FilesSessionState): FileTab[] {
  return state.tabs.filter(isFileTab)
}

export function sessionTabs(state: FilesSessionState): SessionTab[] {
  return state.tabs.filter(isSessionTab)
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
  if (tab === null || tab.kind === 'session') return null
  if (isFileTab(tab)) return tab.path
  return tab.request.kind === 'working'
    ? tab.request.entry.entry.path
    : tab.request.file.path
}

export function tabKey(tab: CenterTab): string {
  return isFileTab(tab) ? fileTabKey(tab.path) : tab.key
}

/** Resolves a namespaced key, or a legacy raw file path, to a tab key. */
export function resolveTabKey(keyOrPath: string): string {
  return parseTabKey(keyOrPath) === null ? fileTabKey(keyOrPath) : keyOrPath
}

/** Finds a tab by its namespaced key or, for legacy callers, by file path. */
export function findTab(state: FilesSessionState, keyOrPath: string): CenterTab | null {
  const key = resolveTabKey(keyOrPath)
  return state.tabs.find((tab) => tabKey(tab) === key) ?? null
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

/** Hot-exit backup keys. v1 was session-scoped; v2 is scope-keyed. */
export const FILES_TABS_STORAGE_KEY_V1 = 'icode.files.tabs.v1'
/** @deprecated Use FILES_TABS_STORAGE_KEY_V1. */
export const FILES_TABS_STORAGE_KEY = FILES_TABS_STORAGE_KEY_V1
export const FILES_TABS_STORAGE_KEY_V2 = 'icode.files.tabs.v2'

export type OpenFilesPersistence = {
  load(key: string): Promise<unknown>
  save(key: string, value: unknown): Promise<void>
  remove?(key: string): Promise<void>
}

const fileTabSchema = z.object({
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

const legacyStateSchema = z.object({
  tabs: z.array(fileTabSchema).max(200),
  /** Legacy active file; still written so older builds can restore buffers. */
  activePath: z.string().max(4096).nullable().optional(),
  activeKey: z.string().max(4096).nullable().optional(),
  mode: z.enum(['terminal', 'editor']).optional()
})

const legacyPayloadSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), legacyStateSchema)
})

export type PersistedOpenFiles = z.infer<typeof legacyPayloadSchema>

const v2SessionTabSchema = z.object({
  kind: z.literal('session'),
  sessionId: z.string().min(1).max(128)
})

const v2StateSchema = z.object({
  tabs: z.array(z.union([v2SessionTabSchema, fileTabSchema])).max(200),
  activePath: z.string().max(4096).nullable().optional(),
  activeKey: z.string().max(4096).nullable().optional(),
  mode: z.enum(['terminal', 'editor']).optional()
})

const v2PayloadSchema = z.object({
  version: z.literal(2),
  workspaces: z.record(z.string(), v2StateSchema)
})

export type PersistedWorkspaceTabs = z.infer<typeof v2PayloadSchema>

function restoredFileTab(tab: z.infer<typeof fileTabSchema>): FileTab {
  return {
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
  }
}

/**
 * Turns a stored v1 payload into usable state, dropping malformed tabs whole.
 *
 * Restored tabs are always permanent: a preview tab is a transient browsing
 * state, not a promise about the next launch. Older payloads lack `activeKey`
 * and `mode`, so the active file stands in and the editor opens when it did.
 * v1 keys are session ids; `migrateLegacy` maps them to workspace keys.
 */
export function parsePersistedOpenFiles(raw: unknown): Map<string, FilesSessionState> {
  const parsed = legacyPayloadSchema.safeParse(raw)
  if (!parsed.success) return new Map()
  const result = new Map<string, FilesSessionState>()
  for (const [sessionId, state] of Object.entries(parsed.data.sessions)) {
    const tabs = state.tabs.map(restoredFileTab)
    const paths = new Set(tabs.map((tab) => tab.path))
    const activePath =
      state.activePath !== undefined && state.activePath !== null && paths.has(state.activePath)
        ? state.activePath
        : state.activeKey !== undefined &&
            state.activeKey !== null &&
            paths.has(state.activeKey)
          ? state.activeKey
          : null
    const fallback = activePath ?? tabs[0]?.path ?? null
    const activeKey = fallback === null ? null : fileTabKey(fallback)
    const mode =
      state.mode === 'terminal' || activeKey === null ? 'terminal' : ('editor' as const)
    result.set(sessionId, {
      tabs,
      activeKey,
      activePath: fallback,
      mode,
      hiddenSessionIds: []
    })
  }
  return result
}

/**
 * Turns a v2 payload into usable state. Session tabs are restored so the mixed
 * order survives a restart; `syncSessions` then reconciles them with live
 * sessions. Diff tabs never appear here.
 */
export function parsePersistedOpenFilesV2(
  raw: unknown
): Map<string, FilesSessionState> | null {
  const parsed = v2PayloadSchema.safeParse(raw)
  if (!parsed.success) return null
  const result = new Map<string, FilesSessionState>()
  for (const [scopeKey, state] of Object.entries(parsed.data.workspaces)) {
    const tabs: CenterTab[] = []
    const seenSessions = new Set<string>()
    for (const tab of state.tabs) {
      if ('sessionId' in tab) {
        if (seenSessions.has(tab.sessionId)) continue
        seenSessions.add(tab.sessionId)
        tabs.push({
          kind: 'session',
          preview: false,
          key: sessionTabKey(tab.sessionId),
          sessionId: tab.sessionId
        })
        continue
      }
      tabs.push(restoredFileTab(tab))
    }
    if (tabs.length === 0) continue
    const keys = new Set(tabs.map(tabKey))
    const activeKey =
      state.activeKey !== undefined &&
      state.activeKey !== null &&
      keys.has(state.activeKey)
        ? state.activeKey
        : tabKey(tabs[0]!)
    const active = tabs.find((tab) => tabKey(tab) === activeKey) ?? null
    const activePath = active !== null && isFileTab(active) ? active.path : null
    const mode =
      active === null || active.kind === 'session'
        ? 'terminal'
        : state.mode === 'terminal'
          ? 'terminal'
          : ('editor' as const)
    result.set(scopeKey, {
      tabs,
      activeKey,
      activePath,
      mode,
      hiddenSessionIds: []
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
    async load(key) {
      const db = await database
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('state', 'readonly')
        const request = transaction.objectStore('state').get(key)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Hot-exit read failed'))
      })
    },
    async save(key, value) {
      const db = await database
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('state', 'readwrite')
        transaction.objectStore('state').put(value, key)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('Hot-exit write failed'))
      })
    },
    async remove(key) {
      const db = await database
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('state', 'readwrite')
        transaction.objectStore('state').delete(key)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('Hot-exit delete failed'))
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
  if (tab.kind === 'session') return false
  return tab.preview && (!isFileTab(tab) || !isDirty(tab))
}

/**
 * The preview a new tab may replace. Multi-pane surfaces pass the focused
 * pane's current tab so a preview in another pane is never silently replaced.
 */
function previewTarget(state: FilesSessionState, replaceKey?: string): CenterTab | undefined {
  if (replaceKey !== undefined) {
    const tab = findTab(state, replaceKey)
    return tab !== null && replaceablePreview(tab) ? tab : undefined
  }
  return state.tabs.find(replaceablePreview)
}

/**
 * Picks the active tab and mode after a close/rename: a still-valid key wins,
 * one tab replaced by its neighbour, no tabs by the terminal.
 */
function normalizeTabs(
  tabs: CenterTab[],
  activeKey: string | null,
  mode: CenterMode,
  hiddenSessionIds: readonly string[] = []
): FilesSessionState {
  const valid =
    activeKey !== null && tabs.some((tab) => tabKey(tab) === activeKey) ? activeKey : null
  const active = valid === null ? null : tabs.find((tab) => tabKey(tab) === valid) ?? null
  const activeFile = active !== null && isFileTab(active) ? active : null
  return {
    tabs,
    activeKey: active === null ? null : valid,
    activePath: activeFile?.path ?? null,
    mode:
      active === null || active.kind === 'session'
        ? 'terminal'
        : mode === 'terminal'
          ? 'terminal'
          : 'editor',
    hiddenSessionIds: [...hiddenSessionIds]
  }
}

function sameState(a: FilesSessionState, b: FilesSessionState): boolean {
  if (a === b) return true
  if (a.tabs.length !== b.tabs.length) return false
  for (let index = 0; index < a.tabs.length; index += 1) {
    if (tabKey(a.tabs[index]!) !== tabKey(b.tabs[index]!)) return false
  }
  if (a.activeKey !== b.activeKey || a.mode !== b.mode) return false
  if (a.hiddenSessionIds.length !== b.hiddenSessionIds.length) return false
  return a.hiddenSessionIds.every((id, index) => id === b.hiddenSessionIds[index])
}

function mergeLegacyStates(
  base: FilesSessionState,
  incoming: FilesSessionState,
  incomingIsActive: boolean
): FilesSessionState {
  const tabs = [...base.tabs]
  for (const tab of incoming.tabs) {
    if (!isFileTab(tab)) continue
    const index = tabs.findIndex(
      (candidate): candidate is FileTab =>
        isFileTab(candidate) && candidate.path === tab.path
    )
    if (index === -1) {
      tabs.push(tab)
      continue
    }
    const existing = tabs[index]!
    // A stale clean duplicate must not clobber the dirty buffer.
    if (isFileTab(existing) && !isDirty(existing) && isDirty(tab)) tabs[index] = tab
  }
  const preferred = incomingIsActive ? incoming : base
  const activeKey =
    preferred.activeKey !== null && tabs.some((tab) => tabKey(tab) === preferred.activeKey)
      ? preferred.activeKey
      : base.activeKey
  return normalizeTabs(tabs, activeKey, preferred.mode)
}

export class OpenFilesStore {
  private readonly states = new Map<string, FilesSessionState>()
  private readonly listeners = new Set<() => void>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saveChain: Promise<void> = Promise.resolve()
  private warning: string | null = null
  private retained: ReadonlySet<string> | null = null
  private migrated = false
  private legacyPayload: unknown = null
  private readonly hydration: Promise<void>

  constructor(
    private readonly persistence: OpenFilesPersistence | null = null,
    private readonly saveDelayMs = 300
  ) {
    this.hydration = persistence === null ? Promise.resolve() : this.hydrate()
    if (persistence === null) this.migrated = true
  }

  private async hydrate(): Promise<void> {
    if (this.persistence === null) return
    try {
      const loadedV2 = parsePersistedOpenFilesV2(
        await this.persistence.load(FILES_TABS_STORAGE_KEY_V2)
      )
      if (loadedV2 !== null) {
        for (const [scopeKey, state] of loadedV2) {
          if (state.tabs.length === 0) continue
          if (this.retained !== null && !this.retained.has(scopeKey)) continue
          this.states.set(scopeKey, state)
        }
        this.migrated = true
        if (this.states.size > 0) this.emit()
        return
      }

      const legacy = await this.persistence.load(FILES_TABS_STORAGE_KEY_V1)
      const loadedV1 = parsePersistedOpenFiles(legacy)
      if (loadedV1.size === 0) {
        this.migrated = true
        return
      }
      // v1 is session-keyed. Keep it in memory for TaskWorkbench and migration,
      // but do not treat those session ids as workspace keys.
      this.legacyPayload = legacy
      this.migrated = false
      for (const [sessionId, state] of loadedV1) {
        if (state.tabs.length === 0) continue
        if (this.retained !== null && !this.retained.has(sessionId)) continue
        this.states.set(sessionId, state)
      }
      if (this.states.size > 0) this.emit()
    } catch (error) {
      this.warning = translate('fileIndex.restoreFailed', {
        detail: error instanceof Error ? error.message : String(error)
      })
      this.notifyListeners()
    }
  }

  /**
   * Maps legacy session-keyed hot-exit state onto workspace keys. Called once
   * the session list is known; task sessions keep their session scope.
   */
  async migrateLegacy(input: {
    sessions: readonly Pick<SessionSummary, 'id' | 'repoId' | 'worktree'>[]
    taskSessionIds: ReadonlySet<string>
    activeSessionId?: string | null
  }): Promise<void> {
    if (this.persistence === null) {
      this.migrated = true
      return
    }
    await this.hydration
    if (this.migrated) return
    const legacy = new Map(this.states)
    const merged = new Map<string, FilesSessionState>()
    for (const [sessionId, state] of legacy) {
      if (input.taskSessionIds.has(sessionId)) merged.set(sessionId, state)
    }
    for (const session of input.sessions) {
      if (input.taskSessionIds.has(session.id)) continue
      const state = legacy.get(session.id)
      if (state === undefined) continue
      const key = workspaceKeyForSession(session)
      const existing = merged.get(key)
      merged.set(
        key,
        existing === undefined
          ? state
          : mergeLegacyStates(existing, state, session.id === input.activeSessionId)
      )
    }
    this.states.clear()
    for (const [key, state] of merged) this.states.set(key, state)
    this.migrated = true
    this.legacyPayload = null
    if (this.retained !== null) {
      for (const key of [...this.states.keys()]) {
        if (!this.retained.has(key)) this.states.delete(key)
      }
    }
    this.emit()
    await this.flush()
    await this.persistence.remove?.(FILES_TABS_STORAGE_KEY_V1).catch(() => undefined)
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
    if (!this.migrated) {
      // App has not supplied the session list yet; keep the v1 payload intact.
      if (this.legacyPayload === null) return
      this.saveChain = this.saveChain
        .catch(() => undefined)
        .then(async () => {
          try {
            await this.persistence!.save(FILES_TABS_STORAGE_KEY_V1, this.legacyPayload)
          } catch (error) {
            this.warning = translate('fileIndex.backupFailed', {
              detail: error instanceof Error ? error.message : String(error)
            })
            this.notifyListeners()
          }
        })
      await this.saveChain
      return
    }

    const workspaces: PersistedWorkspaceTabs['workspaces'] = {}
    for (const [scopeKey, state] of this.states) {
      const tabs: PersistedWorkspaceTabs['workspaces'][string]['tabs'] = []
      for (const tab of state.tabs) {
        if (tab.kind === 'file') {
          tabs.push({
            kind: 'file',
            preview: false,
            path: tab.path,
            text: tab.text,
            savedText: tab.savedText,
            original: tab.original,
            etag: tab.etag,
            disk: tab.disk,
            load: tab.load,
            failure: tab.failure
          })
        } else if (tab.kind === 'session') {
          tabs.push({ kind: 'session', sessionId: tab.sessionId })
        }
        // Diff tabs are transient.
      }
      if (tabs.length === 0) continue
      const active = activeTab(state)
      const activeFile = active !== null && isFileTab(active) ? active : null
      workspaces[scopeKey] = {
        tabs,
        activePath: activeFile?.path ?? null,
        activeKey: active === null ? null : tabKey(active),
        mode: activeFile !== null && state.mode === 'editor' ? 'editor' : 'terminal'
      }
    }
    const payload: PersistedWorkspaceTabs = { version: 2, workspaces }
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.persistence!.save(FILES_TABS_STORAGE_KEY_V2, payload)
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
  canStore(scopeKey: string, path: string, extraChars: number): boolean {
    const existing = this.find(scopeKey, path)
    if (existing !== null) return true
    let total = 0
    for (const state of this.states.values()) {
      for (const tab of fileTabs(state)) total += tab.text.length
    }
    return total + extraChars <= FILES_MAX_BUFFERED_CHARS
  }

  find(scopeKey: string, path: string): FileTab | null {
    return (
      this.get(scopeKey).tabs.find(
        (tab): tab is FileTab => isFileTab(tab) && tab.path === path
      ) ?? null
    )
  }

  /** Finds any tab by namespaced key, or a raw file path for legacy callers. */
  findTab(scopeKey: string, keyOrPath: string): CenterTab | null {
    return findTab(this.get(scopeKey), keyOrPath)
  }

  /**
   * Opens a file, or activates it when it is already open.
   *
   * Returns whether a new tab was created, so the caller knows whether it owes
   * a read, and the key of a preview tab it replaced. An existing tab is never
   * replaced or reloaded here: its buffer is the user's. A permanent open pins
   * an existing preview tab. `replaceKey` scopes preview replacement to the
   * focused pane; without it the legacy first-clean-preview behavior applies.
   */
  open(
    scopeKey: string,
    path: string,
    options?: { preview?: boolean; replaceKey?: string }
  ): { tab: FileTab; created: boolean; replacedKey: string | null } {
    const state = this.get(scopeKey)
    const key = fileTabKey(path)
    const existing = state.tabs.find(
      (tab): tab is FileTab => isFileTab(tab) && tab.path === path
    )
    if (existing !== undefined) {
      const pin = options?.preview === false && existing.preview
      if (state.activeKey !== key || pin) {
        this.states.set(
          scopeKey,
          normalizeTabs(
            state.tabs.map((tab) =>
              tab === existing ? { ...existing, preview: pin ? false : existing.preview } : tab
            ),
            key,
            'editor',
            state.hiddenSessionIds
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
    const replaced = preview ? previewTarget(state, options?.replaceKey) : undefined
    const replacedKey = replaced === undefined ? null : tabKey(replaced)
    const tabs =
      replaced === undefined
        ? [...state.tabs, tab]
        : state.tabs.map((candidate) => (candidate === replaced ? tab : candidate))
    this.states.set(scopeKey, normalizeTabs(tabs, key, 'editor', state.hiddenSessionIds))
    this.emit()
    return { tab, created: true, replacedKey }
  }

  /** Opens or focuses a diff tab. Diff tabs are never dirty and never persisted. */
  openDiff(
    scopeKey: string,
    request: DiffTabRequest,
    options?: { preview?: boolean; replaceKey?: string }
  ): { tab: DiffTab; created: boolean; replacedKey: string | null } {
    const state = this.get(scopeKey)
    const key = diffTabKey(request)
    const existing = state.tabs.find(
      (tab): tab is DiffTab => tab.kind === 'diff' && tab.key === key
    )
    if (existing !== undefined) {
      const pin = options?.preview === false && existing.preview
      const tabs = pin
        ? state.tabs.map((tab) => (tab === existing ? { ...existing, preview: false } : tab))
        : state.tabs
      if (state.activeKey !== key || pin) {
        this.states.set(
          scopeKey,
          normalizeTabs(tabs, key, 'editor', state.hiddenSessionIds)
        )
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
    const replaced = tab.preview ? previewTarget(state, options?.replaceKey) : undefined
    const tabs = replaced === undefined
      ? [...state.tabs, tab]
      : state.tabs.map((candidate) => (candidate === replaced ? tab : candidate))
    this.states.set(scopeKey, normalizeTabs(tabs, key, 'editor', state.hiddenSessionIds))
    this.emit()
    return { tab, created: true, replacedKey: replaced === undefined ? null : tabKey(replaced) }
  }

  /** Keeps a preview tab open, so later previews no longer replace it. */
  pin(scopeKey: string, keyOrPath: string): void {
    const state = this.get(scopeKey)
    const key = resolveTabKey(keyOrPath)
    let changed = false
    const tabs = state.tabs.map((tab) => {
      if (tabKey(tab) !== key || !tab.preview) return tab
      changed = true
      return { ...tab, preview: false }
    })
    if (!changed) return
    this.states.set(scopeKey, { ...state, tabs })
    this.emit()
  }

  setActiveKey(scopeKey: string, keyOrPath: string): void {
    const state = this.get(scopeKey)
    const key = resolveTabKey(keyOrPath)
    const active = findTab(state, key)
    if (active === null) return
    const mode: CenterMode = active.kind === 'session' ? 'terminal' : 'editor'
    if (state.activeKey === key && state.mode === mode) return
    this.states.set(
      scopeKey,
      normalizeTabs(state.tabs, key, mode, state.hiddenSessionIds)
    )
    this.emit()
  }

  setActive(scopeKey: string, path: string): void {
    this.setActiveKey(scopeKey, fileTabKey(path))
  }

  setMode(scopeKey: string, mode: CenterMode): void {
    const state = this.get(scopeKey)
    if (state.mode === mode) return
    if (mode === 'editor' && state.activeKey === null) return
    this.states.set(
      scopeKey,
      normalizeTabs(state.tabs, state.activeKey, mode, state.hiddenSessionIds)
    )
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
  renamePath(scopeKey: string, from: string, to: string): void {
    const state = this.get(scopeKey)
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
      if (isSessionTab(tab)) {
        tabs.push(tab)
        continue
      }
      if (isFileTab(tab)) {
        const nextPath = renamed(tab.path)
        if (nextPath === null) {
          tabs.push(tab)
          continue
        }
        changed = true
        if (activeKey === fileTabKey(tab.path)) activeKey = fileTabKey(nextPath)
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
    this.states.set(
      scopeKey,
      normalizeTabs(tabs, activeKey, mode, state.hiddenSessionIds)
    )
    this.emit()
  }

  /**
   * Closes a file or diff tab. A session tab is hidden instead: the session
   * keeps running and can be reopened from the sidebar.
   */
  closeTab(scopeKey: string, keyOrPath: string): void {
    const state = this.get(scopeKey)
    const key = resolveTabKey(keyOrPath)
    const index = state.tabs.findIndex((tab) => tabKey(tab) === key)
    if (index === -1) return
    const removed = state.tabs[index]!
    if (removed.kind === 'session') {
      this.hideSession(scopeKey, removed.sessionId)
      return
    }
    const tabs = state.tabs.filter((_, position) => position !== index)
    const wasActive = state.activeKey === key
    const fallback = tabs[Math.min(index, tabs.length - 1)]
    const nextActive = wasActive ? (fallback === undefined ? null : tabKey(fallback)) : state.activeKey
    if (tabs.length === 0 && state.hiddenSessionIds.length === 0) {
      this.states.delete(scopeKey)
      this.emit()
      return
    }
    this.states.set(
      scopeKey,
      normalizeTabs(
        tabs,
        nextActive,
        wasActive ? 'editor' : state.mode,
        state.hiddenSessionIds
      )
    )
    this.emit()
  }

  /** Closes every file and diff tab for a deleted path or any descendant. */
  closeTabsUnder(scopeKey: string, path: string): void {
    const state = this.get(scopeKey)
    const under = (candidate: string | null | undefined): boolean =>
      candidate !== undefined &&
      candidate !== null &&
      (candidate === path || candidate.startsWith(`${path}/`))
    const matches = (tab: CenterTab): boolean => {
      if (tab.kind === 'session') return false
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
    if (tabs.length === 0 && state.hiddenSessionIds.length === 0) {
      this.states.delete(scopeKey)
      this.emit()
      return
    }
    const wasActive = state.tabs.some(
      (tab) => tabKey(tab) === state.activeKey && matches(tab)
    )
    const fallback = tabs[Math.min(firstRemoved, tabs.length - 1)]
    const nextActive = wasActive
      ? (fallback === undefined ? null : tabKey(fallback))
      : state.activeKey
    this.states.set(
      scopeKey,
      normalizeTabs(
        tabs,
        nextActive,
        wasActive ? 'editor' : state.mode,
        state.hiddenSessionIds
      )
    )
    this.emit()
  }

  /** Closes every file/diff tab; session tabs stay in the worktree bar. */
  closeAll(scopeKey: string): void {
    const state = this.states.get(scopeKey)
    if (state === undefined) return
    const tabs = state.tabs.filter((tab) => tab.kind === 'session')
    if (tabs.length === 0 && state.hiddenSessionIds.length === 0) {
      this.states.delete(scopeKey)
      this.emit()
      return
    }
    const activeKey =
      state.activeKey !== null && tabs.some((tab) => tabKey(tab) === state.activeKey)
        ? state.activeKey
        : tabs[0] === undefined
          ? null
          : tabKey(tabs[0])
    this.states.set(
      scopeKey,
      normalizeTabs(tabs, activeKey, 'terminal', state.hiddenSessionIds)
    )
    this.emit()
  }

  /** Removes a session tab and its hidden marker after an explicit removal. */
  removeSession(scopeKey: string, sessionId: string): void {
    const state = this.states.get(scopeKey)
    if (state === undefined) return
    const key = sessionTabKey(sessionId)
    const tabs = state.tabs.filter((tab) => tabKey(tab) !== key)
    const hiddenSessionIds = state.hiddenSessionIds.filter((id) => id !== sessionId)
    if (tabs.length === 0 && hiddenSessionIds.length === 0) {
      this.states.delete(scopeKey)
      this.emit()
      return
    }
    const activeKey =
      state.activeKey !== null && tabs.some((tab) => tabKey(tab) === state.activeKey)
        ? state.activeKey
        : tabs[0] === undefined
          ? null
          : tabKey(tabs[0])
    this.states.set(
      scopeKey,
      normalizeTabs(tabs, activeKey, state.mode, hiddenSessionIds)
    )
    this.emit()
  }

  /** Drops all state for a scope, such as a removed workspace. */
  clearScope(scopeKey: string): void {
    if (!this.states.has(scopeKey)) return
    this.states.delete(scopeKey)
    this.emit()
  }

  /** Reorders a tab into the target's slot (drag and drop). */
  moveTab(scopeKey: string, sourceKey: string, targetKey: string): void {
    const state = this.states.get(scopeKey)
    if (state === undefined) return
    const from = resolveTabKey(sourceKey)
    const to = resolveTabKey(targetKey)
    const keys = state.tabs.map(tabKey)
    const order = moveTabKey(keys, from, to)
    if (order.every((key, index) => key === keys[index])) return
    const byKey = new Map(state.tabs.map((tab) => [tabKey(tab), tab]))
    const tabs = order.flatMap((key) => {
      const tab = byKey.get(key)
      return tab === undefined ? [] : [tab]
    })
    this.states.set(scopeKey, { ...state, tabs })
    this.emit()
  }

  /** Reconciles session tabs against the live session list. Existing session
   * tabs keep their positions; missing visible sessions append in list order.
   * Hidden sessions stay hidden until `showSession`.
   */
  syncSessions(scopeKey: string, sessionIds: readonly string[]): void {
    const state = this.get(scopeKey)
    const live = new Set(sessionIds)
    const hiddenSessionIds = state.hiddenSessionIds.filter((id) => live.has(id))
    const present = new Set<string>()
    const tabs: CenterTab[] = []
    for (const tab of state.tabs) {
      if (tab.kind !== 'session') {
        tabs.push(tab)
        continue
      }
      if (!live.has(tab.sessionId) || present.has(tab.sessionId)) continue
      present.add(tab.sessionId)
      tabs.push(tab)
    }
    for (const sessionId of sessionIds) {
      if (present.has(sessionId) || hiddenSessionIds.includes(sessionId)) continue
      present.add(sessionId)
      tabs.push({
        kind: 'session',
        preview: false,
        key: sessionTabKey(sessionId),
        sessionId
      })
    }
    if (tabs.length === 0 && hiddenSessionIds.length === 0) {
      if (this.states.delete(scopeKey)) this.emit()
      return
    }
    const activeKey =
      state.activeKey === null
        ? null
        : tabs.some((tab) => tabKey(tab) === state.activeKey)
          ? state.activeKey
          : tabs[0] === undefined
            ? null
            : tabKey(tabs[0])
    const next = normalizeTabs(tabs, activeKey, state.mode, hiddenSessionIds)
    if (sameState(state, next)) return
    this.states.set(scopeKey, next)
    this.emit()
  }

  /** Reopens a hidden session tab and focuses it. */
  showSession(scopeKey: string, sessionId: string): void {
    const state = this.get(scopeKey)
    const key = sessionTabKey(sessionId)
    const hiddenSessionIds = state.hiddenSessionIds.filter((id) => id !== sessionId)
    const exists = state.tabs.some((tab) => tabKey(tab) === key)
    const tabs: CenterTab[] = exists
      ? state.tabs
      : [
          ...state.tabs,
          {
            kind: 'session',
            preview: false,
            key,
            sessionId
          }
        ]
    this.states.set(scopeKey, normalizeTabs(tabs, key, 'editor', hiddenSessionIds))
    this.emit()
  }

  /** Hides a session tab without stopping the session. */
  hideSession(scopeKey: string, sessionId: string): void {
    const state = this.get(scopeKey)
    const key = sessionTabKey(sessionId)
    const index = state.tabs.findIndex((tab) => tabKey(tab) === key)
    const hiddenSessionIds = state.hiddenSessionIds.includes(sessionId)
      ? state.hiddenSessionIds
      : [...state.hiddenSessionIds, sessionId]
    const tabs = index === -1 ? state.tabs : state.tabs.filter((_, position) => position !== index)
    if (tabs.length === 0 && hiddenSessionIds.length === 0) {
      this.states.delete(scopeKey)
      this.emit()
      return
    }
    const wasActive = state.activeKey === key
    const fallback = tabs[Math.min(index, tabs.length - 1)]
    const nextActive = wasActive
      ? (fallback === undefined ? null : tabKey(fallback))
      : state.activeKey
    this.states.set(
      scopeKey,
      normalizeTabs(tabs, nextActive, wasActive ? 'editor' : state.mode, hiddenSessionIds)
    )
    this.emit()
  }

  retain(scopeKeys: ReadonlySet<string>): void {
    this.retained = scopeKeys
    // Legacy session-keyed state is mapped by `migrateLegacy`; pruning it now
    // would drop the very buffers the migration is about to move.
    if (!this.migrated) return
    let changed = false
    for (const scopeKey of [...this.states.keys()]) {
      if (scopeKeys.has(scopeKey)) continue
      this.states.delete(scopeKey)
      changed = true
    }
    if (changed) this.emit()
  }

  dirtyTabs(scopeKey: string): FileTab[] {
    return fileTabs(this.get(scopeKey)).filter(isDirty)
  }

  dirtyCount(scopeKey: string): number {
    return this.dirtyTabs(scopeKey).length
  }

  allDirtyTabs(): DirtyBufferTab[] {
    const result: DirtyBufferTab[] = []
    for (const [scopeKey, state] of this.states) {
      for (const tab of fileTabs(state)) {
        if (!isDirty(tab)) continue
        result.push({
          scopeKey,
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

  /** Fields keep the `sessions` name for the existing close-guard dialog copy. */
  dirtySummary(): { files: number; sessions: number } {
    const scopes = new Set<string>()
    let files = 0
    for (const [scopeKey, state] of this.states) {
      for (const tab of fileTabs(state)) {
        if (!isDirty(tab)) continue
        files += 1
        scopes.add(scopeKey)
      }
    }
    return { files, sessions: scopes.size }
  }

  private update(
    scopeKey: string,
    path: string,
    updater: (tab: FileTab) => FileTab
  ): void {
    const state = this.get(scopeKey)
    const next = replaceTab(state, path, updater)
    if (next === state) return
    this.states.set(scopeKey, next)
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

export function useSessionFiles(scopeKey: string): FilesSessionState {
  const subscribe = useCallback((listener: () => void) => openFilesStore.subscribe(listener), [])
  const getSnapshot = useCallback(() => openFilesStore.get(scopeKey), [scopeKey])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useFilesDirtyCount(scopeKey: string): number {
  const subscribe = useCallback((listener: () => void) => openFilesStore.subscribe(listener), [])
  const getSnapshot = useCallback(
    () => openFilesStore.dirtyCount(scopeKey),
    [scopeKey]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

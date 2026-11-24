import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { callApi, errorNotice } from '../lib/api'
import type {
  FileContentPayload,
  FilesStatPayload,
  FilesWritePayload,
  GitFileAtRevisionPayload
} from '../../../shared/icode-api'
import { translate, translatePlural } from '../i18n/i18n-store'
import { clearWorktreeFileIndex } from './file-index'
import { parentPathOf } from './file-paths'
import { isGitMetadata, unavailableText } from './search-utils'
import {
  isDirty,
  openFilesStore,
  type CenterMode,
  type FilesSessionState,
  type OpenFileTab
} from './open-files'
import type { SelectionState } from './selection'
import type { Notice } from '../state/workspace'

export type EditorMode = 'tab' | 'folder'
export type UnsavedPrompt = { kind: 'single'; path: string } | { kind: 'all' }
export type ConflictPrompt = {
  path: string
  currentEtag?: string
  detail: string
}

/**
 * File-tab editor state shared by the TaskWorkbench Files panel and the
 * session center. The tree callbacks are optional: the center host has no tree
 * of its own, so reveal/selection/decorations are supplied only by the
 * `FilesPanel` composition. Diff tabs carry no buffer and are closed without a
 * prompt.
 */
export function useSessionEditor(input: {
  sessionId: string
  refreshToken: number
  notify: (notice: Notice) => void
  sessionFiles: FilesSessionState
  tabs: OpenFileTab[]
  activeTab: OpenFileTab | null
  /**
   * False for the inspector's tree-only composition: it must not re-read tabs,
   * consume the hot-exit warning, or chase the active tab while the center owns
   * the editor.
   */
  enabled?: boolean
  revealPath?: (path: string) => Promise<void>
  setSelection?: Dispatch<SetStateAction<SelectionState>>
  selectOnly?: (path: string) => void
  loadDirectory?: (
    path: string,
    quiet?: boolean,
    chainDepth?: number,
    allowFanout?: boolean
  ) => Promise<void>
  scheduleDecorationsRef?: MutableRefObject<((delay?: number) => void) | null>
}) {
  const {
    sessionId,
    refreshToken,
    notify,
    sessionFiles,
    tabs,
    activeTab,
    enabled = true,
    revealPath,
    setSelection,
    selectOnly,
    loadDirectory,
    scheduleDecorationsRef
  } = input

  const [fileNote, setFileNote] = useState('')
  const [gotoLine, setGotoLine] = useState<number | null>(null)
  const [editorMode, setEditorMode] = useState<EditorMode>('tab')
  const [hotExitNote, setHotExitNote] = useState('')
  const [unsaved, setUnsaved] = useState<UnsavedPrompt | null>(null)
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [closeAfterSave, setCloseAfterSave] = useState<string | null>(null)
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const revealSequence = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const warning = openFilesStore.takeHotExitWarning()
    if (warning !== null) setHotExitNote(warning)
  }, [enabled])

  const reloadFromDisk = useCallback(
    async (path: string, quiet = false): Promise<boolean> => {
      const result = await callApi<FileContentPayload>(
        window.icode.files.read({ sessionId, path })
      )
      if (openFilesStore.find(sessionId, path) === null) return false
      if (!result.ok) {
        if (!quiet) notify(errorNotice(result.error))
        return false
      }
      const value = result.value
      if (value.status === 'unavailable') {
        if (value.reason === 'not-found') {
          openFilesStore.markDiskDeleted(sessionId, path)
          return false
        }
        if (!quiet) notify({ tone: 'error', message: unavailableText(value) })
        return false
      }
      if (value.binary) {
        openFilesStore.setFailure(sessionId, path, translate('files.binary'))
        return false
      }
      if (value.tooLarge) {
        openFilesStore.setFailure(sessionId, path, translate('files.tooLarge'))
        return false
      }
      openFilesStore.setContent(sessionId, path, { text: value.text, etag: value.etag })
      return true
    },
    [notify, sessionId]
  )

  /*
   * A refresh (the workspace action, or a completed search replace) re-reads
   * clean editor tabs, so the Files pane never keeps showing pre-replace text.
   * Dirty tabs are deliberately left alone; their conflict dialog explains the
   * change.
   */
  const reloadFromDiskRef = useRef(reloadFromDisk)
  reloadFromDiskRef.current = reloadFromDisk
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  useEffect(() => {
    if (!enabled) return
    for (const tab of tabsRef.current) {
      if (tab.load === 'ready' && !isDirty(tab)) void reloadFromDiskRef.current(tab.path, true)
    }
  }, [enabled, refreshToken])

  const openFile = useCallback(
    async (path: string, line = 1, options?: { preview?: boolean }): Promise<void> => {
      setFileNote('')
      setEditorMode('tab')
      if (isGitMetadata(path)) {
        setFileNote(translate('files.gitMetadataReadOnly'))
        return
      }
      setGotoLine(line)
      const sequence = ++revealSequence.current
      if (revealPath !== undefined) {
        void revealPath(path).then(() => {
          if (revealSequence.current !== sequence) return
          if (openFilesStore.find(sessionId, path) === null) return
          setSelection?.({ selected: new Set([path]), anchor: path, focused: path })
        })
      }
      const opened = openFilesStore.open(sessionId, path, {
        preview: options?.preview === true
      })
      if (!opened.created) {
        if (opened.tab.load === 'ready' || opened.tab.load === 'loading') return
        // A failed tab is retried by opening it again.
      }
      openFilesStore.setLoading(sessionId, path)
      const result = await callApi<FileContentPayload>(
        window.icode.files.read({ sessionId, path })
      )
      if (openFilesStore.find(sessionId, path) === null) return
      if (!result.ok) {
        openFilesStore.setFailure(sessionId, path, result.error.message)
        return
      }
      const value = result.value
      if (value.status === 'unavailable') {
        openFilesStore.setFailure(sessionId, path, unavailableText(value))
        return
      }
      if (value.binary) {
        openFilesStore.setFailure(sessionId, path, translate('files.binary'))
        return
      }
      if (value.tooLarge) {
        openFilesStore.setFailure(sessionId, path, translate('files.tooLarge'))
        return
      }
      if (!openFilesStore.canStore(sessionId, path, value.text.length)) {
        openFilesStore.setFailure(sessionId, path, translate('files.budget'))
        return
      }
      openFilesStore.setContent(sessionId, path, { text: value.text, etag: value.etag })
      void callApi<GitFileAtRevisionPayload>(
        window.icode.git.fileAtRevision({ sessionId, rev: 'HEAD', path })
      ).then((baseline) => {
        if (openFilesStore.find(sessionId, path) === null) return
        const original =
          baseline.ok &&
          baseline.value.status === 'ok' &&
          !baseline.value.binary &&
          !baseline.value.tooLarge
            ? baseline.value.text
            : null
        openFilesStore.setOriginal(sessionId, path, original)
      })
    },
    [revealPath, sessionId, setSelection]
  )

  const loadTab = useCallback(
    (path: string, line: number): Promise<void> => openFile(path, line),
    [openFile]
  )

  const activateTab = (key: string): void => {
    openFilesStore.setActiveKey(sessionId, key)
    if (openFilesStore.find(sessionId, key) !== null) {
      setSelection?.({ selected: new Set([key]), anchor: key, focused: key })
      setEditorMode('tab')
    }
    setGotoLine(null)
  }

  const setActiveTab = (path: string): void => activateTab(path)

  useEffect(() => {
    if (!enabled || sessionFiles.activePath === null) return
    tabRefs.current
      .get(sessionFiles.activePath)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [enabled, sessionFiles.activePath])

  const saveTabAt = async (
    path: string,
    expectedEtag: string | null | undefined = undefined,
    announce = true
  ): Promise<boolean> => {
    const tab = openFilesStore.find(sessionId, path)
    if (tab === null || tab.load !== 'ready') return false
    const result = await callApi<FilesWritePayload>(
      window.icode.files.write({
        sessionId,
        path,
        text: tab.text,
        expectedEtag: expectedEtag === undefined ? tab.etag : expectedEtag
      })
    )
    if (!result.ok) {
      if (announce) notify(errorNotice(result.error))
      return false
    }
    if (result.value.status === 'unavailable') {
      if (result.value.reason === 'changed-on-disk') {
        setConflict({
          path,
          ...(result.value.currentEtag === undefined
            ? {}
            : { currentEtag: result.value.currentEtag }),
          detail: result.value.detail
        })
        return false
      }
      if (announce) notify({ tone: 'error', message: unavailableText(result.value) })
      return false
    }
    openFilesStore.markSaved(sessionId, path, result.value.etag)
    clearWorktreeFileIndex(sessionId)
    if (loadDirectory !== undefined) {
      void loadDirectory(parentPathOf(path), true, 0, false)
    }
    scheduleDecorationsRef?.current?.(0)
    if (announce) notify({ tone: 'success', message: translate('files.notice.saved', { path }) })
    return true
  }

  const saveActive = async (): Promise<void> => {
    if (activeTab !== null) await saveTabAt(activeTab.path)
  }

  const saveAllTabs = async (): Promise<void> => {
    const dirty = openFilesStore.dirtyTabs(sessionId)
    if (dirty.length === 0) return
    for (const tab of dirty) {
      const ok = await saveTabAt(tab.path, undefined, false)
      if (!ok) {
        openFilesStore.setActive(sessionId, tab.path)
        selectOnly?.(tab.path)
        setEditorMode('tab')
        return
      }
    }
    notify({ tone: 'success', message: translatePlural('files.notice.savedMany', dirty.length) })
  }

  /**
   * “Keep mine” adopts the current disk version without replacing the buffer.
   * The next save then intentionally overwrites the version the user saw.
   */
  const keepMine = async (path: string): Promise<void> => {
    const stat = await callApi<FilesStatPayload>(
      window.icode.files.stat({ sessionId, path })
    )
    if (!stat.ok) {
      notify(errorNotice(stat.error))
      return
    }
    if (stat.value.status === 'unavailable') {
      notify({ tone: 'error', message: unavailableText(stat.value) })
      return
    }
    if (stat.value.etag === null) return
    openFilesStore.adoptDiskVersion(sessionId, path, stat.value.etag)
  }

  /**
   * Closes a file or diff tab. A dirty file asks first; a diff tab is a
   * read-only projection and closes immediately.
   */
  const requestClose = (keyOrPath: string): void => {
    const tab = openFilesStore.find(sessionId, keyOrPath)
    if (tab === null) {
      openFilesStore.closeTab(sessionId, keyOrPath)
      setGotoLine(null)
      return
    }
    if (isDirty(tab)) {
      setUnsaved({ kind: 'single', path: keyOrPath })
      return
    }
    openFilesStore.closeTab(sessionId, keyOrPath)
    setGotoLine(null)
  }

  const closeCenterTab = requestClose

  /** Keeps a preview tab open (double click, typing, or a diff action). */
  const pin = (keyOrPath: string): void => {
    openFilesStore.pin(sessionId, keyOrPath)
  }

  const setMode = (mode: CenterMode): void => {
    openFilesStore.setMode(sessionId, mode)
  }

  /** The editor applied a goto-line request; clear it so it cannot replay. */
  const onGotoLineConsumed = (): void => {
    setGotoLine(null)
  }

  const requestCloseAll = (): void => {
    if (openFilesStore.get(sessionId).tabs.length === 0) return
    if (openFilesStore.dirtyCount(sessionId) > 0) {
      setUnsaved({ kind: 'all' })
      return
    }
    openFilesStore.closeAll(sessionId)
    setGotoLine(null)
    setEditorMode('tab')
  }

  const closeAfterSaveIfNeeded = (path: string): void => {
    if (closeAfterSave !== path) return
    openFilesStore.closeTab(sessionId, path)
    setCloseAfterSave(null)
    setGotoLine(null)
  }

  const confirmUnsavedSave = async (): Promise<void> => {
    if (unsaved === null) return
    setDialogBusy(true)
    if (unsaved.kind === 'single') {
      setCloseAfterSave(unsaved.path)
      const ok = await saveTabAt(unsaved.path, undefined, false)
      setDialogBusy(false)
      setUnsaved(null)
      if (ok) closeAfterSaveIfNeeded(unsaved.path)
      return
    }
    setUnsaved(null)
    const dirty = openFilesStore.dirtyTabs(sessionId)
    for (const tab of dirty) {
      const ok = await saveTabAt(tab.path, undefined, false)
      if (!ok) {
        setDialogBusy(false)
        openFilesStore.setActive(sessionId, tab.path)
        selectOnly?.(tab.path)
        setEditorMode('tab')
        return
      }
    }
    setDialogBusy(false)
    openFilesStore.closeAll(sessionId)
    setGotoLine(null)
    setEditorMode('tab')
    notify({ tone: 'success', message: translatePlural('files.notice.savedMany', dirty.length) })
  }

  const confirmUnsavedDiscard = (): void => {
    if (unsaved === null) return
    if (unsaved.kind === 'single') {
      openFilesStore.closeTab(sessionId, unsaved.path)
    } else {
      openFilesStore.closeAll(sessionId)
    }
    setGotoLine(null)
    setEditorMode('tab')
    setUnsaved(null)
    setCloseAfterSave(null)
  }

  const resolveConflictOverwrite = async (): Promise<void> => {
    if (conflict === null) return
    setDialogBusy(true)
    const ok = await saveTabAt(conflict.path, conflict.currentEtag ?? null, false)
    setDialogBusy(false)
    if (!ok) return
    setConflict(null)
    closeAfterSaveIfNeeded(conflict.path)
    notify({ tone: 'success', message: translate('files.notice.saved', { path: conflict.path }) })
  }

  const resolveConflictReload = async (): Promise<void> => {
    if (conflict === null) return
    const path = conflict.path
    setDialogBusy(true)
    const ok = await reloadFromDisk(path)
    setDialogBusy(false)
    setConflict(null)
    if (!ok) return
    closeAfterSaveIfNeeded(path)
  }

  const cancelConflict = (): void => {
    setConflict(null)
    setCloseAfterSave(null)
  }

  const focusTab = (index: number): void => {
    const path = tabs[index]?.path
    if (path === undefined) return
    tabRefs.current.get(path)?.focus()
  }

  const onTabKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    index: number,
    path: string
  ): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const delta = event.key === 'ArrowRight' ? 1 : -1
      const next = (index + delta + tabs.length) % tabs.length
      focusTab(next)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusTab(event.key === 'Home' ? 0 : tabs.length - 1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setActiveTab(path)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      requestClose(path)
    }
  }

  return {
    fileNote,
    setFileNote,
    gotoLine,
    setGotoLine,
    onGotoLineConsumed,
    editorMode,
    setEditorMode,
    hotExitNote,
    setHotExitNote,
    unsaved,
    setUnsaved,
    conflict,
    setConflict,
    dialogBusy,
    setDialogBusy,
    setCloseAfterSave,
    tabRefs,
    reloadFromDisk,
    loadTab,
    openFile,
    setActiveTab,
    activateTab,
    pin,
    setMode,
    closeCenterTab,
    saveTabAt,
    saveActive,
    saveAllTabs,
    keepMine,
    requestClose,
    requestCloseAll,
    confirmUnsavedSave,
    confirmUnsavedDiscard,
    resolveConflictOverwrite,
    resolveConflictReload,
    cancelConflict,
    onTabKeyDown
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ClipboardPaste,
  Copy,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  History,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  Save,
  Scissors,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { callApi } from '../lib/api'
import { shortcutLabel } from '../lib/platform'
import type { FilesMutatePayload } from '../../../shared/icode-api'
import type { FileEntry } from '../../../shared/domain/workspace-files'
import { clearWorktreeFileIndex } from '../files/file-index'
import { EMPTY_DECORATIONS } from '../files/file-decorations'
import { basenameOf, isUnder, parentPathOf } from '../files/file-paths'
import { filesMenuEntries, type FilesMenuReason } from '../files/files-menu'
import { useFilesDecorations, useFilesWatch } from '../files/use-files-live'
import { useFilesLayout } from '../files/use-files-layout'
import { useFilesOperations } from '../files/use-files-operations'
import { useFilesTabs } from '../files/use-files-tabs'
import { useFilesTree } from '../files/use-files-tree'
import { useFilesViewport } from '../files/use-files-viewport'
import { visibleTreeChildren } from '../files/visible-tree'
import { FILES_LIST_WIDTH_DEFAULT, useFilesSettings } from '../files/files-settings'
import { isGitMetadata, unavailableText } from '../files/search-utils'
import { translate } from '../i18n/i18n-store'
import { useT, useTp } from '../i18n/use-i18n'
import { buildTreeRows } from '../files/tree-layout'
import { isDirty, openFilesStore, useSessionFiles } from '../files/open-files'
import {
  EMPTY_SELECTION,
  collapseSelectedPaths,
  pruneSelection,
  selectAll,
  selectRow,
  summarizeSelection,
  type TreeRow
} from '../files/selection'
import { checkEntryName, nameSelectionRange } from '../files/name-validation'
import { filesClipboardStore, useFilesClipboard } from '../files/files-clipboard'
import { peekUndo, undoLabel } from '../files/undo-stack'
import { computeVirtualWindow, FILES_ROW_HEIGHT } from '../files/virtual-window'
import { loadTreeState, saveTreeState } from '../files/tree-state'
import type { Notice } from '../state/workspace'
import CodeEditor from './CodeEditor'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import {
  DeleteFilesDialog,
  MoveFilesDialog,
  SaveConflictDialog,
  UnsavedFilesDialog
} from './FilesDialogs'

export type FilesPanelProps = {
  sessionId: string
  /** Bumped when the user asks for a refresh of the whole workspace. */
  refreshToken: number
  /** True while Files is the visible view; controls the watcher/polling. */
  active: boolean
  notify: (notice: Notice) => void
  /** A file to open at a line, requested from search / quick open. */
  openRequest: { path: string; line: number; nonce: number } | null
  onOpenRequestHandled: () => void
  /** Opens Source Control History filtered to the open file. */
  onOpenHistory?: (path: string) => void
  /** `monaco` opts into the bundled editor; the default keeps the textarea. */
  editorEngine?: 'monaco' | 'plain'
}

/** The row-level inline editor for create and rename. */
type InlineEdit =
  | { kind: 'rename'; path: string; initial: string }
  | { kind: 'create-file'; parent: string }
  | { kind: 'create-directory'; parent: string }

type ContextTarget =
  | { kind: 'file'; path: string }
  | { kind: 'directory'; path: string }
  | { kind: 'root'; path: '' }

type ContextState = {
  x: number
  y: number
  target: ContextTarget
}

/**
 * Files, open-file tabs, editor and search for one session's worktree.
 *
 * The panel owns no file paths of its own: every call is scoped by `sessionId`,
 * and the open tabs live in a session-keyed store so switching sessions or
 * workbench tabs never drops unsaved text.
 */
export default function FilesPanel({
  sessionId,
  refreshToken,
  active,
  notify,
  openRequest,
  onOpenRequestHandled,
  onOpenHistory,
  editorEngine = 'plain'
}: FilesPanelProps): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const sessionFiles = useSessionFiles(sessionId)
  const settings = useFilesSettings()
  const tabs = sessionFiles.tabs
  const activeTab =
    sessionFiles.activePath === null
      ? null
      : (tabs.find((tab) => tab.path === sessionFiles.activePath) ?? null)
  const dirtyCount = tabs.reduce((count, tab) => (isDirty(tab) ? count + 1 : count), 0)

  const {
    tree,
    setTree,
    rootState,
    setRootState,
    rootNote,
    setRootNote,
    selection,
    setSelection,
    collapsedNested,
    setCollapsedNested,
    ignoredByDirectory,
    setIgnoredByDirectory,
    ignoreNote,
    setIgnoreNote,
    preloadedDirectories,
    treeGeneration,
    rootStateRef,
    revealPathRef,
    loadDirectory,
    revealPath,
    findEntry,
    siblingsOf,
    selectedPaths,
    createParent,
    selectOnly,
    expandFolder
  } = useFilesTree({ sessionId, refreshToken, settings, notify })
  const [edit, setEdit] = useState<InlineEdit | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [editWarning, setEditWarning] = useState<string | null>(null)
  const [context, setContext] = useState<ContextState | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /*
   * Master–detail, the way Termio's inspector works: the tree is the list and
   * the open file is the detail. The detail sits beside the tree only when the
   * panel can carry both columns; otherwise it covers the tree, which stays
   * mounted underneath so expansion and scroll survive. `detailDismissed` is
   * the narrow layout's way back to the tree without closing the tab.
   */
  const detailOpen = activeTab !== null
  const {
    panelRef,
    listRef,
    listWidthRef,
    effectiveListWidth,
    listHidden,
    setListHidden,
    setDetailDismissed,
    detailMaximized,
    setDetailMaximized,
    detailVisible,
    twoColumnAvailable,
    twoColumn,
    persistListWidth,
    handleProps
  } = useFilesLayout({ active, detailOpen, settings })

  const visibleChildren = useMemo(
    () =>
      visibleTreeChildren(
        tree.children,
        settings.exclude,
        settings.excludeGitIgnore,
        ignoredByDirectory
      ),
    [ignoredByDirectory, settings.exclude, settings.excludeGitIgnore, tree.children]
  )
  const rows = useMemo(
    () =>
      buildTreeRows(visibleChildren, tree.expanded, {
        sort: { order: settings.sortOrder, direction: settings.sortDirection },
        compactFolders: settings.compactFolders,
        fileNesting: settings.fileNesting,
        nestingPatterns: settings.nestingPatterns,
        collapsedNested
      }),
    [
      collapsedNested,
      settings.compactFolders,
      settings.fileNesting,
      settings.sortDirection,
      settings.sortOrder,
      tree.expanded,
      visibleChildren
    ]
  )
  const clipboard = useFilesClipboard()
  const clipboardHere = clipboard !== null && clipboard.sessionId === sessionId

  const {
    treeScrollRef,
    rowsContainerRef,
    rowRefs,
    rowsRef,
    viewport,
    setViewport,
    restoreScroll,
    scrollRowIndexIntoView,
    focusRowElement
  } = useFilesViewport(rows)
  const editInput = useRef<HTMLInputElement | null>(null)
  const ignoreEditBlur = useRef(false)
  const typeahead = useRef<{ text: string; at: number } | null>(null)
  const dragExpandTimer = useRef<number | null>(null)
  const dragExpandPath = useRef<string | null>(null)
  const draggingPaths = useRef<string[]>([])
  const reloadExpandedRef = useRef<
    (quiet?: boolean, discover?: boolean) => Promise<void>
  >(async () => undefined)


  // A different session means a different checkout: reset the tree and the
  // panel-local surfaces. Open tabs are session-keyed and deliberately survive.
  useEffect(() => {
    // The new session's open tabs are its own; never inherit the previous
    // session's dismissed or maximized detail.
    setDetailDismissed(false)
    setDetailMaximized(false)
    setListHidden(false)
    const persisted = loadTreeState(sessionId)
    const expanded: Record<string, boolean> = { '': true }
    for (const path of persisted?.expanded ?? []) {
      if (path !== '') expanded[path] = true
    }
    setTree({ expanded, children: {}, loading: {} })
    setIgnoredByDirectory({})
    setIgnoreNote('')
    setDecorations(EMPTY_DECORATIONS)
    setCollapsedNested(new Set())
    preloadedDirectories.current.clear()
    setRootState('loading')
    setRootNote('')
    setFileNote('')
    setGotoLine(null)
    setUndoStack([])
    setUndoing(false)
    setTrashBanner(null)
    const activePath = openFilesStore.get(sessionId).activePath
    setSelection(
      activePath === null
        ? EMPTY_SELECTION
        : { selected: new Set([activePath]), anchor: activePath, focused: activePath }
    )
    setEditorMode('tab')
    setEdit(null)
    setEditValue('')
    setEditError(null)
    setEditWarning(null)
    setContext(null)
    setDeletePrompt(null)
    setMovePrompt(null)
    setDropTarget(null)
    setUnsaved(null)
    setConflict(null)
    setDialogBusy(false)
    setCloseAfterSave(null)
    restoreScroll.current = persisted?.scrollTop ?? null
    const pendingSelection = persisted
    const generation = treeGeneration.current
    void (async () => {
      await loadDirectory('')
      const paths = (pendingSelection?.expanded ?? []).filter((path) => path !== '')
      for (let index = 0; index < paths.length; index += 8) {
        if (treeGeneration.current !== generation) return
        await Promise.all(
          paths
            .slice(index, index + 8)
            .map((path) => loadDirectory(path, true, 0, false))
        )
      }
      if (treeGeneration.current !== generation) return
      if (pendingSelection !== null) {
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
        })
        if (treeGeneration.current !== generation) return
        setSelection({
          selected: new Set(pendingSelection.selected),
          anchor: pendingSelection.anchor,
          focused: pendingSelection.focused
        })
        restoreScroll.current = pendingSelection.scrollTop
      }
    })()
    void refreshTrash()
  }, [loadDirectory, sessionId, refreshToken])

  // Persist the explorer position after the user stops moving for a moment.
  useEffect(() => {
    if (rootState !== 'ready') return
    const timer = window.setTimeout(() => {
      saveTreeState(sessionId, {
        expanded: Object.keys(tree.expanded).filter(
          (path) => path !== '' && tree.expanded[path] === true
        ),
        focused: selection.focused,
        selected: [...selection.selected],
        anchor: selection.anchor,
        scrollTop: viewport.scrollTop
      })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [rootState, selection, sessionId, tree.expanded, viewport.scrollTop])

  // A restored scrollTop can only be applied once rows and their heights exist.
  useEffect(() => {
    if (restoreScroll.current === null || rootState !== 'ready') return
    const element = treeScrollRef.current
    if (element === null) return
    element.scrollTop = restoreScroll.current
    restoreScroll.current = null
  }, [rootState, rows])

  // A refresh may remove rows the selection still names.
  useEffect(() => {
    setSelection((current) => pruneSelection(current, rows))
  }, [rows])

  const reloadExpanded = useCallback(
    async (quiet = false, discover = false): Promise<void> => {
      const paths = new Set(
        Object.keys(tree.expanded).filter((path) => tree.expanded[path] === true)
      )
      // Watcher reconciles stay bounded to what is on screen; a manual refresh
      // also refreshes the listings that exist only to label compact chains.
      if (!quiet) {
        for (const path of preloadedDirectories.current) paths.add(path)
      }
      await Promise.all(
        [...paths].map((path) => loadDirectory(path, quiet, 0, discover))
      )
      scheduleDecorationsRef.current?.()
    },
    [loadDirectory, tree.expanded]
  )
  reloadExpandedRef.current = reloadExpanded

  const { decorations, setDecorations, scheduleDecorationsRef } = useFilesDecorations({
    sessionId,
    active,
    gitDecorations: settings.gitDecorations
  })

  // Toggling .gitignore filtering re-checks the directories already on screen;
  // disabling it drops the cached answers instead of leaving hidden rows.
  const gitIgnoreWasEnabled = useRef(settings.excludeGitIgnore)
  useEffect(() => {
    const changed = gitIgnoreWasEnabled.current !== settings.excludeGitIgnore
    gitIgnoreWasEnabled.current = settings.excludeGitIgnore
    if (!settings.excludeGitIgnore) {
      if (changed) {
        setIgnoredByDirectory({})
        setIgnoreNote('')
      }
      return
    }
    if (!active) return
    if (!changed && Object.keys(ignoredByDirectory).length > 0) return
    void reloadExpandedRef.current?.(true)
  }, [active, ignoredByDirectory, settings.excludeGitIgnore])

  // Turning compact folders on discovers the chains under loaded directories;
  // turning it off stops refreshing listings that only existed for labels.
  const compactWasEnabled = useRef(settings.compactFolders)
  useEffect(() => {
    const changed = compactWasEnabled.current !== settings.compactFolders
    compactWasEnabled.current = settings.compactFolders
    if (!changed) return
    if (!settings.compactFolders) {
      preloadedDirectories.current.clear()
      return
    }
    void reloadExpandedRef.current?.(true, true)
  }, [settings.compactFolders])

  const {
    fileNote,
    setFileNote,
    gotoLine,
    setGotoLine,
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
    setActiveTab,
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
  } = useFilesTabs({
    sessionId,
    refreshToken,
    notify,
    sessionFiles,
    tabs,
    activeTab,
    revealPath,
    setSelection,
    selectOnly,
    loadDirectory,
    scheduleDecorationsRef
  })

  /** Expands the ancestors of a file so opening it always reveals its row. */
  // Auto-reveal scrolls the tree to the active tab when Files opens or the
  // active tab changes. It expands ancestors first, then waits for the rows to
  // render; watcher reloads do not retrigger it because only these inputs do.
  useEffect(() => {
    if (!active || !settings.autoReveal) return
    const path = sessionFiles.activePath
    if (path === null) return
    let cancelled = false
    let attempts = 0
    let timer: number | null = null
    const scroll = (): void => {
      if (cancelled) return
      const index = rowsRef.current.findIndex((row) => row.entry.path === path)
      if (index !== -1) {
        scrollRowIndexIntoView(index)
        setSelection({ selected: new Set([path]), anchor: path, focused: path })
        focusRowElement(path)
        return
      }
      attempts += 1
      if (attempts < 20) timer = window.setTimeout(scroll, 50)
    }
    void revealPathRef.current?.(path).then(() => {
      if (!cancelled) timer = window.setTimeout(scroll, 0)
    })
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [active, sessionFiles.activePath, settings.autoReveal])

  const openPath = useCallback(
    async (path: string, line = 1): Promise<void> => {
      setDetailDismissed(false)
      setFileNote('')
      if (isGitMetadata(path)) {
        setEditorMode('tab')
        setFileNote(translate('files.gitMetadataReadOnly'))
        return
      }
      await loadTab(path, line)
    },
    [loadTab]
  )

  // A request from search or quick open selects the file and reveals the line.
  useEffect(() => {
    if (!openRequest) return
    void openPath(openRequest.path, openRequest.line)
    onOpenRequestHandled()
  }, [onOpenRequestHandled, openPath, openRequest])

  const { liveState } = useFilesWatch({
    sessionId,
    active,
    rootStateRef,
    reloadExpandedRef
  })

  const beginCreate = (kind: 'create-file' | 'create-directory', parent: string): void => {
    ignoreEditBlur.current = false
    setEdit({ kind, parent })
    setEditValue('')
    setEditError(null)
    setEditWarning(null)
    if (parent !== '') {
      setTree((current) => ({
        ...current,
        expanded: { ...current.expanded, [parent]: true }
      }))
      if (tree.children[parent] === undefined) void loadDirectory(parent)
    }
    window.requestAnimationFrame(() => editInput.current?.focus())
  }

  const beginRename = (path: string): void => {
    const entry = findEntry(path)
    if (entry === null || isGitMetadata(path)) return
    ignoreEditBlur.current = false
    setEdit({ kind: 'rename', path, initial: entry.name })
    setEditValue(entry.name)
    setEditError(null)
    setEditWarning(null)
    window.requestAnimationFrame(() => {
      const input = editInput.current
      if (input === null) return
      input.focus()
      const [start, end] = nameSelectionRange(entry.name, entry.kind === 'directory')
      input.setSelectionRange(start, end)
    })
  }

  const cancelEdit = (): void => {
    ignoreEditBlur.current = true
    setEdit(null)
    setEditValue('')
    setEditError(null)
    setEditWarning(null)
  }

  const commitEdit = async (): Promise<void> => {
    if (edit === null) return
    const value = editValue
    const parent = edit.kind === 'rename' ? parentPathOf(edit.path) : edit.parent
    const previousName = edit.kind === 'rename' ? basenameOf(edit.path) : undefined
    const check = checkEntryName(value, {
      siblings: siblingsOf(parent),
      ...(previousName === undefined ? {} : { previousName })
    })
    setEditWarning(check.warning)
    if (check.error !== null) {
      setEditError(check.error)
      return
    }
    setEditError(null)

    if (edit.kind === 'rename') {
      if (value === edit.initial) {
        cancelEdit()
        return
      }
      const to = parent === '' ? value : `${parent}/${value}`
      if (isGitMetadata(edit.path) || isGitMetadata(to)) {
        setEditError(translate('files.gitMetadataRename'))
        return
      }
      const result = await callApi<FilesMutatePayload>(
        window.icode.files.rename({ sessionId, from: edit.path, to })
      )
      if (!result.ok) {
        setEditError(result.error.message)
        return
      }
      if (result.value.status === 'unavailable') {
        setEditError(unavailableText(result.value))
        return
      }
      openFilesStore.renamePath(sessionId, edit.path, to)
      selectOnly(to)
      cancelEdit()
      pushUndoEntry({ kind: 'rename', from: edit.path, to, at: Date.now() })
      notify({
        tone: 'success',
        message: t('files.notice.renamed', { path: to }),
        action: { label: translate('files.undo'), run: () => void undoLast() }
      })
      clearWorktreeFileIndex(sessionId)
      await reloadExpanded()
      window.requestAnimationFrame(() => {
        const index = rowsRef.current.findIndex((row) => row.entry.path === to)
        if (index !== -1) scrollRowIndexIntoView(index)
        focusRowElement(to)
      })
      return
    }

    const path = edit.parent === '' ? value : `${edit.parent}/${value}`
    if (isGitMetadata(path)) {
      setEditError(translate('files.gitMetadataCreate'))
      return
    }
    const kind = edit.kind === 'create-directory' ? 'directory' : 'file'
    const result = await callApi<FilesMutatePayload>(
      window.icode.files.create({ sessionId, path, kind })
    )
    if (!result.ok) {
      setEditError(result.error.message)
      return
    }
    if (result.value.status === 'unavailable') {
      setEditError(unavailableText(result.value))
      return
    }
    cancelEdit()
    pushUndoEntry({
      kind: 'create',
      path,
      etag: result.value.etag ?? null,
      at: Date.now()
    })
    notify({
      tone: 'success',
      message: `Created ${path}`,
      action: { label: translate('files.undo'), run: () => void undoLast() }
    })
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    if (kind === 'file') {
      await openPath(path, 1)
    } else {
      selectOnly(path)
      setEditorMode('folder')
    }
  }


  const {
    deletePrompt,
    setDeletePrompt,
    movePrompt,
    setMovePrompt,
    undoStack,
    setUndoStack,
    undoing,
    setUndoing,
    trashBanner,
    setTrashBanner,
    transferBusy,
    pushUndoEntry,
    restoreTrashOp,
    confirmPermanentDelete,
    requestDelete,
    confirmDelete,
    undoLast,
    copySelection,
    duplicateSelection,
    copyPathsToClipboard,
    performTransfer,
    pasteInto,
    refreshTrash
  } = useFilesOperations({
    sessionId,
    useTrash: settings.useTrash,
    notify,
    t,
    tp,
    selectedPaths,
    selectOnly,
    setSelection,
    setEditorMode,
    openPath,
    findEntry,
    expandFolder,
    reloadExpanded,
    scheduleDecorationsRef
  })

  const toggleEntry = async (entry: FileEntry): Promise<void> => {
    if (entry.kind === 'file') {
      await openPath(entry.path, 1)
      return
    }
    setFileNote('')
    setEditorMode('folder')
    const isOpen = tree.expanded[entry.path] === true
    setTree((current) => ({
      ...current,
      expanded: { ...current.expanded, [entry.path]: !isOpen }
    }))
    if (!isOpen) await loadDirectory(entry.path)
  }

  const onRowClick = (event: React.MouseEvent<HTMLDivElement>, row: TreeRow): void => {
    const toggle = event.metaKey || event.ctrlKey
    const range = event.shiftKey
    if (toggle || range) {
      const next = selectRow(selection, rows, row.entry.path, { toggle, range })
      setSelection(next)
      if (next.selected.size > 1) {
        setEditorMode('folder')
      } else if (next.selected.size === 1) {
        const only = findEntry(next.selected.values().next().value ?? '')
        setEditorMode(only?.kind === 'directory' ? 'folder' : 'tab')
      }
      return
    }

    setSelection(selectRow(selection, rows, row.entry.path))
    if (row.entry.kind === 'file') setEditorMode('tab')
    else setEditorMode('folder')
    void toggleEntry(row.entry)
  }

  const contextPaths = (target: ContextTarget): string[] => {
    if (target.path === '') return []
    if (selection.selected.has(target.path) && selection.selected.size > 1) {
      return selectedPaths()
    }
    return [target.path]
  }

  const onRowContextMenu = (
    event: React.MouseEvent<HTMLDivElement>,
    row: TreeRow
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    const isSelected = selection.selected.has(row.entry.path)
    const next = isSelected
      ? selection
      : selectRow(EMPTY_SELECTION, rows, row.entry.path)
    if (!isSelected) setSelection(next)
    setEditorMode(next.selected.size > 1 ? 'folder' : row.entry.kind === 'directory' ? 'folder' : 'tab')
    setContext({
      x: event.clientX,
      y: event.clientY,
      target:
        row.entry.kind === 'directory'
          ? { kind: 'directory', path: row.entry.path }
          : { kind: 'file', path: row.entry.path }
    })
  }

  const eventIsInsideRow = (event: React.SyntheticEvent<HTMLDivElement>): boolean =>
    event.target instanceof Element && event.target.closest('[data-testid^="files-entry-"]') !== null

  const onTreeContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (eventIsInsideRow(event)) return
    event.preventDefault()
    setContext({
      x: event.clientX,
      y: event.clientY,
      target: { kind: 'root', path: '' }
    })
  }

  const readDrag = (
    event: React.DragEvent<HTMLDivElement>
  ): { paths: string[] } | null => {
    if (!event.dataTransfer.types.includes('application/x-icode-files')) return null
    try {
      const parsed = JSON.parse(
        event.dataTransfer.getData('application/x-icode-files')
      ) as { sessionId?: unknown; paths?: unknown }
      if (parsed.sessionId !== sessionId || !Array.isArray(parsed.paths)) return null
      const paths = parsed.paths.filter((path): path is string => typeof path === 'string')
      return { paths: collapseSelectedPaths(paths.filter((path) => path !== '')) }
    } catch {
      return null
    }
  }

  const clearDragExpand = (): void => {
    if (dragExpandTimer.current !== null) {
      window.clearTimeout(dragExpandTimer.current)
      dragExpandTimer.current = null
    }
    dragExpandPath.current = null
  }

  const onDragStart = (event: React.DragEvent<HTMLDivElement>, row: TreeRow): void => {
    if (edit !== null) {
      event.preventDefault()
      return
    }
    const paths = selection.selected.has(row.entry.path)
      ? selectedPaths()
      : [row.entry.path]
    if (!selection.selected.has(row.entry.path)) {
      selectOnly(row.entry.path)
    }
    draggingPaths.current = paths
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData(
      'application/x-icode-files',
      JSON.stringify({ sessionId, paths })
    )
    event.dataTransfer.setData('text/plain', paths.join('\n'))
  }

  const onDragEnd = (): void => {
    clearDragExpand()
    setDropTarget(null)
    draggingPaths.current = []
  }

  const onRowDragOver = (
    event: React.DragEvent<HTMLDivElement>,
    row: TreeRow
  ): void => {
    if (row.entry.kind !== 'directory') return
    if (!event.dataTransfer.types.includes('application/x-icode-files')) return
    if (draggingPaths.current.some((path) => isUnder(row.entry.path, path))) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect =
      event.ctrlKey || event.altKey ? 'copy' : 'move'
    setDropTarget(row.entry.path)
    if (tree.expanded[row.entry.path] !== true) {
      if (dragExpandPath.current !== row.entry.path) {
        clearDragExpand()
        dragExpandPath.current = row.entry.path
      }
      if (dragExpandTimer.current === null) {
        dragExpandTimer.current = window.setTimeout(() => {
          dragExpandTimer.current = null
          void expandFolder(row.entry.path)
        }, 600)
      }
    }
  }

  const onRowDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    clearDragExpand()
    setDropTarget(null)
  }

  const dropInto = async (
    event: React.DragEvent<HTMLDivElement>,
    destination: string
  ): Promise<void> => {
    const drag = readDrag(event)
    clearDragExpand()
    setDropTarget(null)
    if (drag === null || drag.paths.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    if (event.ctrlKey || event.altKey) {
      await performTransfer('copy', drag.paths, destination)
      return
    }
    const movable = drag.paths.filter((path) => parentPathOf(path) !== destination)
    if (movable.length === 0) {
      notify({ tone: 'info', message: translate('files.notice.alreadyThere') })
      return
    }
    setMovePrompt({ paths: movable, destination })
  }

  const onRowDrop = (event: React.DragEvent<HTMLDivElement>, row: TreeRow): void => {
    if (row.entry.kind !== 'directory') return
    void dropInto(event, row.entry.path)
  }

  const onTreeDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('application/x-icode-files')) return
    if (eventIsInsideRow(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = event.ctrlKey || event.altKey ? 'copy' : 'move'
    setDropTarget('')
  }

  const onTreeDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (eventIsInsideRow(event)) return
    void dropInto(event, '')
  }

  const focusRow = (index: number): void => {
    const row = rows[index]
    if (row === undefined) return
    setSelection((current) => selectRow(current, rows, row.entry.path))
    scrollRowIndexIntoView(index)
    focusRowElement(row.entry.path)
  }

  const moveFocus = (delta: number, basePath: string | null = selection.focused): void => {
    const current = rows.findIndex((row) => row.entry.path === basePath)
    if (current === -1) {
      focusRow(delta > 0 ? 0 : rows.length - 1)
      return
    }
    focusRow(Math.max(0, Math.min(rows.length - 1, current + delta)))
  }

  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target
    if (
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return
    }
    // Keyboard actions belong to the row that actually has DOM focus. This also
    // keeps F2/arrows working when a refresh has not yet re-selected the focused
    // row after a batch operation.
    const domPath = (() => {
      const active = document.activeElement
      if (!(active instanceof HTMLElement)) return null
      const testId = active.getAttribute('data-testid') ?? ''
      return testId.startsWith('files-entry-')
        ? testId.slice('files-entry-'.length)
        : null
    })()
    const focusPath = domPath ?? selection.focused
    const focusedIndex = rows.findIndex((row) => row.entry.path === focusPath)
    const focusedRow = focusedIndex === -1 ? null : rows[focusedIndex] ?? null

    const handled = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }

    if (event.key === 'ArrowDown') {
      handled()
      moveFocus(1, focusPath)
      return
    }
    if (event.key === 'ArrowUp') {
      handled()
      moveFocus(-1, focusPath)
      return
    }
    if (event.key === 'Home') {
      handled()
      focusRow(0)
      return
    }
    if (event.key === 'End') {
      handled()
      focusRow(rows.length - 1)
      return
    }
    if (event.key === 'ArrowRight') {
      if (focusedRow === null) return
      handled()
      if (focusedRow.entry.kind === 'directory') {
        if (tree.expanded[focusedRow.entry.path] !== true) {
          void expandFolder(focusedRow.entry.path)
        } else {
          focusRow(focusedIndex + 1)
        }
      }
      return
    }
    if (event.key === 'ArrowLeft') {
      if (focusedRow === null) return
      handled()
      if (
        focusedRow.entry.kind === 'directory' &&
        tree.expanded[focusedRow.entry.path] === true
      ) {
        setTree((current) => ({
          ...current,
          expanded: { ...current.expanded, [focusedRow.entry.path]: false }
        }))
      } else {
        const parent = parentPathOf(focusedRow.entry.path)
        const parentIndex = rows.findIndex((row) => row.entry.path === parent)
        if (parentIndex !== -1) focusRow(parentIndex)
      }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (focusedRow === null) return
      handled()
      void toggleEntry(focusedRow.entry)
      return
    }
    if (event.key === 'F2') {
      if (focusedRow === null) return
      handled()
      beginRename(focusedRow.entry.path)
      return
    }
    if (event.key === 'Delete') {
      const targets = selectedPaths()
      if (targets.length === 0) return
      handled()
      requestDelete(targets, event.shiftKey)
      return
    }
    const command = event.metaKey || event.ctrlKey
    if (command && !event.shiftKey && event.key.toLowerCase() === 'z') {
      handled()
      void undoLast()
      return
    }
    if (command && event.key.toLowerCase() === 'a') {
      handled()
      setSelection(selectAll(rows))
      setEditorMode(rows.length > 1 ? 'folder' : 'tab')
      return
    }
    if (command && event.key.toLowerCase() === 'c') {
      handled()
      copySelection('copy')
      return
    }
    if (command && event.key.toLowerCase() === 'x') {
      handled()
      copySelection('cut')
      return
    }
    if (command && event.key.toLowerCase() === 'v') {
      handled()
      void pasteInto(createParent())
      return
    }
    if (event.key === 'Escape') {
      if (filesClipboardStore.get()?.mode === 'cut') {
        filesClipboardStore.clear()
        handled()
        return
      }
      const activePath = sessionFiles.activePath
      if (activePath !== null) {
        selectOnly(activePath)
      } else {
        setSelection(EMPTY_SELECTION)
      }
      return
    }

    if (!command && !event.altKey && event.key.length === 1) {
      const now = Date.now()
      const previous = typeahead.current
      let text = previous !== null && now - previous.at < 700 ? previous.text + event.key : event.key
      typeahead.current = { text, at: now }
      const search = (needle: string): number => {
        const start = focusedIndex === -1 ? 0 : focusedIndex + 1
        for (let offset = 0; offset < rows.length; offset += 1) {
          const index = (start + offset) % rows.length
          const row = rows[index]
          if (row !== undefined && row.entry.name.toLowerCase().startsWith(needle.toLowerCase())) {
            return index
          }
        }
        return -1
      }
      let match = search(text)
      if (match === -1 && text.length > 1) {
        text = event.key
        typeahead.current = { text, at: now }
        match = search(text)
      }
      if (match !== -1) {
        handled()
        focusRow(match)
      }
    }
  }

  const selectionSummary = summarizeSelection(rows, selection.selected)
  const singleSelectedPath =
    selection.selected.size === 1 ? ([...selection.selected][0] ?? null) : null
  const singleSelectedEntry =
    singleSelectedPath === null ? null : findEntry(singleSelectedPath)
  const singleFolder =
    singleSelectedEntry?.kind === 'directory' ? singleSelectedEntry : null
  const cutPaths =
    clipboardHere && clipboard !== null && clipboard.mode === 'cut' ? clipboard.paths : []
  const isCut = (path: string): boolean => cutPaths.some((cut) => isUnder(path, cut))
  const deleteDirtyCount =
    deletePrompt === null
      ? 0
      : openFilesStore
          .get(sessionId)
          .tabs.filter(
            (tab) =>
              isDirty(tab) &&
              deletePrompt.paths.some((path) => isUnder(tab.path, path))
          ).length

  const editParent =
    edit === null ? '' : edit.kind === 'rename' ? parentPathOf(edit.path) : edit.parent
  const editPreviousName =
    edit?.kind === 'rename' ? basenameOf(edit.path) : undefined
  const onEditChange = (value: string): void => {
    setEditValue(value)
    const check = checkEntryName(value, {
      siblings: siblingsOf(editParent),
      ...(editPreviousName === undefined ? {} : { previousName: editPreviousName })
    })
    setEditError(check.error)
    setEditWarning(check.warning)
  }

  const renderEditRow = (depth: number): React.JSX.Element => {
    const creating = edit !== null && edit.kind !== 'rename'
    const folderCreate = edit?.kind === 'create-directory'
    const note = editError ?? editWarning
    return (
      <div key="files-inline-edit" className="relative">
        <div
          role="treeitem"
          aria-level={depth + 1}
          className="flex h-7 items-center gap-1 rounded bg-accent/10 px-1.5 text-[11.5px]"
          style={{ paddingLeft: `${String(depth * 12 + 4)}px` }}
        >
          <span className="w-3 shrink-0 text-[9px] text-muted-foreground">
            {creating ? (folderCreate ? '▸' : '') : '▸'}
          </span>
          <input
            ref={editInput}
            autoFocus
            value={editValue}
            aria-label={
              edit?.kind === 'rename' ? t('files.edit.rename') : t('files.edit.newName')
            }
            aria-invalid={editError !== null}
            aria-describedby={note === null ? undefined : 'files-edit-note'}
            className="min-w-0 flex-1 rounded border border-accent/60 bg-background px-1 py-0.5 font-mono text-[11px] text-foreground outline-none"
            data-testid="files-pending-input"
            onChange={(event) => onEditChange(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                void commitEdit()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelEdit()
              }
            }}
            onBlur={() => {
              if (ignoreEditBlur.current) {
                ignoreEditBlur.current = false
                return
              }
              if (editValue.trim().length === 0 || editError !== null) cancelEdit()
              else void commitEdit()
            }}
          />
          <button
            type="button"
            className="rounded px-1 text-[10px] text-accent hover:bg-accent/15"
            aria-label={t('common.confirm')}
            data-testid="files-pending-confirm"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void commitEdit()}
          >
            ✓
          </button>
          <button
            type="button"
            className="rounded px-1 text-[10px] text-muted-foreground hover:text-foreground"
            aria-label={t('common.cancel')}
            data-testid="files-pending-cancel"
            onMouseDown={(event) => event.preventDefault()}
            onClick={cancelEdit}
          >
            ✕
          </button>
        </div>
        {note === null ? null : (
          <div
            id="files-edit-note"
            role="note"
            className={`absolute left-0 right-0 top-full z-10 border border-border bg-card px-2 py-0.5 text-[9px] ${editError === null ? 'text-signal' : 'text-destructive'}`}
            style={{ paddingLeft: `${String(depth * 12 + 23)}px` }}
            data-testid="files-edit-note"
          >
            {note}
          </div>
        )}
      </div>
    )
  }

  const toggleNested = (path: string): void => {
    setCollapsedNested((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderRow = (row: TreeRow): React.JSX.Element => {
    const entry = row.entry
    if (edit?.kind === 'rename' && edit.path === entry.path) {
      return renderEditRow(row.depth)
    }
    const isOpen = tree.expanded[entry.path] === true
    const selected = selection.selected.has(entry.path)
    const focused = selection.focused === entry.path
    const dropping = dropTarget === entry.path
    const nestedCollapsed =
      row.nestedCount !== undefined && collapsedNested.has(entry.path)
    const decoration =
      entry.kind === 'file' ? decorations.files.get(entry.path) : undefined
    const folderDecorated =
      entry.kind === 'directory' && decorations.folders.has(entry.path)
    return (
      <div
        key={entry.path}
        ref={(element) => {
          if (element === null) rowRefs.current.delete(entry.path)
          else rowRefs.current.set(entry.path, element)
        }}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={
          entry.kind === 'directory'
            ? isOpen
            : row.nestedCount !== undefined
              ? !nestedCollapsed
              : undefined
        }
        aria-selected={selected}
        tabIndex={focused ? 0 : -1}
        title={
          decoration === undefined ? entry.path : `${entry.path} · ${decoration.title}`
        }
        className={`flex h-7 cursor-default items-center gap-1 rounded px-1.5 text-left text-[11.5px] outline-none ${
          selected
            ? 'bg-accent/10 text-foreground shadow-[inset_2px_0_0_var(--icode-accent)]'
            : 'text-muted-foreground hover:bg-muted/60'
        } ${focused ? 'ring-1 ring-inset ring-accent/50' : ''} ${
          dropping ? 'ring-1 ring-inset ring-accent' : ''
        } ${isCut(entry.path) ? 'opacity-45' : ''} ${row.nested === true ? 'opacity-80' : ''}`}
        style={{ paddingLeft: `${String(row.depth * 12 + 4)}px` }}
        onClick={(event) => onRowClick(event, row)}
        onContextMenu={(event) => onRowContextMenu(event, row)}
        draggable={edit === null}
        onDragStart={(event) => onDragStart(event, row)}
        onDragEnd={onDragEnd}
        onDragOver={(event) => onRowDragOver(event, row)}
        onDragLeave={onRowDragLeave}
        onDrop={(event) => onRowDrop(event, row)}
        data-testid={`files-entry-${entry.path}`}
        {...(row.nested === true ? { 'data-nested': 'true' } : {})}
      >
        <span className="flex w-3 shrink-0 items-center justify-center text-[9px]">
          {entry.kind === 'directory' ? (
            isOpen ? '▾' : '▸'
          ) : row.nestedCount !== undefined ? (
            <button
              type="button"
              tabIndex={-1}
              className="rounded text-[9px] leading-none text-muted-foreground hover:text-foreground"
              aria-label={
                nestedCollapsed ? t('files.tree.showNested') : t('files.tree.hideNested')
              }
              title={
                nestedCollapsed ? t('files.tree.showNested') : t('files.tree.hideNested')
              }
              data-testid={`files-nested-toggle-${entry.path}`}
              onClick={(event) => {
                event.stopPropagation()
                toggleNested(entry.path)
              }}
            >
              {nestedCollapsed ? '▸' : '▾'}
            </button>
          ) : null}
        </span>
        {entry.kind === 'directory' ? (
          <FolderOpen size={11} className="shrink-0 text-accent/80" />
        ) : (
          <FileText size={11} className="shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{row.displayName}</span>
        {folderDecorated ? (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
            title={t('files.tree.containsChanges')}
            aria-label={t('files.tree.containsChanges')}
            data-testid={`files-folder-decorated-${entry.path}`}
          />
        ) : null}
        {decoration !== undefined ? (
          <span
            className={`shrink-0 font-mono text-[10px] ${decoration.tone}`}
            title={decoration.title}
            aria-label={decoration.title}
            data-testid={`files-decoration-${entry.path}`}
          >
            {decoration.letter}
          </span>
        ) : null}
        {tree.loading[entry.path] ? <span className="text-[9px]">…</span> : null}
      </div>
    )
  }

  const createEdit =
    edit !== null && edit.kind !== 'rename' ? edit : null
  const createParentIndex =
    createEdit === null ? -1 : rows.findIndex((row) => row.entry.path === createEdit.parent)
  const createDepth =
    createEdit === null
      ? 0
      : createEdit.parent === ''
        ? 0
        : (rows[createParentIndex]?.depth ?? -1) + 1
  const createIndex =
    createEdit === null
      ? -1
      : createEdit.parent === '' || createParentIndex === -1
        ? 0
        : createParentIndex + 1
  useEffect(() => {
    if (createEdit === null) return
    const index = createIndex
    const focusInput = (attempt = 0): void => {
      if (editInput.current !== null) {
        editInput.current.focus()
        return
      }
      if (attempt < 12) window.setTimeout(() => focusInput(attempt + 1), 16)
    }
    window.requestAnimationFrame(() => {
      scrollRowIndexIntoView(index)
      focusInput()
    })
  }, [createEdit, createIndex, scrollRowIndexIntoView])
  const displayCount = rows.length + (createEdit === null ? 0 : 1)
  const virtualWindow = computeVirtualWindow({
    rowCount: displayCount,
    scrollTop: Math.max(0, viewport.scrollTop - viewport.rowsTop),
    viewportHeight: viewport.height,
    rowHeight: FILES_ROW_HEIGHT
  })
  const treeElements: React.JSX.Element[] = []
  for (let slot = virtualWindow.start; slot < virtualWindow.end; slot += 1) {
    if (createEdit !== null && slot === createIndex) {
      treeElements.push(renderEditRow(createDepth))
      continue
    }
    const rowIndex = createEdit !== null && slot > createIndex ? slot - 1 : slot
    const row = rows[rowIndex]
    if (row !== undefined) treeElements.push(renderRow(row))
  }

  const menuReasonText = (reason: FilesMenuReason): string => {
    switch (reason) {
      case 'busy':
        return translate('files.reason.busy')
      case 'other-session':
        return translate('files.reason.otherSession')
      case 'copy-first':
        return translate('files.reason.copyFirst')
      case 'select-cut':
        return translate('files.reason.selectCut')
      case 'select-copy':
        return translate('files.reason.selectCopy')
      case 'select-duplicate':
        return translate('files.reason.selectDuplicate')
      case 'select-one-rename':
        return translate('files.reason.selectOneRename')
      case 'select-delete':
        return translate('files.reason.selectDelete')
    }
  }

  const buildContextItems = (): ContextMenuItem[] => {
    if (context === null) return []
    const target = context.target
    const paths = contextPaths(target)
    const entries = filesMenuEntries({
      targetKind: target.kind,
      pathCount: paths.length,
      canPaste: clipboardHere && clipboard !== null,
      clipboardElsewhere: clipboard !== null && !clipboardHere,
      transferBusy,
      canOpenHistory: onOpenHistory !== undefined && target.path !== ''
    })
    return entries.map((entry): ContextMenuItem => {
      const item = {
        id: entry.id,
        separatorBefore: entry.separatorBefore,
        disabled: entry.disabled,
        ...(entry.reason === undefined ? {} : { reason: menuReasonText(entry.reason) })
      }
      switch (entry.id) {
        case 'open':
          return {
            ...item,
            label: translate('files.menu.open'),
            icon: <FileText size={12} />,
            shortcut: 'Enter',
            testId: 'files-menu-open',
            onSelect: () => void openPath(target.path, 1)
          }
        case 'new-file':
          return {
            ...item,
            label: translate('files.menu.newFile'),
            icon: <FilePlus2 size={12} />,
            testId: 'files-menu-new-file',
            onSelect: () => beginCreate('create-file', target.path)
          }
        case 'new-folder':
          return {
            ...item,
            label: translate('files.menu.newFolder'),
            icon: <FolderPlus size={12} />,
            testId: 'files-menu-new-folder',
            onSelect: () => beginCreate('create-directory', target.path)
          }
        case 'paste':
          return {
            ...item,
            label: translate('files.menu.paste'),
            icon: <ClipboardPaste size={12} />,
            shortcut: shortcutLabel('V'),
            testId: 'files-menu-paste',
            onSelect: () => void pasteInto(target.path)
          }
        case 'cut':
          return {
            ...item,
            label: translate('files.menu.cut'),
            icon: <Scissors size={12} />,
            shortcut: shortcutLabel('X'),
            testId: 'files-menu-cut',
            onSelect: () => copySelection('cut', paths)
          }
        case 'copy':
          return {
            ...item,
            label: translate('files.menu.copy'),
            icon: <Copy size={12} />,
            shortcut: shortcutLabel('C'),
            testId: 'files-menu-copy',
            onSelect: () => copySelection('copy', paths)
          }
        case 'duplicate':
          return {
            ...item,
            label: translate('files.menu.duplicate'),
            icon: <Copy size={12} />,
            testId: 'files-menu-duplicate',
            onSelect: () => void duplicateSelection(paths)
          }
        case 'copy-path':
          return {
            ...item,
            label:
              paths.length > 1
                ? translate('files.menu.copyPaths')
                : translate('files.menu.copyPath'),
            icon: <Copy size={12} />,
            testId: 'files-menu-copy-path',
            onSelect: () => void copyPathsToClipboard('absolute', paths)
          }
        case 'copy-relative-path':
          return {
            ...item,
            label:
              paths.length > 1
                ? translate('files.menu.copyRelativePaths')
                : translate('files.menu.copyRelativePath'),
            icon: <Copy size={12} />,
            testId: 'files-menu-copy-relative-path',
            onSelect: () => void copyPathsToClipboard('relative', paths)
          }
        case 'rename':
          return {
            ...item,
            label: translate('files.menu.rename'),
            icon: <Pencil size={12} />,
            shortcut: 'F2',
            testId: 'files-menu-rename',
            onSelect: () => {
              const path = paths[0]
              if (path !== undefined) beginRename(path)
            }
          }
        case 'delete':
          return {
            ...item,
            label: settings.useTrash
              ? translate('files.menu.moveToTrash')
              : translate('files.menu.delete'),
            icon: <Trash2 size={12} />,
            shortcut: 'Del',
            danger: true,
            testId: 'files-menu-delete',
            onSelect: () => requestDelete(paths)
          }
        case 'history':
          return {
            ...item,
            label: translate('files.menu.history'),
            icon: <History size={12} />,
            testId: 'files-menu-history',
            onSelect: () => onOpenHistory?.(target.path)
          }
        case 'select-all':
          return {
            ...item,
            label: translate('files.menu.selectAll'),
            shortcut: shortcutLabel('A'),
            testId: 'files-menu-select-all',
            onSelect: () => {
              setSelection(selectAll(rows))
              setEditorMode(rows.length > 1 ? 'folder' : 'tab')
            }
          }
        case 'refresh':
          return {
            ...item,
            label: translate('files.menu.refresh'),
            icon: <RefreshCw size={12} />,
            testId: 'files-menu-refresh',
            onSelect: () => void reloadExpanded(false, true)
          }
      }
    })
  }

  const diskBanner =
    activeTab !== null && activeTab.disk === 'changed' ? (
      <div
        className="flex flex-wrap items-center gap-2 border-b border-signal/40 bg-signal-weak px-3 py-1.5 text-[10px] text-signal"
        data-testid="files-disk-changed"
      >
        <span className="min-w-0 flex-1">
          {t('files.disk.changed')}
        </span>
        <button
          type="button"
          className="rounded border border-signal/50 px-1.5 py-0.5 hover:bg-signal/10"
          onClick={() => void reloadFromDisk(activeTab.path)}
          data-testid="files-disk-reload"
        >
          {t('files.disk.reload')}
        </button>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
          onClick={() => void keepMine(activeTab.path)}
          data-testid="files-disk-keep"
        >
          {t('files.disk.keepMine')}
        </button>
      </div>
    ) : activeTab !== null && activeTab.disk === 'deleted' ? (
      <div
        className="flex flex-wrap items-center gap-2 border-b border-signal/40 bg-signal-weak px-3 py-1.5 text-[10px] text-signal"
        data-testid="files-disk-deleted"
      >
        <span className="min-w-0 flex-1">{t('files.disk.deleted')}</span>
        <button
          type="button"
          className="rounded border border-signal/50 px-1.5 py-0.5 hover:bg-signal/10"
          onClick={() => void saveTabAt(activeTab.path, null, false)}
          data-testid="files-disk-recreate"
        >
          {t('files.disk.recreate')}
        </button>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
          onClick={() => requestClose(activeTab.path)}
          data-testid="files-disk-close"
        >
          {t('files.disk.close')}
        </button>
      </div>
    ) : null

  const tabStrip =
    tabs.length === 0 ? null : (
      <div className="flex h-8 shrink-0 items-center border-b border-border bg-card">
        <div className="flex shrink-0 items-center gap-0.5 pl-1">
          {detailMaximized ? null : (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title={
                twoColumnAvailable && !listHidden ? t('session.hideList') : t('session.showList')
              }
              aria-label={
                twoColumnAvailable && !listHidden ? t('session.hideList') : t('session.showList')
              }
              data-testid="files-list-toggle"
              onClick={() => {
                if (twoColumnAvailable) {
                  setListHidden((hidden) => !hidden)
                } else {
                  setDetailMaximized(false)
                  setDetailDismissed(true)
                }
              }}
            >
              {twoColumnAvailable && !listHidden ? (
                <PanelLeftClose size={12} />
              ) : (
                <PanelLeftOpen size={12} />
              )}
            </button>
          )}
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title={detailMaximized ? t('session.restoreDetail') : t('session.maximizeDetail')}
            aria-label={
              detailMaximized ? t('session.restoreDetail') : t('session.maximizeDetail')
            }
            data-testid="files-detail-maximize"
            onClick={() => setDetailMaximized((value) => !value)}
          >
            {detailMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          {activeTab === null ? null : (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('common.close')}
              aria-label={t('common.close')}
              data-testid="files-detail-close"
              onClick={() => requestClose(activeTab.path)}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div
          role="tablist"
          aria-label={t('files.tabs.openFiles')}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1"
          data-testid="files-tabs"
        >
        {tabs.map((tab, index) => {
          const selectedTab = tab.path === sessionFiles.activePath
          return (
            <div
              key={tab.path}
              ref={(element) => {
                if (element === null) tabRefs.current.delete(tab.path)
                else tabRefs.current.set(tab.path, element)
              }}
              role="tab"
              aria-selected={selectedTab}
              tabIndex={selectedTab ? 0 : -1}
              title={tab.path}
              className={`group flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] outline-none ${
                selectedTab
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted/60'
              } ${tab.load === 'failed' ? 'text-destructive' : ''}`}
              onClick={() => setActiveTab(tab.path)}
              onKeyDown={(event) => onTabKeyDown(event, index, tab.path)}
              data-testid={`files-tab-${tab.path}`}
            >
              {tab.load === 'loading' ? (
                <span className="text-[9px]">…</span>
              ) : isDirty(tab) ? (
                <span
                  role="img"
                  aria-label={t('files.tabs.unsavedChanges')}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  data-testid="files-tab-dirty"
                />
              ) : null}
              <span className="max-w-[180px] truncate">{basenameOf(tab.path)}</span>
              <button
                type="button"
                className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                aria-label={t('files.tabs.close', { path: tab.path })}
                onClick={(event) => {
                  event.stopPropagation()
                  requestClose(tab.path)
                }}
                data-testid={`files-tab-close-${tab.path}`}
              >
                <X size={9} />
              </button>
            </div>
          )
        })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1">
          {dirtyCount > 0 ? (
            <span className="px-1 text-[9px] text-muted-foreground" data-testid="files-dirty-count">
              {t('files.tabs.unsaved', { count: dirtyCount })}
            </span>
          ) : null}
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            title={t('files.toolbar.saveAll')}
            aria-label={t('files.toolbar.saveAll')}
            disabled={dirtyCount === 0}
            onClick={() => void saveAllTabs()}
            data-testid="files-save-all"
          >
            <Save size={10} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            title={t('files.toolbar.closeAll')}
            aria-label={t('files.toolbar.closeAll')}
            disabled={tabs.length === 0}
            onClick={requestCloseAll}
            data-testid="files-close-all"
          >
            <X size={10} />
          </button>
        </div>
      </div>
    )

  return (
    <div
      ref={panelRef}
      className="relative flex h-full min-h-0 flex-1"
      data-testid="files-panel"
      data-live-mode={liveState}
      data-busy={transferBusy ? 'true' : 'false'}
    >
      <div
        ref={listRef}
        className={`flex min-w-0 flex-col bg-card ${
          twoColumn ? 'shrink-0 border-r border-border' : 'flex-1'
        }`}
        style={twoColumn ? { width: `${String(effectiveListWidth)}px` } : undefined}
        data-testid="files-list-column"
      >
        {/* One compact row: the root, then the create/refresh/undo verbs. */}
        <div className="flex items-center gap-1 border-b border-border px-2 py-1">
          <FolderOpen size={11} className="shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground"
            title={rootNote || t('files.move.root')}
          >
            {rootNote || t('files.move.root')}
          </span>
          {liveState === 'poll' ? (
            <span
              className="shrink-0 text-[9px] text-signal"
              title={t('files.toolbar.watcherUnavailable')}
            >
              {t('files.toolbar.polling')}
            </span>
          ) : null}
          {transferBusy ? (
            <span className="shrink-0 text-[9px] text-signal">{t('files.toolbar.working')}</span>
          ) : null}
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t('files.toolbar.newFile')}
            aria-label={t('files.toolbar.newFile')}
            data-testid="files-new-file"
            onClick={() => beginCreate('create-file', createParent())}
          >
            <FilePlus2 size={11} />
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t('files.toolbar.newFolder')}
            aria-label={t('files.toolbar.newFolder')}
            data-testid="files-new-directory"
            onClick={() => beginCreate('create-directory', createParent())}
          >
            <FolderPlus size={11} />
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t('files.toolbar.refresh')}
            aria-label={t('files.toolbar.refreshAria')}
            data-testid="files-refresh"
            onClick={() => void reloadExpanded(false, true)}
          >
            <RefreshCw size={11} />
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            title={undoLabel(peekUndo(undoStack))}
            aria-label={t('files.toolbar.undo')}
            disabled={undoStack.length === 0 || undoing || transferBusy}
            data-testid="files-undo"
            onClick={() => void undoLast()}
          >
            <Undo2 size={11} />
          </button>
        </div>

        {hotExitNote.length > 0 ? (
          <div
            className="flex items-center gap-2 border-b border-border bg-signal-weak px-3 py-1 text-[10px] text-signal"
            data-testid="files-hot-exit-note"
          >
            <span className="min-w-0 flex-1">{hotExitNote}</span>
            <button
              type="button"
              className="shrink-0 rounded px-1 hover:bg-signal/10"
              aria-label={t('files.toolbar.dismiss')}
              onClick={() => setHotExitNote('')}
            >
              <X size={10} />
            </button>
          </div>
        ) : null}

        {trashBanner !== null ? (
          <div
            className="flex items-center gap-2 border-b border-border bg-signal-weak px-3 py-1 text-[10px] text-signal"
            data-testid="files-trash-banner"
          >
            <Trash2 size={10} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {tp('files.trash.deleted', trashBanner.paths.length)}
            </span>
            <button
              type="button"
              className="shrink-0 rounded border border-signal/40 px-1.5 py-0.5 hover:bg-signal/10 disabled:opacity-40"
              disabled={undoing || transferBusy}
              data-testid="files-trash-restore"
              onClick={() => void restoreTrashOp(trashBanner.opId)}
            >
              {t('files.trash.restore')}
            </button>
          </div>
        ) : null}

        <div
          ref={treeScrollRef}
          role="tree"
          aria-label={t('files.toolbar.worktreeFiles')}
          aria-multiselectable={true}
          tabIndex={-1}
          className={`relative min-h-0 flex-1 overflow-auto px-1 py-1 outline-none ${
            dropTarget === '' ? 'bg-accent/5 ring-1 ring-inset ring-accent/40' : ''
          }`}
          data-testid="files-tree"
          onScroll={(event) => {
            const scrollTop = event.currentTarget.scrollTop
            setViewport((current) =>
              current.scrollTop === scrollTop ? current : { ...current, scrollTop }
            )
          }}
          onContextMenu={onTreeContextMenu}
          onKeyDown={onTreeKeyDown}
          onDragOver={onTreeDragOver}
          onDrop={onTreeDrop}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              clearDragExpand()
              setDropTarget(null)
            }
          }}
        >
          {rootState === 'loading' ? (
            <p role="presentation" className="px-2 py-1 text-[11px] text-muted-foreground">
              {t('files.toolbar.loading')}
            </p>
          ) : null}
          {rootState === 'unavailable' ? (
            <p role="presentation" className="px-2 py-1 text-[11px] text-signal" data-testid="files-unavailable">
              {rootNote}
            </p>
          ) : null}
          {ignoreNote.length > 0 ? (
            <p
              role="presentation"
              className="flex items-center gap-1 px-2 py-1 text-[9.5px] text-signal"
              data-testid="files-ignore-note"
            >
              <span className="min-w-0 flex-1">{ignoreNote}</span>
              <button
                type="button"
                className="shrink-0 rounded border border-signal/40 px-1 hover:bg-signal-weak"
                data-testid="files-ignore-retry"
                onClick={() => {
                  setIgnoreNote('')
                  void reloadExpanded(true)
                }}
              >
                {t('common.retry')}
              </button>
            </p>
          ) : null}

          <div
            ref={rowsContainerRef}
            style={{
              paddingTop: virtualWindow.paddingTop,
              paddingBottom: virtualWindow.paddingBottom
            }}
            data-testid="files-virtual-rows"
          >
            {treeElements}
          </div>
          {rootState === 'ready' && rows.length === 0 && edit === null ? (
            <p
              role="presentation"
              className="px-2 py-1 text-[11px] text-muted-foreground"
              data-testid="files-folder-empty"
            >
              {t('files.folderEmpty')}
            </p>
          ) : null}
        </div>

        {/* Selection acts live here, at the foot of the list, so the verbs
            appear only when there is a selection to act on. */}
        {selectionSummary.total > 0 ? (
          <div
            className="flex shrink-0 items-center gap-1 border-t border-border bg-card px-2 py-1 text-[10px] text-muted-foreground"
            data-testid="files-selection"
          >
            <span className="min-w-0 flex-1 truncate">
              {selectionSummary.total === 1
                ? t('files.selection.selected', {
                    path: singleSelectedPath ?? '',
                    kind:
                      singleSelectedEntry?.kind === 'directory'
                        ? t('files.selection.folder')
                        : t('files.selection.file')
                  })
                : t('files.selection.summary', {
                    total: selectionSummary.total,
                    files: tp('files.selection.files', selectionSummary.files),
                    folders: tp('files.selection.folders', selectionSummary.directories)
                  })}
            </span>
            <button
              type="button"
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              title={t('files.toolbar.rename')}
              disabled={
                selectionSummary.total !== 1 || singleSelectedEntry === null || transferBusy
              }
              data-testid="files-rename"
              onClick={() => {
                const path = [...selection.selected][0]
                if (path !== undefined) beginRename(path)
              }}
            >
              <Pencil size={10} />
              {t('files.toolbar.rename')}
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              title={t('files.toolbar.duplicate')}
              aria-label={t('files.toolbar.duplicate')}
              disabled={transferBusy}
              data-testid="files-duplicate"
              onClick={() => void duplicateSelection()}
            >
              <Copy size={10} />
            </button>
            <button
              type="button"
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-30"
              title={t('files.toolbar.delete')}
              disabled={transferBusy}
              data-testid="files-delete"
              onClick={() => requestDelete(selectedPaths())}
            >
              <Trash2 size={10} />
              {t('files.toolbar.delete')}
            </button>
          </div>
        ) : null}
      </div>

      {twoColumn ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('files.toolbar.resizeList')}
          title={t('files.toolbar.resizeList')}
          tabIndex={0}
          className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border focus-visible:bg-signal focus-visible:outline-none data-resizing:bg-border"
          data-testid="files-list-resizer"
          {...handleProps}
          onDoubleClick={() => persistListWidth(FILES_LIST_WIDTH_DEFAULT)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            persistListWidth(
              listWidthRef.current + (event.key === 'ArrowLeft' ? -16 : 16)
            )
          }}
        />
      ) : null}

      <div
        className={
          detailVisible
            ? detailMaximized
              ? 'fixed inset-0 z-50 flex min-h-0 min-w-0 flex-col bg-background'
              : twoColumn
                ? 'flex min-h-0 min-w-0 flex-1 flex-col'
                : 'absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col bg-background'
            : 'hidden'
        }
      >
        {tabStrip}
        {fileNote ? (
          <p className="border-b border-border px-3 py-2 text-[10px] text-signal" data-testid="files-file-note">
            {fileNote}
          </p>
        ) : null}
        {diskBanner}
        {editorMode === 'folder' && selectionSummary.total > 1 ? (
          <div className="flex flex-1 items-center justify-center p-6" data-testid="files-selection-card">
            <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4">
              <h2 className="text-[13px] font-semibold">
                {selectionSummary.total} items selected
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {t('files.selectionSummary', {
                  files: tp('files.summary.files', selectionSummary.files),
                  directories: tp('files.summary.directories', selectionSummary.directories)
                })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                  data-testid="files-selection-copy-path"
                  onClick={() => void copyPathsToClipboard('absolute', selectedPaths())}
                >
                  <Copy size={10} />
                  {t('files.menu.copyPath')}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                  data-testid="files-selection-copy-relative-path"
                  onClick={() => void copyPathsToClipboard('relative', selectedPaths())}
                >
                  <Copy size={10} />
                  {t('files.menu.copyRelativePath')}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-destructive/60 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10"
                  data-testid="files-selection-delete"
                  onClick={() => requestDelete(selectedPaths())}
                >
                  <Trash2 size={10} />
                  {t('files.menu.deleteEllipsis')}
                </button>
              </div>
            </div>
          </div>
        ) : editorMode === 'folder' && singleFolder !== null ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4">
              <h2 className="text-[13px] font-semibold">{singleFolder.name}</h2>
              <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                {singleFolder.path}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {t('files.folderRenameNote')}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {onOpenHistory ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                    data-testid="files-folder-history"
                    onClick={() => onOpenHistory(singleFolder.path)}
                  >
                    <History size={10} />
                    {t('files.menu.history')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                  data-testid="files-folder-rename"
                  onClick={() => beginRename(singleFolder.path)}
                >
                  <Pencil size={10} />
                  {t('files.menu.renameEllipsis')}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-destructive/60 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10"
                  data-testid="files-folder-delete"
                  onClick={() => requestDelete([singleFolder.path])}
                >
                  <Trash2 size={10} />
                  {t('files.deleteFolder')}
                </button>
              </div>
            </div>
          </div>
        ) : activeTab === null ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <p className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground" data-testid="files-empty">
              {t('files.emptyEditor')}
            </p>
          </div>
        ) : activeTab.load === 'loading' ? (
          <div className="flex flex-1 items-center justify-center p-6" data-testid="files-tab-loading">
            <p className="text-[11.5px] text-muted-foreground">
              {t('files.opening', { path: activeTab.path })}
            </p>
          </div>
        ) : activeTab.load === 'failed' ? (
          <div
            className="flex flex-1 items-center justify-center p-6 text-center"
            data-testid="files-tab-failure"
          >
            <div className="max-w-sm">
              <p className="text-[11.5px] leading-relaxed text-signal">{activeTab.failure}</p>
              <div className="mt-3 flex justify-center gap-2">
                <button
                  type="button"
                  className="rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                  onClick={() => void loadTab(activeTab.path, 1)}
                  data-testid="files-tab-retry"
                >
                  {t('common.retry')}
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => requestClose(activeTab.path)}
                  data-testid="files-tab-failure-close"
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <CodeEditor
            path={activeTab.path}
            value={activeTab.text}
            dirty={isDirty(activeTab)}
            gotoLine={gotoLine}
            onChange={(next) => openFilesStore.updateText(sessionId, activeTab.path, next)}
            onSave={() => void saveActive()}
            onClose={() => requestClose(activeTab.path)}
            onHistory={
              onOpenHistory ? () => onOpenHistory(activeTab.path) : undefined
            }
            engine={editorEngine}
            original={activeTab.original}
            onQuickDiffChanged={() => {
              void reloadFromDisk(activeTab.path)
            }}
            sessionId={sessionId}
          />
        )}
      </div>

      {unsaved !== null ? (
        <UnsavedFilesDialog
          path={unsaved.kind === 'single' ? unsaved.path : ''}
          multiple={unsaved.kind === 'all'}
          busy={dialogBusy}
          onSave={() => void confirmUnsavedSave()}
          onDiscard={confirmUnsavedDiscard}
          onCancel={() => {
            setUnsaved(null)
            setCloseAfterSave(null)
          }}
        />
      ) : null}

      {conflict !== null ? (
        <SaveConflictDialog
          path={conflict.path}
          detail={conflict.detail}
          busy={dialogBusy}
          onOverwrite={() => void resolveConflictOverwrite()}
          onReload={() => void resolveConflictReload()}
          onCancel={cancelConflict}
        />
      ) : null}

      {deletePrompt !== null ? (
        <DeleteFilesDialog
          paths={deletePrompt.paths}
          dirtyCount={deleteDirtyCount}
          useTrash={settings.useTrash && !deletePrompt.permanentOnly}
          busy={transferBusy}
          onConfirm={() => void confirmDelete()}
          onConfirmPermanent={() => void confirmPermanentDelete()}
          onCancel={() => setDeletePrompt(null)}
        />
      ) : null}

      {movePrompt !== null ? (
        <MoveFilesDialog
          paths={movePrompt.paths}
          destination={movePrompt.destination}
          busy={transferBusy}
          onConfirm={() => {
            const prompt = movePrompt
            if (prompt === null) return
            void (async () => {
              await performTransfer('move', prompt.paths, prompt.destination)
              setMovePrompt(null)
            })()
          }}
          onCancel={() => setMovePrompt(null)}
        />
      ) : null}

      {context !== null ? (
        <ContextMenu
          x={context.x}
          y={context.y}
          items={buildContextItems()}
          ariaLabel={t('files.actions')}
          testId="files-context-menu"
          onClose={() => setContext(null)}
        />
      ) : null}
    </div>
  )
}

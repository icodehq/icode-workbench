import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ClipboardPaste,
  Copy,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  History,
  Pencil,
  RefreshCw,
  Save,
  Scissors,
  Search,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { callApi, errorNotice } from '../lib/api'
import { shortcutLabel } from '../lib/platform'
import type {
  FileContentPayload,
  FileSearchPayload,
  FilesBatchPayload,
  FilesCopyPathsPayload,
  FilesListingPayload,
  FilesMutatePayload,
  FilesReplacePayload,
  FilesRestoreTrashPayload,
  FilesStatPayload,
  FilesTrashListPayload,
  FilesTrashPayload,
  FilesWritePayload,
  GitCheckIgnorePayload,
  GitFileAtRevisionPayload,
  GitStatusPayload,
  WorkspaceUnavailablePayload
} from '../../../shared/icode-api'
import type {
  FileBatchEntry,
  FileEntry,
  FileSearchMatch
} from '../../../shared/domain/workspace-files'
import { isExcluded, isSearchPathIncluded } from '../../../shared/domain/glob'
import { compileTextMatcher } from '../../../shared/domain/text-search'
import { clearWorktreeFileIndex } from '../files/file-index'
import { buildFileDecorations, type FileDecorations } from '../files/file-decorations'
import { useFilesSettings } from '../files/files-settings'
import { buildTreeRows } from '../files/tree-layout'
import {
  openFilesStore,
  useSessionFiles,
  type OpenFileTab
} from '../files/open-files'
import {
  EMPTY_SELECTION,
  collapseSelectedPaths,
  pruneSelection,
  selectAll,
  selectRow,
  summarizeSelection,
  type SelectionState,
  type TreeRow
} from '../files/selection'
import { checkEntryName, nameSelectionRange } from '../files/name-validation'
import { filesClipboardStore, useFilesClipboard } from '../files/files-clipboard'
import {
  peekUndo,
  popUndo,
  pushUndo,
  undoLabel,
  type FileUndoEntry
} from '../files/undo-stack'
import {
  computeVirtualWindow,
  scrollTopForRow,
  FILES_ROW_HEIGHT
} from '../files/virtual-window'
import { loadTreeState, saveTreeState } from '../files/tree-state'
import type { Notice } from '../state/workspace'
import CodeEditor from './CodeEditor'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import {
  DeleteFilesDialog,
  MoveFilesDialog,
  ReplaceFilesDialog,
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

type TreeState = {
  /** Expanded directories, as worktree-relative paths ('' is the root). */
  expanded: Record<string, boolean>
  children: Record<string, FileEntry[]>
  loading: Record<string, boolean>
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

type DeletePrompt = { paths: string[]; permanentOnly: boolean }
type MovePrompt = { paths: string[]; destination: string }

type UnsavedPrompt =
  | { kind: 'single'; path: string }
  | { kind: 'all' }

type ConflictPrompt = {
  path: string
  currentEtag?: string
  detail: string
}

type LiveState = 'off' | 'watch' | 'poll'

const parentPathOf = (path: string): string => {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

const basenameOf = (path: string): string => {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

const isUnder = (path: string, parent: string): boolean =>
  parent === '' || path === parent || path.startsWith(`${parent}/`)

/** The worktree's Git link is plumbing, not a file to browse or edit. */
const isGitMetadata = (path: string): boolean => path.split('/').includes('.git')

const unavailableText = (payload: WorkspaceUnavailablePayload): string => {
  switch (payload.reason) {
    case 'worktree-unavailable':
      return 'This distro could not be reached, so its files are unavailable right now.'
    case 'worktree-missing':
      return 'The session worktree is missing.'
    case 'primary-checkout':
      return 'This session runs in the primary checkout, so it has no isolated file scope.'
    default:
      return payload.detail
  }
}

const isDirty = (tab: OpenFileTab): boolean => tab.text !== tab.savedText

/** Applies `.git`/exclude/.gitignore visibility to every loaded directory. */
function visibleTreeChildren(
  children: Record<string, FileEntry[]>,
  exclude: readonly string[],
  respectGitIgnore: boolean,
  ignoredByDirectory: Record<string, ReadonlySet<string>>
): Record<string, FileEntry[]> {
  const result: Record<string, FileEntry[]> = {}
  for (const [directory, entries] of Object.entries(children)) {
    const ignored = respectGitIgnore ? ignoredByDirectory[directory] : undefined
    result[directory] = entries.filter((entry) => {
      if (isGitMetadata(entry.path)) return false
      if (ignored?.has(entry.path) === true) return false
      return !isExcluded(entry.path, entry.kind === 'directory', exclude)
    })
  }
  return result
}

const EMPTY_DECORATIONS: FileDecorations = { files: new Map(), folders: new Set() }

const parsePatterns = (value: string): string[] =>
  value
    .split(/[\n,]/u)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)

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
  const sessionFiles = useSessionFiles(sessionId)
  const settings = useFilesSettings()
  const tabs = sessionFiles.tabs
  const activeTab =
    sessionFiles.activePath === null
      ? null
      : (tabs.find((tab) => tab.path === sessionFiles.activePath) ?? null)
  const dirtyCount = tabs.reduce((count, tab) => (isDirty(tab) ? count + 1 : count), 0)

  const [tree, setTree] = useState<TreeState>({ expanded: { '': true }, children: {}, loading: {} })
  const [rootState, setRootState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [rootNote, setRootNote] = useState('')
  const [fileNote, setFileNote] = useState('')
  const [gotoLine, setGotoLine] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<FileSearchPayload | null>(null)
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchWholeWord, setSearchWholeWord] = useState(false)
  const [searchRegex, setSearchRegex] = useState(false)
  const [searchInclude, setSearchInclude] = useState('')
  const [searchExclude, setSearchExclude] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchNote, setSearchNote] = useState('')
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false)
  const [collapsedSearchFiles, setCollapsedSearchFiles] = useState<Set<string>>(new Set())
  const [replaceText, setReplaceText] = useState('')
  const [replacePrompt, setReplacePrompt] = useState<{
    matches: number
    files: number
    paths: string[]
  } | null>(null)
  const [replaceBusy, setReplaceBusy] = useState(false)
  const [replaceReport, setReplaceReport] = useState<Array<{ path: string; reason: string }>>([])
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const [collapsedNested, setCollapsedNested] = useState<Set<string>>(new Set())
  const [decorations, setDecorations] = useState<FileDecorations>(EMPTY_DECORATIONS)
  const [ignoredByDirectory, setIgnoredByDirectory] = useState<
    Record<string, ReadonlySet<string>>
  >({})
  const [ignoreNote, setIgnoreNote] = useState('')
  const [editorMode, setEditorMode] = useState<'tab' | 'folder'>('tab')
  const [edit, setEdit] = useState<InlineEdit | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [editWarning, setEditWarning] = useState<string | null>(null)
  const [context, setContext] = useState<ContextState | null>(null)
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt | null>(null)
  const [movePrompt, setMovePrompt] = useState<MovePrompt | null>(null)
  const [undoStack, setUndoStack] = useState<FileUndoEntry[]>([])
  const [undoing, setUndoing] = useState(false)
  const [trashBanner, setTrashBanner] = useState<{
    opId: string
    paths: string[]
  } | null>(null)
  const [hotExitNote, setHotExitNote] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [unsaved, setUnsaved] = useState<UnsavedPrompt | null>(null)
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [closeAfterSave, setCloseAfterSave] = useState<string | null>(null)
  const [liveState, setLiveState] = useState<LiveState>('off')
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 600, rowsTop: 0 })

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

  const searchInput = useRef<HTMLInputElement | null>(null)
  const searchSequence = useRef(0)
  const treeScrollRef = useRef<HTMLDivElement | null>(null)
  const rowsContainerRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef<TreeRow[]>([])
  const viewportRef = useRef(viewport)
  const restoreScroll = useRef<number | null>(null)
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const editInput = useRef<HTMLInputElement | null>(null)
  const ignoreEditBlur = useRef(false)
  const typeahead = useRef<{ text: string; at: number } | null>(null)
  const dragExpandTimer = useRef<number | null>(null)
  const dragExpandPath = useRef<string | null>(null)
  const draggingPaths = useRef<string[]>([])
  const revealSequence = useRef(0)
  const reloadExpandedRef = useRef<
    (quiet?: boolean, discover?: boolean) => Promise<void>
  >(async () => undefined)
  const decorationTimer = useRef<number | null>(null)
  const decorationBusy = useRef(false)
  const decorationAgain = useRef(false)
  const decorationsEnabled = useRef(settings.gitDecorations)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const activeRef = useRef(active)
  activeRef.current = active
  const compactFoldersRef = useRef(settings.compactFolders)
  compactFoldersRef.current = settings.compactFolders
  /** Directories listed only so a compact chain can be labelled and refreshed. */
  const preloadedDirectories = useRef<Set<string>>(new Set())
  const excludeGitIgnoreRef = useRef(settings.excludeGitIgnore)
  excludeGitIgnoreRef.current = settings.excludeGitIgnore
  const revealPathRef = useRef<((path: string) => Promise<void>) | null>(null)
  const scheduleDecorationsRef = useRef<((delay?: number) => void) | null>(null)
  const rootStateRef = useRef(rootState)
  rootStateRef.current = rootState
  rowsRef.current = rows
  viewportRef.current = viewport

  const scrollRowIndexIntoView = useCallback((index: number): void => {
    const element = treeScrollRef.current
    if (element === null) return
    const rowsTop = viewportRef.current.rowsTop
    const localScroll = Math.max(0, element.scrollTop - rowsTop)
    const next = scrollTopForRow({
      index,
      rowCount: Math.max(index + 1, rowsRef.current.length),
      scrollTop: localScroll,
      viewportHeight: element.clientHeight
    })
    element.scrollTop = Math.max(0, rowsTop + next)
  }, [])

  const focusRowElement = useCallback((path: string, attempt = 0): void => {
    const element = rowRefs.current.get(path)
    if (element !== undefined) {
      element.focus({ preventScroll: true })
      return
    }
    if (attempt >= 12) return
    window.setTimeout(() => focusRowElement(path, attempt + 1), 16)
  }, [])

  useLayoutEffect(() => {
    const element = treeScrollRef.current
    if (element === null) return
    const height = element.clientHeight
    const rowsTop = rowsContainerRef.current?.offsetTop ?? 0
    setViewport((current) =>
      current.height === height && current.rowsTop === rowsTop
        ? current
        : { ...current, height, rowsTop }
    )
  })

  useEffect(() => {
    const element = treeScrollRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const rowsTop = rowsContainerRef.current?.offsetTop ?? 0
      const height = element.clientHeight
      setViewport((current) =>
        current.height === height && current.rowsTop === rowsTop
          ? current
          : { ...current, height, rowsTop }
      )
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  /** Invalidates in-flight directory reads when the session or refresh key changes. */
  const treeGeneration = useRef(0)
  const treeResetKey = useRef('')
  const resetKey = `${sessionId}\u0000${String(refreshToken)}`
  if (treeResetKey.current !== resetKey) {
    treeResetKey.current = resetKey
    treeGeneration.current += 1
  }

  const loadDirectory = useCallback(
    async (
      path: string,
      quiet = false,
      chainDepth = 0,
      /** Only a user-visible expansion discovers chains in sibling folders. */
      allowFanout = true
    ): Promise<void> => {
      const generation = treeGeneration.current
      setTree((current) => ({ ...current, loading: { ...current.loading, [path]: true } }))
      const result = await callApi<FilesListingPayload>(
        window.icode.files.list({ sessionId, path })
      )
      if (generation !== treeGeneration.current) return
      if (!result.ok) {
        if (!quiet) notify(errorNotice(result.error))
        setTree((current) => {
          const loading = { ...current.loading }
          delete loading[path]
          return { ...current, loading }
        })
        return
      }
      const value = result.value
      if (value.status === 'unavailable') {
        if (path === '') {
          setRootState('unavailable')
          setRootNote(unavailableText(value))
        }
        setTree((current) => {
          const loading = { ...current.loading }
          delete loading[path]
          return { ...current, loading }
        })
        return
      }
      if (path === '') {
        setRootState('ready')
        setRootNote(value.truncated ? 'Showing the first 2000 entries.' : '')
      }
      if (excludeGitIgnoreRef.current && value.entries.length > 0) {
        const check = await callApi<GitCheckIgnorePayload>(
          window.icode.git.checkIgnore({
            sessionId,
            paths: value.entries.map((entry) => entry.path)
          })
        )
        if (generation !== treeGeneration.current) return
        if (check.ok && check.value.status === 'ok') {
          const ignored = new Set(check.value.ignored)
          setIgnoredByDirectory((current) => ({ ...current, [path]: ignored }))
          setIgnoreNote('')
        } else {
          setIgnoredByDirectory((current) => {
            const next = { ...current }
            delete next[path]
            return next
          })
          setIgnoreNote('Ignore rules unavailable; ignored files stay visible.')
        }
      } else if (excludeGitIgnoreRef.current) {
        setIgnoredByDirectory((current) => ({ ...current, [path]: new Set() }))
      }
      setTree((current) => {
        const loading = { ...current.loading }
        delete loading[path]
        return {
          ...current,
          children: { ...current.children, [path]: value.entries },
          loading
        }
      })
      // Compact labels need the next level of single-directory chains. A user
      // expansion speculatively lists its directory children (bounded) so the
      // first render already shows `a/b/c`; the recursive preloads only follow
      // chains, so this never walks a whole subtree.
      if (generation !== treeGeneration.current) return
      const candidates: FileEntry[] = []
      if (compactFoldersRef.current && chainDepth < 64) {
        const only = value.entries[0]
        if (
          value.entries.length === 1 &&
          only !== undefined &&
          only.kind === 'directory' &&
          !isGitMetadata(only.path)
        ) {
          candidates.push(only)
        } else if (allowFanout) {
          for (const entry of value.entries) {
            if (entry.kind === 'directory' && !isGitMetadata(entry.path)) {
              candidates.push(entry)
            }
          }
        }
      }
      const preloadLimit = allowFanout ? 24 : 1
      for (const child of candidates.slice(0, preloadLimit)) {
        preloadedDirectories.current.add(child.path)
        void loadDirectory(child.path, true, chainDepth + 1, false)
      }
    },
    [notify, sessionId]
  )

  const refreshTrash = useCallback(async (): Promise<void> => {
    const result = await callApi<FilesTrashListPayload>(
      window.icode.files.listTrash({ sessionId })
    )
    if (!result.ok || result.value.status !== 'ok') {
      setTrashBanner(null)
      return
    }
    const latest = result.value.items[0]
    setTrashBanner(
      latest === undefined
        ? null
        : { opId: latest.opId, paths: latest.entries.map((entry) => entry.path) }
    )
  }, [sessionId])

  useEffect(() => {
    const warning = openFilesStore.takeHotExitWarning()
    if (warning !== null) setHotExitNote(warning)
  }, [])

  // A different session means a different checkout: reset the tree and the
  // panel-local surfaces. Open tabs are session-keyed and deliberately survive.
  useEffect(() => {
    searchSequence.current += 1
    const persisted = loadTreeState(sessionId)
    const expanded: Record<string, boolean> = { '': true }
    for (const path of persisted?.expanded ?? []) {
      if (path !== '') expanded[path] = true
    }
    setTree({ expanded, children: {}, loading: {} })
    setResults(null)
    setQuery('')
    setSearchError(null)
    setSearchNote('')
    setCollapsedSearchFiles(new Set())
    setReplacePrompt(null)
    setReplaceBusy(false)
    setReplaceReport([])
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
  }, [loadDirectory, refreshTrash, sessionId, refreshToken])

  // Persist the explorer position after the user stops moving for a moment.
  useEffect(() => {
    if (rootState !== 'ready' || query.trim().length > 0) return
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
  }, [query, rootState, selection, sessionId, tree.expanded, viewport.scrollTop])

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

  /**
   * Git decorations are a lightweight status read while Files is visible. The
   * Files watcher schedules a debounced refresh; there is no second watcher.
   */
  const fetchDecorations = useCallback(async (): Promise<void> => {
    if (!decorationsEnabled.current || !activeRef.current) return
    if (decorationBusy.current) {
      decorationAgain.current = true
      return
    }
    decorationBusy.current = true
    const requestSession = sessionId
    const result = await callApi<GitStatusPayload>(
      window.icode.git.status({ sessionId })
    )
    decorationBusy.current = false
    if (
      requestSession !== sessionIdRef.current ||
      !decorationsEnabled.current ||
      !activeRef.current
    ) {
      return
    }
    if (result.ok && result.value.status === 'ok') {
      setDecorations(buildFileDecorations(result.value.snapshot))
    } else {
      setDecorations(EMPTY_DECORATIONS)
    }
    if (decorationAgain.current) {
      decorationAgain.current = false
      scheduleDecorationsRef.current?.()
    }
  }, [sessionId])

  const scheduleDecorations = useCallback(
    (delay = 400): void => {
      if (!decorationsEnabled.current || !activeRef.current) return
      if (decorationTimer.current !== null) window.clearTimeout(decorationTimer.current)
      decorationTimer.current = window.setTimeout(() => {
        decorationTimer.current = null
        void fetchDecorations()
      }, delay)
    },
    [fetchDecorations]
  )
  scheduleDecorationsRef.current = scheduleDecorations

  useEffect(() => {
    decorationsEnabled.current = settings.gitDecorations
    if (!active || !settings.gitDecorations) {
      setDecorations(EMPTY_DECORATIONS)
      return
    }
    void fetchDecorations()
    return () => {
      if (decorationTimer.current !== null) {
        window.clearTimeout(decorationTimer.current)
        decorationTimer.current = null
      }
    }
  }, [active, fetchDecorations, settings.gitDecorations])

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
        openFilesStore.setFailure(sessionId, path, 'That file is binary, so it is not shown here.')
        return false
      }
      if (value.tooLarge) {
        openFilesStore.setFailure(sessionId, path, 'That file is too large to open in the editor.')
        return false
      }
      openFilesStore.setContent(sessionId, path, { text: value.text, etag: value.etag })
      return true
    },
    [notify, sessionId]
  )

  /** Expands the ancestors of a file so opening it always reveals its row. */
  const revealPath = useCallback(
    async (path: string): Promise<void> => {
      const segments = path.split('/')
      if (segments.length <= 1) return
      const loaded = new Set(Object.keys(tree.children))
      let prefix = ''
      for (let index = 0; index < segments.length - 1; index += 1) {
        prefix = prefix === '' ? (segments[index] ?? '') : `${prefix}/${segments[index] ?? ''}`
        setTree((current) =>
          current.expanded[prefix] === true
            ? current
            : { ...current, expanded: { ...current.expanded, [prefix]: true } }
        )
        if (!loaded.has(prefix)) {
          loaded.add(prefix)
          await loadDirectory(prefix)
        }
      }
    },
    [loadDirectory, tree.children]
  )
  revealPathRef.current = revealPath

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

  const loadTab = useCallback(
    async (path: string, line: number): Promise<void> => {
      setFileNote('')
      setEditorMode('tab')
      setGotoLine(line)
      const sequence = ++revealSequence.current
      void revealPath(path).then(() => {
        if (revealSequence.current !== sequence) return
        if (openFilesStore.find(sessionId, path) === null) return
        setSelection({ selected: new Set([path]), anchor: path, focused: path })
      })
      const opened = openFilesStore.open(sessionId, path)
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
        openFilesStore.setFailure(sessionId, path, 'That file is binary, so it is not shown here.')
        return
      }
      if (value.tooLarge) {
        openFilesStore.setFailure(sessionId, path, 'That file is too large to open in the editor.')
        return
      }
      if (!openFilesStore.canStore(sessionId, path, value.text.length)) {
        openFilesStore.setFailure(
          sessionId,
          path,
          'This file would exceed the open-file text budget. Close a tab and try again.'
        )
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
    [revealPath, sessionId]
  )

  const openPath = useCallback(
    async (path: string, line = 1): Promise<void> => {
      setFileNote('')
      if (isGitMetadata(path)) {
        setEditorMode('tab')
        setFileNote('Git metadata is managed by Git and is not editable here.')
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

  /**
   * Watches the worktree only while Files is visible. A watcher that cannot
   * start (ext4 guest today) falls back to a two-second stat/list poll; a
   * failed watch does the same from its `failed` event.
   */
  useEffect(() => {
    if (!active) {
      setLiveState('off')
      return
    }
    let cancelled = false
    let pollTimer: number | null = null

    const reloadCleanTab = async (path: string): Promise<void> => {
      const read = await callApi<FileContentPayload>(
        window.icode.files.read({ sessionId, path })
      )
      if (cancelled || openFilesStore.find(sessionId, path) === null) return
      if (!read.ok) return
      const value = read.value
      if (value.status === 'unavailable') {
        if (value.reason === 'not-found') openFilesStore.markDiskDeleted(sessionId, path)
        return
      }
      if (value.binary || value.tooLarge) {
        openFilesStore.markDiskChanged(sessionId, path)
        return
      }
      // The user may have typed while the read was in flight. Never replace a
      // buffer that became dirty after the clean check.
      const current = openFilesStore.find(sessionId, path)
      if (current === null) return
      if (isDirty(current)) {
        openFilesStore.markDiskChanged(sessionId, path)
        return
      }
      openFilesStore.setContent(sessionId, path, { text: value.text, etag: value.etag })
    }

    let reconciling = false
    let reconcileAgain = false

    const reconcile = async (): Promise<void> => {
      if (cancelled || rootStateRef.current !== 'ready') return
      if (reconciling) {
        reconcileAgain = true
        return
      }
      reconciling = true
      try {
        await reloadExpandedRef.current(true)
        clearWorktreeFileIndex(sessionId)
        const state = openFilesStore.get(sessionId)
        for (const tab of state.tabs) {
          if (cancelled) return
          if (tab.load !== 'ready') continue
          const stat = await callApi<FilesStatPayload>(
            window.icode.files.stat({ sessionId, path: tab.path })
          )
          if (cancelled) return
          if (!stat.ok) continue
          const value = stat.value
          if (value.status === 'unavailable') {
            if (value.reason === 'not-found') {
              openFilesStore.markDiskDeleted(sessionId, tab.path)
            }
            continue
          }
          if (value.etag === tab.etag) {
            openFilesStore.markDiskCurrent(sessionId, tab.path)
            continue
          }
          const current = openFilesStore.find(sessionId, tab.path)
          if (current === null) continue
          if (isDirty(current)) openFilesStore.markDiskChanged(sessionId, current.path)
          else await reloadCleanTab(current.path)
        }
      } finally {
        reconciling = false
        if (reconcileAgain && !cancelled) {
          reconcileAgain = false
          void reconcile()
        }
      }
    }

    const startPolling = (): void => {
      if (cancelled || pollTimer !== null) return
      setLiveState('poll')
      pollTimer = window.setInterval(() => {
        void reconcile()
      }, 2000)
    }

    const unsubscribe = window.icode.files.onChanged((event) => {
      if (event.sessionId !== sessionId) return
      if (event.failed) {
        startPolling()
        return
      }
      setLiveState('watch')
      void reconcile()
    })

    void reconcile()
    void window.icode.files
      .watch({ sessionId, active: true })
      .then((result) => {
        if (cancelled) return
        if (!result.ok || !result.value.watching) {
          startPolling()
          return
        }
        setLiveState('watch')
        void reconcile()
      })

    return () => {
      cancelled = true
      unsubscribe()
      if (pollTimer !== null) window.clearInterval(pollTimer)
      setLiveState('off')
      void window.icode.files.watch({ sessionId, active: false })
    }
  }, [active, sessionId])

  const setActiveTab = (path: string): void => {
    openFilesStore.setActive(sessionId, path)
    setSelection({ selected: new Set([path]), anchor: path, focused: path })
    setEditorMode('tab')
    setGotoLine(null)
  }

  useEffect(() => {
    if (sessionFiles.activePath === null) return
    tabRefs.current
      .get(sessionFiles.activePath)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [sessionFiles.activePath])

  const findEntry = (path: string): FileEntry | null => {
    for (const entries of Object.values(tree.children)) {
      const found = entries.find((entry) => entry.path === path)
      if (found) return found
    }
    return null
  }

  const siblingsOf = (parent: string): string[] =>
    (tree.children[parent] ?? []).map((entry) => entry.name)

  const selectedPaths = (): string[] => {
    const paths = collapseSelectedPaths([...selection.selected])
    if (paths.length > 0) return paths
    return selection.focused === null ? [] : [selection.focused]
  }

  const createParent = (): string => {
    const focused =
      selection.focused !== null && selection.selected.has(selection.focused)
        ? findEntry(selection.focused)
        : null
    if (focused?.kind === 'directory') return focused.path
    if (focused !== null) return parentPathOf(focused.path)
    if (selection.selected.size === 1) {
      const only = findEntry([...selection.selected][0] ?? '')
      if (only?.kind === 'directory') return only.path
      if (only !== null) return parentPathOf(only.path)
    }
    return ''
  }

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

  const selectOnly = (path: string): void => {
    setSelection({ selected: new Set([path]), anchor: path, focused: path })
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
        setEditError('Git metadata cannot be renamed here.')
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
        message: `Renamed to ${to}`,
        action: { label: 'Undo', run: () => void undoLast() }
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
      setEditError('Git metadata cannot be created here.')
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
      action: { label: 'Undo', run: () => void undoLast() }
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

  const pushUndoEntry = (entry: FileUndoEntry): void => {
    setUndoStack((current) => pushUndo(current, entry))
  }

  const closeTabsUnder = (paths: readonly string[]): void => {
    for (const path of paths) {
      for (const tab of openFilesStore.get(sessionId).tabs) {
        if (isUnder(tab.path, path)) openFilesStore.closeTab(sessionId, tab.path)
      }
    }
  }

  const restoreTrashOp = async (opId: string): Promise<boolean> => {
    setUndoing(true)
    const result = await callApi<FilesRestoreTrashPayload>(
      window.icode.files.restoreTrash({ sessionId, opId })
    )
    setUndoing(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      await refreshTrash()
      return false
    }
    if (result.value.status === 'unavailable') {
      notify({ tone: 'error', message: unavailableText(result.value) })
      await refreshTrash()
      return false
    }
    const failures = result.value.results.filter((entry) => !entry.ok)
    const successes = result.value.results.filter((entry) => entry.ok)
    if (failures.length === 0) {
      setUndoStack((current) =>
        current.filter((entry) => entry.kind !== 'delete' || entry.opId !== opId)
      )
      const first = successes[0]?.path
      if (first !== undefined) {
        selectOnly(first)
        setEditorMode(successes.length === 1 ? 'tab' : 'folder')
      }
      notify({
        tone: 'success',
        message: `Restored ${String(successes.length)} item${successes.length === 1 ? '' : 's'}`
      })
    } else {
      const first = failures[0]
      setSelection({
        selected: new Set(failures.map((entry) => entry.path)),
        anchor: first?.path ?? null,
        focused: first?.path ?? null
      })
      setEditorMode('folder')
      notify({
        tone: 'error',
        message: `${String(successes.length)} restored · ${String(failures.length)} failed: ${first?.detail ?? 'unknown error'}`
      })
    }
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    scheduleDecorationsRef.current?.(0)
    await refreshTrash()
    return failures.length === 0
  }

  const requestDelete = (
    paths: readonly string[],
    permanentOnly = false
  ): void => {
    const targets = collapseSelectedPaths(paths.filter((path) => path !== ''))
    if (targets.length === 0) return
    setDeletePrompt({ paths: targets, permanentOnly })
  }

  const confirmPermanentDelete = async (): Promise<void> => {
    if (deletePrompt === null) return
    setTransferBusy(true)
    const result = await callApi<FilesBatchPayload>(
      window.icode.files.removeMany({ sessionId, paths: deletePrompt.paths })
    )
    if (!result.ok) {
      setTransferBusy(false)
      notify(errorNotice(result.error))
      setDeletePrompt(null)
      return
    }
    if (result.value.status === 'unavailable') {
      setTransferBusy(false)
      notify({ tone: 'error', message: unavailableText(result.value) })
      setDeletePrompt(null)
      return
    }
    const successes = result.value.results.filter((entry) => entry.ok)
    const failures = result.value.results.filter((entry) => !entry.ok)
    closeTabsUnder(successes.map((entry) => entry.path))
    setDeletePrompt(null)
    if (failures.length === 0) {
      setSelection(EMPTY_SELECTION)
      setEditorMode('tab')
      notify({
        tone: 'success',
        message: `Deleted ${String(successes.length)} item${successes.length === 1 ? '' : 's'} permanently`
      })
    } else {
      const first = failures[0]
      setSelection({
        selected: new Set(failures.map((entry) => entry.path)),
        anchor: first?.path ?? null,
        focused: first?.path ?? null
      })
      setEditorMode('folder')
      notify({
        tone: 'error',
        message: `${String(successes.length)} deleted · ${String(failures.length)} failed: ${first?.detail ?? 'unknown error'}`
      })
    }
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    scheduleDecorationsRef.current?.(0)
    setTransferBusy(false)
  }

  const confirmTrashDelete = async (): Promise<void> => {
    if (deletePrompt === null) return
    setTransferBusy(true)
    const result = await callApi<FilesTrashPayload>(
      window.icode.files.trashMany({ sessionId, paths: deletePrompt.paths })
    )
    if (!result.ok) {
      setTransferBusy(false)
      notify(errorNotice(result.error))
      setDeletePrompt(null)
      return
    }
    if (result.value.status === 'unavailable') {
      setTransferBusy(false)
      notify({ tone: 'error', message: unavailableText(result.value) })
      setDeletePrompt(null)
      return
    }
    const successes = result.value.entries.map((entry) => entry.path)
    const failures = result.value.results.filter((entry) => !entry.ok)
    closeTabsUnder(successes)
    setDeletePrompt(null)
    if (successes.length > 0) {
      if (result.value.opId !== null) {
        const opId = result.value.opId
        setTrashBanner({ opId, paths: successes })
        pushUndoEntry({
          kind: 'delete',
          opId,
          paths: successes,
          at: Date.now()
        })
        notify({
          tone: failures.length === 0 ? 'success' : 'info',
          message:
            `Moved ${String(successes.length)} item${successes.length === 1 ? '' : 's'} to Trash` +
            (failures.length > 0 ? ` · ${String(failures.length)} failed` : ''),
          action: {
            label: 'Undo',
            run: () => {
              void restoreTrashOp(opId)
            }
          }
        })
      }
    } else {
      notify({
        tone: 'error',
        message:
          failures[0]?.detail ?? 'Nothing could be moved to Trash.'
      })
    }
    if (failures.length > 0) {
      const first = failures[0]
      setSelection({
        selected: new Set(failures.map((entry) => entry.path)),
        anchor: first?.path ?? null,
        focused: first?.path ?? null
      })
      setEditorMode('folder')
    } else {
      setSelection(EMPTY_SELECTION)
      setEditorMode('tab')
    }
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    scheduleDecorationsRef.current?.(0)
    await refreshTrash()
    setTransferBusy(false)
  }

  const confirmDelete = async (): Promise<void> => {
    if (deletePrompt === null) return
    if (settings.useTrash && !deletePrompt.permanentOnly) {
      await confirmTrashDelete()
    } else {
      await confirmPermanentDelete()
    }
  }

  const undoLast = async (): Promise<void> => {
    if (undoing || transferBusy) return
    const entry = peekUndo(undoStack)
    if (entry === null) {
      notify({ tone: 'info', message: 'Nothing to undo.' })
      return
    }
    setUndoing(true)
    let ok = false
    let partial = false
    let detail = ''
    try {
      if (entry.kind === 'create') {
        const stat = await callApi<FilesStatPayload>(
          window.icode.files.stat({ sessionId, path: entry.path })
        )
        let safe = false
        if (!stat.ok) {
          detail = stat.error.message
        } else if (stat.value.status === 'unavailable') {
          if (stat.value.reason === 'not-found') safe = true
          else detail = unavailableText(stat.value)
        } else if (stat.value.kind === 'directory') {
          const listing = await callApi<FilesListingPayload>(
            window.icode.files.list({ sessionId, path: entry.path })
          )
          if (listing.ok && listing.value.status === 'ok') {
            safe = listing.value.entries.length === 0
            if (!safe) detail = 'The new folder now contains files.'
          } else if (!listing.ok) {
            detail = listing.error.message
          } else if (listing.value.status === 'unavailable') {
            detail = unavailableText(listing.value)
          }
        } else if (entry.etag === null) {
          detail = 'That file has no recorded version to compare.'
        } else if (stat.value.etag === entry.etag) {
          safe = true
        } else {
          detail = 'That file changed after it was created.'
        }
        if (safe) {
          const result = await callApi<FilesBatchPayload>(
            window.icode.files.removeMany({ sessionId, paths: [entry.path] })
          )
          if (result.ok && result.value.status === 'ok') {
            ok = result.value.results.every((item) => item.ok)
            if (!ok) detail = result.value.results.find((item) => !item.ok)?.detail ?? ''
          } else if (!result.ok) {
            detail = result.error.message
          } else if (result.value.status === 'unavailable') {
            detail = unavailableText(result.value)
          }
        }
      } else if (entry.kind === 'rename') {
        const result = await callApi<FilesMutatePayload>(
          window.icode.files.rename({ sessionId, from: entry.to, to: entry.from })
        )
        if (result.ok && result.value.status === 'ok') {
          ok = true
          selectOnly(entry.from)
        } else {
          detail = !result.ok
            ? result.error.message
            : result.value.status === 'unavailable'
              ? unavailableText(result.value)
              : ''
        }
      } else if (entry.kind === 'move') {
        const failed: Array<{ from: string; to: string }> = []
        for (const pair of entry.pairs) {
          const result = await callApi<FilesMutatePayload>(
            window.icode.files.rename({
              sessionId,
              from: pair.to,
              to: pair.from
            })
          )
          if (!result.ok) {
            failed.push(pair)
            detail = result.error.message
          } else if (result.value.status === 'unavailable') {
            failed.push(pair)
            detail = unavailableText(result.value)
          }
        }
        if (failed.length === 0) ok = true
        else {
          partial = true
          setUndoStack((current) => [
            { ...entry, pairs: failed },
            ...current.slice(1)
          ])
        }
      } else if (entry.kind === 'copy') {
        const safe: string[] = []
        const unsafe: Array<{ path: string; etag: string | null }> = []
        for (const item of entry.created) {
          const stat = await callApi<FilesStatPayload>(
            window.icode.files.stat({ sessionId, path: item.path })
          )
          if (!stat.ok) {
            unsafe.push(item)
            detail = stat.error.message
          } else if (stat.value.status === 'unavailable') {
            if (stat.value.reason === 'not-found') continue
            unsafe.push(item)
            detail = unavailableText(stat.value)
          } else if (
            item.etag !== null &&
            stat.value.kind === 'file' &&
            stat.value.etag === item.etag
          ) {
            safe.push(item.path)
          } else {
            unsafe.push(item)
            detail = 'A copy changed after it was made.'
          }
        }
        if (safe.length > 0) {
          const result = await callApi<FilesBatchPayload>(
            window.icode.files.removeMany({ sessionId, paths: safe })
          )
          if (result.ok && result.value.status === 'ok') {
            for (const item of result.value.results) {
              if (!item.ok) unsafe.push({ path: item.path, etag: null })
            }
          } else if (!result.ok) {
            detail = result.error.message
            for (const path of safe) unsafe.push({ path, etag: null })
          } else if (result.value.status === 'unavailable') {
            detail = unavailableText(result.value)
            for (const path of safe) unsafe.push({ path, etag: null })
          }
        }
        if (unsafe.length === 0) ok = true
        else {
          partial = true
          setUndoStack((current) => [
            { ...entry, created: unsafe },
            ...current.slice(1)
          ])
        }
      } else {
        const restored = await restoreTrashOp(entry.opId)
        if (!restored) {
          // restoreTrashOp reports the conflict and keeps the entry retryable.
          return
        }
        return
      }
    } finally {
      setUndoing(false)
    }
    if (ok) setUndoStack((current) => popUndo(current))
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    scheduleDecorationsRef.current?.(0)
    if (ok) {
      notify({ tone: 'success', message: `Undid ${undoLabel(entry).replace(/^Undo /u, '')}` })
    } else if (!partial) {
      notify({
        tone: 'error',
        message: `Could not undo: ${detail || 'the path changed on disk'}`
      })
    } else {
      notify({
        tone: 'info',
        message: `Undo partially applied: ${detail || 'some paths were not changed'}`
      })
    }
  }

  const copySelection = (mode: 'copy' | 'cut', paths = selectedPaths()): void => {
    const targets = collapseSelectedPaths(paths.filter((path) => path !== ''))
    if (targets.length === 0) return
    filesClipboardStore.set({ sessionId, paths: targets, mode })
  }

  const collectEtags = async (
    paths: readonly string[]
  ): Promise<Array<{ path: string; etag: string | null }>> =>
    Promise.all(
      paths.map(async (path) => {
        const stat = await callApi<FilesStatPayload>(
          window.icode.files.stat({ sessionId, path })
        )
        return {
          path,
          etag:
            stat.ok && stat.value.status === 'ok' && stat.value.kind === 'file'
              ? stat.value.etag
              : null
        }
      })
    )

  const duplicateSelection = async (paths = selectedPaths()): Promise<void> => {
    const targets = collapseSelectedPaths(paths.filter((path) => path !== ''))
    if (targets.length === 0) {
      notify({ tone: 'info', message: 'Select something to duplicate.' })
      return
    }
    if (transferBusy) return
    setTransferBusy(true)
    const created: string[] = []
    let detail = ''
    for (const target of targets) {
      const result = await callApi<FilesBatchPayload>(
        window.icode.files.copyMany({
          sessionId,
          paths: [target],
          destination: parentPathOf(target)
        })
      )
      if (!result.ok) {
        detail = result.error.message
        continue
      }
      if (result.value.status === 'unavailable') {
        detail = unavailableText(result.value)
        continue
      }
      for (const entry of result.value.results) {
        if (entry.ok && entry.to !== undefined) created.push(entry.to)
        else if (!entry.ok && detail === '') detail = entry.detail ?? ''
      }
    }
    setTransferBusy(false)
    if (created.length === 0) {
      notify({
        tone: 'error',
        message: `Nothing could be duplicated${detail ? `: ${detail}` : '.'}`
      })
      return
    }
    pushUndoEntry({
      kind: 'copy',
      created: await collectEtags(created),
      at: Date.now()
    })
    clearWorktreeFileIndex(sessionId)
    await reloadExpanded()
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve())
    })
    setSelection({
      selected: new Set(created),
      anchor: created[0] ?? null,
      focused: created[0] ?? null
    })
    setEditorMode(created.length === 1 ? 'tab' : 'folder')
    notify({
      tone: 'success',
      message: `Duplicated ${String(created.length)} item${created.length === 1 ? '' : 's'}`,
      action: { label: 'Undo', run: () => void undoLast() }
    })
  }

  const copyPathsToClipboard = async (
    format: 'absolute' | 'relative',
    paths: readonly string[]
  ): Promise<void> => {
    const targets = collapseSelectedPaths(paths.filter((path) => path !== ''))
    if (targets.length === 0) return
    const result = await callApi<FilesCopyPathsPayload>(
      window.icode.files.copyPaths({ sessionId, paths: targets, format })
    )
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    if (result.value.status === 'unavailable') {
      notify({ tone: 'error', message: unavailableText(result.value) })
      return
    }
    notify({
      tone: 'success',
      message: `Copied ${String(result.value.count)} path${result.value.count === 1 ? '' : 's'}`
    })
  }

  type TransferOutcome = {
    allOk: boolean
    succeeded: number
    failures: FileBatchEntry[]
  }

  const performTransfer = async (
    mode: 'copy' | 'move',
    paths: readonly string[],
    destination: string
  ): Promise<TransferOutcome> => {
    const targets = collapseSelectedPaths(paths.filter((path) => path !== ''))
    if (targets.length === 0) return { allOk: false, succeeded: 0, failures: [] }
    for (const target of targets) {
      if (destination === target || destination.startsWith(`${target}/`)) {
        notify({ tone: 'error', message: 'An item cannot be moved or copied into itself.' })
        return { allOk: false, succeeded: 0, failures: [] }
      }
    }
    const kinds = new Map<string, FileEntry['kind']>()
    for (const target of targets) {
      const entry = findEntry(target)
      if (entry !== null) kinds.set(target, entry.kind)
    }

    setTransferBusy(true)
    const result = await callApi<FilesBatchPayload>(
      mode === 'move'
        ? window.icode.files.moveMany({ sessionId, paths: targets, destination })
        : window.icode.files.copyMany({ sessionId, paths: targets, destination })
    )
    if (!result.ok) {
      setTransferBusy(false)
      notify(errorNotice(result.error))
      return { allOk: false, succeeded: 0, failures: [] }
    }
    if (result.value.status === 'unavailable') {
      setTransferBusy(false)
      notify({ tone: 'error', message: unavailableText(result.value) })
      return { allOk: false, succeeded: 0, failures: [] }
    }

    const successes = result.value.results.filter((entry) => entry.ok && !entry.skipped)
    const failures = result.value.results.filter((entry) => !entry.ok)
    if (successes.length > 0) {
      if (mode === 'move') {
        pushUndoEntry({
          kind: 'move',
          pairs: successes.flatMap((entry) =>
            entry.from !== undefined && entry.to !== undefined
              ? [{ from: entry.from, to: entry.to }]
              : []
          ),
          at: Date.now()
        })
      } else {
        pushUndoEntry({
          kind: 'copy',
          created: await collectEtags(
            successes.flatMap((entry) =>
              entry.to === undefined ? [] : [entry.to]
            )
          ),
          at: Date.now()
        })
      }
    }
    if (mode === 'move') {
      for (const entry of successes) {
        if (entry.from !== undefined && entry.to !== undefined) {
          openFilesStore.renamePath(sessionId, entry.from, entry.to)
        }
      }
    }
    const first = successes.find((entry) => entry.to !== undefined)
    clearWorktreeFileIndex(sessionId)
    if (destination !== '') await expandFolder(destination)
    await reloadExpanded()
    if (first?.to !== undefined) {
      // Let the refreshed rows render before selecting the new path; otherwise
      // the prune pass would drop a target the tree does not know yet.
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve())
      })
      selectOnly(first.to)
      setEditorMode('tab')
      if (mode === 'copy' && successes.length === 1) {
        const source = first.from ?? first.path
        if (kinds.get(source) === 'file') await openPath(first.to, 1)
      }
    }

    if (failures.length > 0) {
      const detail = failures[0]?.detail ?? 'unknown error'
      notify({
        tone: 'error',
        message: `${String(successes.length)} ${mode === 'move' ? 'moved' : 'copied'} · ${String(failures.length)} failed: ${detail}`,
        ...(successes.length === 0
          ? {}
          : { action: { label: 'Undo', run: () => void undoLast() } })
      })
    } else if (successes.length === 0) {
      notify({ tone: 'info', message: 'No items needed moving.' })
    } else {
      notify({
        tone: 'success',
        message: `${mode === 'move' ? 'Moved' : 'Copied'} ${String(successes.length)} item${successes.length === 1 ? '' : 's'}`,
        action: { label: 'Undo', run: () => void undoLast() }
      })
    }
    setTransferBusy(false)
    return { allOk: failures.length === 0, succeeded: successes.length, failures }
  }
  const pasteInto = async (destination: string): Promise<void> => {
    const current = filesClipboardStore.get()
    if (current === null || current.sessionId !== sessionId) {
      notify({
        tone: 'error',
        message:
          current === null
            ? 'The Files clipboard is empty.'
            : 'Files can only be pasted into the same session worktree.'
      })
      return
    }
    const transferMode = current.mode === 'cut' ? 'move' : 'copy'
    const outcome = await performTransfer(transferMode, current.paths, destination)
    if (current.mode === 'cut') {
      if (outcome.allOk) filesClipboardStore.clear()
      else if (outcome.succeeded > 0) {
        filesClipboardStore.set({
          sessionId,
          paths: outcome.failures.map((entry) => entry.path),
          mode: 'cut'
        })
      }
    }
  }

  const expandFolder = async (path: string): Promise<void> => {
    setTree((current) => ({ ...current, expanded: { ...current.expanded, [path]: true } }))
    // Always refresh on expansion: the row may have been preloaded only as a
    // side effect of compact-chain discovery in its parent.
    await loadDirectory(path)
  }

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
      notify({ tone: 'info', message: 'Those items are already in that folder.' })
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

  const searchOptions = useMemo(
    () => ({
      caseSensitive: searchCaseSensitive,
      wholeWord: searchWholeWord,
      regex: searchRegex,
      include: parsePatterns(searchInclude),
      exclude: parsePatterns(searchExclude),
      limit: 200
    }),
    [searchCaseSensitive, searchExclude, searchInclude, searchRegex, searchWholeWord]
  )

  const runSearch = async (): Promise<void> => {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setResults(null)
      setSearchError(null)
      return
    }
    const matcher = compileTextMatcher(trimmed, searchOptions)
    if (matcher.error !== null) {
      // Keep the previous results visible; the error explains why nothing new
      // is coming without erasing the user's last working scan.
      setSearchError(matcher.error)
      return
    }
    const sequence = ++searchSequence.current
    setSearching(true)
    setSearchError(null)
    setSearchNote('')
    setReplaceReport([])
    const result = await callApi<FileSearchPayload>(
      window.icode.files.search({ sessionId, query: trimmed, ...searchOptions })
    )
    if (searchSequence.current !== sequence) return
    setSearching(false)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    const value = result.value
    if (value.status === 'unavailable') {
      setResults(value)
      setSearchNote('')
      if (value.reason === 'invalid-query') setSearchError(value.detail)
      else notify({ tone: 'error', message: unavailableText(value) })
      return
    }
    let matches = value.matches.filter(
      (match) =>
        !isGitMetadata(match.path) &&
        isSearchPathIncluded(match.path, [], settings.exclude)
    )
    let note = ''
    if (settings.excludeGitIgnore && matches.length > 0) {
      const check = await callApi<GitCheckIgnorePayload>(
        window.icode.git.checkIgnore({
          sessionId,
          paths: [...new Set(matches.map((match) => match.path))]
        })
      )
      if (searchSequence.current !== sequence) return
      if (check.ok && check.value.status === 'ok') {
        const ignored = new Set(check.value.ignored)
        matches = matches.filter((match) => !ignored.has(match.path))
      } else {
        note = 'Git ignore rules unavailable; ignored results stay visible.'
      }
    }
    if (searchSequence.current !== sequence) return
    setResults({ ...value, matches })
    setSearchNote(note)
  }

  /** Stops the in-flight scan; the backend cancels the current search. */
  const stopSearch = async (): Promise<void> => {
    searchSequence.current += 1
    setSearching(false)
    setResults(null)
    setSearchNote('Search cancelled.')
    await callApi<{ cancelled: boolean }>(window.icode.files.cancelSearch({ sessionId }))
  }

  const requestReplace = (): void => {
    const trimmed = query.trim()
    if (trimmed.length === 0) return
    if (searchRegex) {
      setSearchError('Regex replace is not supported yet. Turn off Use regex to replace literal text.')
      return
    }
    if (results === null || results.status !== 'ok' || results.matches.length === 0) {
      setSearchNote('Run a search before replacing.')
      return
    }
    const matcher = compileTextMatcher(trimmed, searchOptions)
    if (matcher.error !== null) {
      setSearchError(matcher.error)
      return
    }
    setSearchError(null)
    const paths = [...new Set(results.matches.map((match) => match.path))]
    setReplacePrompt({
      matches: results.matches.length,
      files: paths.length,
      paths
    })
  }

  const confirmReplace = async (): Promise<void> => {
    if (replacePrompt === null) return
    const trimmed = query.trim()
    if (trimmed.length === 0) return
    const paths =
      results !== null && results.status === 'ok'
        ? [...new Set(results.matches.map((match) => match.path))]
        : []
    setReplaceBusy(true)
    const result = await callApi<FilesReplacePayload>(
      window.icode.files.replace({
        sessionId,
        query: trimmed,
        replacement: replaceText,
        caseSensitive: searchCaseSensitive,
        wholeWord: searchWholeWord,
        regex: false,
        include: searchOptions.include,
        exclude: searchOptions.exclude,
        paths
      })
    )
    setReplaceBusy(false)
    setReplacePrompt(null)
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    const value = result.value
    if (value.status === 'unavailable') {
      if (value.reason === 'invalid-query') setSearchError(value.detail)
      else notify({ tone: 'error', message: unavailableText(value) })
      return
    }
    // Open tabs that are clean follow the new disk text; dirty tabs keep the
    // user's buffer and will surface the change through the conflict dialog.
    for (const entry of value.results) {
      if (!entry.ok || entry.replaced === 0) continue
      const tab = openFilesStore.find(sessionId, entry.path)
      if (tab !== null && !isDirty(tab)) await reloadFromDisk(entry.path, true)
    }
    const skipped = value.results.filter((entry) => !entry.ok).length
    notify({
      tone: skipped > 0 ? 'info' : 'success',
      message:
        `Replaced ${String(value.replacements)} match(es) in ${String(value.files)} file(s)` +
        (skipped > 0 ? ` · ${String(skipped)} skipped` : '') +
        (value.truncated ? ' · search was truncated' : '')
    })
    await reloadExpanded(true)
    scheduleDecorationsRef.current?.(0)
    await runSearch()
    setReplaceReport(
      value.results
        .filter((entry) => !entry.ok)
        .map((entry) => ({
          path: entry.path,
          reason: entry.reason ?? entry.detail ?? 'skipped'
        }))
    )
  }

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
    void loadDirectory(parentPathOf(path), true, 0, false)
    scheduleDecorationsRef.current?.(0)
    if (announce) notify({ tone: 'success', message: `Saved ${path}` })
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
        selectOnly(tab.path)
        setEditorMode('tab')
        return
      }
    }
    notify({ tone: 'success', message: `Saved ${String(dirty.length)} file(s)` })
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

  const requestClose = (path: string): void => {
    const tab = openFilesStore.find(sessionId, path)
    if (tab === null) return
    if (isDirty(tab)) {
      setUnsaved({ kind: 'single', path })
      return
    }
    openFilesStore.closeTab(sessionId, path)
    setGotoLine(null)
    if (openFilesStore.get(sessionId).tabs.length === 0) setEditorMode('tab')
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
        selectOnly(tab.path)
        setEditorMode('tab')
        return
      }
    }
    setDialogBusy(false)
    openFilesStore.closeAll(sessionId)
    setGotoLine(null)
    setEditorMode('tab')
    notify({ tone: 'success', message: `Saved ${String(dirty.length)} file(s)` })
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
    notify({ tone: 'success', message: `Saved ${conflict.path}` })
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

  const showSearch = query.trim().length > 0
  const groupedSearch = useMemo((): Array<{ path: string; matches: FileSearchMatch[] }> => {
    if (results === null || results.status !== 'ok') return []
    const groups = new Map<string, FileSearchMatch[]>()
    for (const match of results.matches) {
      const existing = groups.get(match.path)
      if (existing === undefined) groups.set(match.path, [match])
      else existing.push(match)
    }
    return [...groups.entries()].map(([path, matches]) => ({ path, matches }))
  }, [results])
  const toggleSearchFile = (path: string): void => {
    setCollapsedSearchFiles((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
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
            aria-label={edit?.kind === 'rename' ? 'Rename' : 'New name'}
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
            aria-label="Confirm"
            data-testid="files-pending-confirm"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void commitEdit()}
          >
            ✓
          </button>
          <button
            type="button"
            className="rounded px-1 text-[10px] text-muted-foreground hover:text-foreground"
            aria-label="Cancel"
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
              aria-label={nestedCollapsed ? 'Show nested files' : 'Hide nested files'}
              title={nestedCollapsed ? 'Show nested files' : 'Hide nested files'}
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
            title="Contains changes"
            aria-label="Contains changes"
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

  const buildContextItems = (): ContextMenuItem[] => {
    if (context === null) return []
    const target = context.target
    const paths = contextPaths(target)
    const targetIsFolder = target.kind === 'directory' || target.kind === 'root'
    const canPaste = clipboardHere && clipboard !== null
    const items: ContextMenuItem[] = []

    if (target.kind === 'file') {
      items.push({
        id: 'open',
        label: 'Open',
        icon: <FileText size={12} />,
        shortcut: 'Enter',
        testId: 'files-menu-open',
        onSelect: () => void openPath(target.path, 1)
      })
    }
    if (targetIsFolder) {
      items.push({
        id: 'new-file',
        label: 'New File',
        icon: <FilePlus2 size={12} />,
        testId: 'files-menu-new-file',
        onSelect: () => beginCreate('create-file', target.path)
      })
      items.push({
        id: 'new-folder',
        label: 'New Folder',
        icon: <FolderPlus size={12} />,
        testId: 'files-menu-new-folder',
        onSelect: () => beginCreate('create-directory', target.path)
      })
      items.push({
        id: 'paste',
        label: 'Paste',
        icon: <ClipboardPaste size={12} />,
        shortcut: shortcutLabel('V'),
        disabled: !canPaste || transferBusy,
        reason: transferBusy
          ? 'Wait for the current operation to finish.'
          : clipboard !== null && !clipboardHere
            ? 'The clipboard belongs to another session.'
            : 'Copy or cut something first.',
        testId: 'files-menu-paste',
        onSelect: () => void pasteInto(target.path)
      })
    }

    items.push(
      {
        id: 'cut',
        label: 'Cut',
        icon: <Scissors size={12} />,
        shortcut: shortcutLabel('X'),
        separatorBefore: true,
        disabled: paths.length === 0,
        reason: 'Select something to cut.',
        testId: 'files-menu-cut',
        onSelect: () => copySelection('cut', paths)
      },
      {
        id: 'copy',
        label: 'Copy',
        icon: <Copy size={12} />,
        shortcut: shortcutLabel('C'),
        disabled: paths.length === 0,
        reason: 'Select something to copy.',
        testId: 'files-menu-copy',
        onSelect: () => copySelection('copy', paths)
      },
      {
        id: 'duplicate',
        label: 'Duplicate',
        icon: <Copy size={12} />,
        disabled: paths.length === 0 || transferBusy,
        reason: transferBusy
          ? 'Wait for the current operation to finish.'
          : 'Select something to duplicate.',
        testId: 'files-menu-duplicate',
        onSelect: () => void duplicateSelection(paths)
      },
      {
        id: 'copy-path',
        label: paths.length > 1 ? 'Copy Paths' : 'Copy Path',
        icon: <Copy size={12} />,
        disabled: paths.length === 0,
        reason: 'Select something to copy.',
        testId: 'files-menu-copy-path',
        onSelect: () => void copyPathsToClipboard('absolute', paths)
      },
      {
        id: 'copy-relative-path',
        label: paths.length > 1 ? 'Copy Relative Paths' : 'Copy Relative Path',
        icon: <Copy size={12} />,
        disabled: paths.length === 0,
        reason: 'Select something to copy.',
        testId: 'files-menu-copy-relative-path',
        onSelect: () => void copyPathsToClipboard('relative', paths)
      },
      {
        id: 'rename',
        label: 'Rename',
        icon: <Pencil size={12} />,
        shortcut: 'F2',
        separatorBefore: true,
        disabled: paths.length !== 1 || transferBusy,
        reason: transferBusy ? 'Wait for the current operation to finish.' : 'Select one item to rename.',
        testId: 'files-menu-rename',
        onSelect: () => {
          const path = paths[0]
          if (path !== undefined) beginRename(path)
        }
      },
      {
        id: 'delete',
        label: settings.useTrash ? 'Move to Trash' : 'Delete',
        icon: <Trash2 size={12} />,
        shortcut: 'Del',
        danger: true,
        disabled: paths.length === 0 || transferBusy,
        reason: transferBusy ? 'Wait for the current operation to finish.' : 'Select something to delete.',
        testId: 'files-menu-delete',
        onSelect: () => requestDelete(paths)
      }
    )

    if (onOpenHistory !== undefined && target.path !== '') {
      items.push({
        id: 'history',
        label: 'History',
        icon: <History size={12} />,
        separatorBefore: true,
        testId: 'files-menu-history',
        onSelect: () => onOpenHistory(target.path)
      })
    }
    if (target.kind === 'root') {
      items.push(
        {
          id: 'select-all',
          label: 'Select All',
          shortcut: shortcutLabel('A'),
          separatorBefore: true,
          testId: 'files-menu-select-all',
          onSelect: () => {
            setSelection(selectAll(rows))
            setEditorMode(rows.length > 1 ? 'folder' : 'tab')
          }
        },
        {
          id: 'refresh',
          label: 'Refresh',
          icon: <RefreshCw size={12} />,
          testId: 'files-menu-refresh',
          onSelect: () => void reloadExpanded(false, true)
        }
      )
    }
    return items
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

  const diskBanner =
    activeTab !== null && activeTab.disk === 'changed' ? (
      <div
        className="flex flex-wrap items-center gap-2 border-b border-signal/40 bg-signal-weak px-3 py-1.5 text-[10px] text-signal"
        data-testid="files-disk-changed"
      >
        <span className="min-w-0 flex-1">
          This file changed on disk while you were editing. Saving will ask before overwriting.
        </span>
        <button
          type="button"
          className="rounded border border-signal/50 px-1.5 py-0.5 hover:bg-signal/10"
          onClick={() => void reloadFromDisk(activeTab.path)}
          data-testid="files-disk-reload"
        >
          Reload
        </button>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
          onClick={() => void keepMine(activeTab.path)}
          data-testid="files-disk-keep"
        >
          Keep mine
        </button>
      </div>
    ) : activeTab !== null && activeTab.disk === 'deleted' ? (
      <div
        className="flex flex-wrap items-center gap-2 border-b border-signal/40 bg-signal-weak px-3 py-1.5 text-[10px] text-signal"
        data-testid="files-disk-deleted"
      >
        <span className="min-w-0 flex-1">This file was deleted or moved on disk.</span>
        <button
          type="button"
          className="rounded border border-signal/50 px-1.5 py-0.5 hover:bg-signal/10"
          onClick={() => void saveTabAt(activeTab.path, null, false)}
          data-testid="files-disk-recreate"
        >
          Save to recreate
        </button>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
          onClick={() => requestClose(activeTab.path)}
          data-testid="files-disk-close"
        >
          Close
        </button>
      </div>
    ) : null

  const tabStrip =
    tabs.length === 0 ? null : (
      <div className="flex h-8 shrink-0 items-center border-b border-border bg-card">
        <div
          role="tablist"
          aria-label="Open files"
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
                  aria-label="Unsaved changes"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  data-testid="files-tab-dirty"
                />
              ) : null}
              <span className="max-w-[180px] truncate">{basenameOf(tab.path)}</span>
              <button
                type="button"
                className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                aria-label={`Close ${tab.path}`}
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
              {dirtyCount} unsaved
            </span>
          ) : null}
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            title="Save all files"
            aria-label="Save all files"
            disabled={dirtyCount === 0}
            onClick={() => void saveAllTabs()}
            data-testid="files-save-all"
          >
            <Save size={10} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            title="Close all files"
            aria-label="Close all files"
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
      className="flex min-h-0 flex-1"
      data-testid="files-panel"
      data-live-mode={liveState}
      data-busy={transferBusy ? 'true' : 'false'}
    >
      <div className="flex w-[312px] shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <Search size={11} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchInput}
            value={query}
            placeholder="Search in files"
            className="min-w-0 flex-1 bg-transparent text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground"
            data-testid="files-search-input"
            onChange={(event) => {
              setQuery(event.target.value)
              setSearchError(null)
              setSearchNote('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch()
              if (event.key === 'Escape') {
                setQuery('')
                setResults(null)
                setSearchError(null)
                setSearchNote('')
              }
            }}
          />
          {query.length > 0 ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setQuery('')
                setResults(null)
                setSearchError(null)
                setSearchNote('')
              }}
              data-testid="files-search-clear"
              title="Clear search"
            >
              <X size={11} />
            </button>
          ) : null}
        </div>

        {showSearch ? (
          <div
            className="border-b border-border px-1.5 py-1"
            data-testid="files-search-options"
          >
            <div className="flex flex-wrap items-center gap-0.5">
              {(
                [
                  ['files-search-case', 'Aa', 'Match case', searchCaseSensitive, setSearchCaseSensitive],
                  ['files-search-whole-word', 'W', 'Match whole word', searchWholeWord, setSearchWholeWord],
                  ['files-search-regex', '.*', 'Use regular expression', searchRegex, setSearchRegex]
                ] as const
              ).map(([testId, label, title, active, setter]) => (
                <button
                  key={testId}
                  type="button"
                  aria-pressed={active}
                  title={title}
                  className={`inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 font-mono text-[10px] ${
                    active
                      ? 'bg-accent/15 text-accent'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                  data-testid={testId}
                  onClick={() => setter(!active)}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={searchFiltersOpen}
                aria-expanded={searchFiltersOpen}
                title="Include and exclude filters"
                className={`ml-1 inline-flex h-6 items-center rounded px-1.5 text-[10px] ${
                  searchFiltersOpen
                    ? 'bg-accent/15 text-accent'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                data-testid="files-search-filters"
                onClick={() => setSearchFiltersOpen((open) => !open)}
              >
                Filters
              </button>
              <span className="ml-auto flex items-center gap-1">
                {searching ? (
                  <button
                    type="button"
                    className="inline-flex h-6 items-center rounded border border-border px-1.5 text-[10px] text-signal hover:bg-muted"
                    data-testid="files-search-stop"
                    onClick={() => void stopSearch()}
                  >
                    Stop
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex h-6 items-center rounded border border-border px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  title={
                    searchRegex
                      ? 'Regex replace is not supported yet'
                      : 'Replace every match in the searched files'
                  }
                  disabled={
                    searchRegex ||
                    searching ||
                    results === null ||
                    results.status !== 'ok' ||
                    results.matches.length === 0
                  }
                  data-testid="files-replace-run"
                  onClick={requestReplace}
                >
                  Replace all
                </button>
              </span>
            </div>
            {searchFiltersOpen ? (
              <div className="mt-1 grid gap-1">
                <input
                  value={searchInclude}
                  placeholder="files to include: src/**, *.ts"
                  className="h-6 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground"
                  data-testid="files-search-include"
                  onChange={(event) => setSearchInclude(event.target.value)}
                />
                <input
                  value={searchExclude}
                  placeholder="files to exclude: *.min.js, dist/"
                  className="h-6 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground"
                  data-testid="files-search-exclude"
                  onChange={(event) => setSearchExclude(event.target.value)}
                />
              </div>
            ) : null}
            <label className="mt-1 flex items-center gap-1">
              <span className="shrink-0 text-[9.5px] text-muted-foreground">Replace</span>
              <input
                value={replaceText}
                placeholder="replacement text"
                className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground"
                data-testid="files-replace-input"
                onChange={(event) => setReplaceText(event.target.value)}
              />
            </label>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1 py-1">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded px-2 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title="New file"
            data-testid="files-new-file"
            onClick={() => beginCreate('create-file', createParent())}
          >
            <FilePlus2 size={10} />
            New file
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded px-2 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title="New folder"
            data-testid="files-new-directory"
            onClick={() => beginCreate('create-directory', createParent())}
          >
            <FolderPlus size={10} />
            New folder
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded px-2 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            title="Rename"
            disabled={selectionSummary.total !== 1 || singleSelectedEntry === null || transferBusy}
            data-testid="files-rename"
            onClick={() => {
              const path = [...selection.selected][0]
              if (path !== undefined) beginRename(path)
            }}
          >
            <Pencil size={10} />
            Rename
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded px-2 text-[10.5px] text-destructive hover:bg-destructive/10 disabled:opacity-30"
            title="Delete"
            disabled={selectionSummary.total === 0 || transferBusy}
            data-testid="files-delete"
            onClick={() => requestDelete(selectedPaths())}
          >
            <Trash2 size={10} />
            Delete
          </button>
          <button
            type="button"
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            title={undoLabel(peekUndo(undoStack))}
            aria-label="Undo last file operation"
            disabled={undoStack.length === 0 || undoing || transferBusy}
            data-testid="files-undo"
            onClick={() => void undoLast()}
          >
            <Undo2 size={11} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            title="Duplicate selection"
            aria-label="Duplicate selection"
            disabled={selectionSummary.total === 0 || transferBusy}
            data-testid="files-duplicate"
            onClick={() => void duplicateSelection()}
          >
            <Copy size={11} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Refresh the tree"
            aria-label="Refresh tree"
            data-testid="files-refresh"
            onClick={() => void reloadExpanded(false, true)}
          >
            <RefreshCw size={11} />
          </button>
        </div>

        <div
          className="border-b border-border bg-card px-3 py-1.5 text-[10px] text-muted-foreground"
          data-testid="files-selection"
        >
          {selectionSummary.total === 0 ? (
            'Select a file or folder to rename or delete it.'
          ) : selectionSummary.total === 1 ? (
            <>
              Selected{' '}
              <span className="font-mono text-foreground" title={singleSelectedPath ?? undefined}>
                {singleSelectedPath}
              </span>{' '}
              · {singleSelectedEntry?.kind === 'directory' ? 'folder' : 'file'}
            </>
          ) : (
            <>
              {selectionSummary.total} selected · {selectionSummary.files} file
              {selectionSummary.files === 1 ? '' : 's'} · {selectionSummary.directories} folder
              {selectionSummary.directories === 1 ? '' : 's'}
            </>
          )}
          {liveState === 'poll' ? (
            <span className="ml-1 text-signal" title="The live watcher is unavailable; Files is checking periodically.">
              · polling
            </span>
          ) : null}
          {transferBusy ? <span className="ml-1 text-signal">· working…</span> : null}
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
              aria-label="Dismiss"
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
              {trashBanner.paths.length} deleted item
              {trashBanner.paths.length === 1 ? '' : 's'} in Trash
            </span>
            <button
              type="button"
              className="shrink-0 rounded border border-signal/40 px-1.5 py-0.5 hover:bg-signal/10 disabled:opacity-40"
              disabled={undoing || transferBusy}
              data-testid="files-trash-restore"
              onClick={() => void restoreTrashOp(trashBanner.opId)}
            >
              Restore
            </button>
          </div>
        ) : null}

        <div
          ref={treeScrollRef}
          role={showSearch ? undefined : 'tree'}
          aria-label={showSearch ? undefined : 'Worktree files'}
          aria-multiselectable={showSearch ? undefined : true}
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
          onKeyDown={showSearch ? undefined : onTreeKeyDown}
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
            <p role="presentation" className="px-2 py-1 text-[11px] text-muted-foreground">Loading…</p>
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
                Retry
              </button>
            </p>
          ) : null}

          {showSearch ? (
            <div data-testid="files-search-results">
              <p className="px-1 py-1 text-[10px] text-muted-foreground" data-testid="files-search-summary">
                {searching
                  ? 'Searching…'
                  : results === null
                    ? 'Press Enter to search'
                    : results.status === 'unavailable'
                      ? 'Search unavailable'
                      : `${String(results.matches.length)} match(es) in ${String(groupedSearch.length)} file(s) · ${String(results.scannedFiles)} scanned${
                          results.truncated ? ' · truncated' : ''
                        }${results.cancelled ? ' · stopped' : ''}`}
              </p>
              {searchError !== null ? (
                <p
                  className="px-1 py-1 text-[10px] text-destructive"
                  data-testid="files-search-error"
                >
                  {searchError}
                </p>
              ) : null}
              {searchNote.length > 0 ? (
                <p
                  className="px-1 py-1 text-[10px] text-signal"
                  data-testid="files-search-note"
                >
                  {searchNote}
                </p>
              ) : null}
              {replaceReport.length > 0 ? (
                <ul
                  className="mx-1 mb-1 rounded border border-signal/40 bg-signal-weak px-2 py-1 text-[9.5px] text-signal"
                  data-testid="files-replace-report"
                >
                  {replaceReport.map((entry) => (
                    <li key={`${entry.path}:${entry.reason}`} className="truncate" title={entry.path}>
                      {entry.path}: {entry.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              {groupedSearch.map((group) => {
                const collapsed = collapsedSearchFiles.has(group.path)
                return (
                  <div key={group.path} data-testid={`files-search-group-${group.path}`}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted/60"
                      aria-expanded={!collapsed}
                      data-testid={`files-search-file-${group.path}`}
                      onClick={() => toggleSearchFile(group.path)}
                    >
                      <span className="w-3 shrink-0 text-[9px] text-muted-foreground">
                        {collapsed ? '▸' : '▾'}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                        {group.path}
                      </span>
                      <span className="shrink-0 text-[9px] text-muted-foreground">
                        {group.matches.length}
                      </span>
                    </button>
                    {collapsed
                      ? null
                      : group.matches.map((match, index) => (
                          <button
                            key={`${match.path}:${String(match.line)}:${String(index)}`}
                            type="button"
                            className="block w-full rounded px-1 py-0.5 pl-5 text-left hover:bg-muted/60"
                            onClick={() => void openPath(match.path, match.line)}
                            data-testid={`files-search-hit-${match.path}-${String(match.line)}`}
                          >
                            <span className="block truncate font-mono text-[10px] text-muted-foreground">
                              {match.line}: {match.text}
                            </span>
                          </button>
                        ))}
                  </div>
                )
              })}
              {results !== null && results.status === 'unavailable' ? (
                <p className="px-1 py-1 text-[10px] text-signal">
                  {unavailableText(results)}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {rootState === 'ready' ? (
                <div role="presentation" className="mb-1 flex items-center gap-1 px-1 text-[9px] text-muted-foreground">
                  <FolderOpen size={9} />
                  <span className="truncate">{rootNote || 'worktree root'}</span>
                </div>
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
                <p role="presentation" className="px-2 py-1 text-[11px] text-muted-foreground" data-testid="files-folder-empty">
                  This folder is empty.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                {selectionSummary.files} file{selectionSummary.files === 1 ? '' : 's'} ·{' '}
                {selectionSummary.directories} folder
                {selectionSummary.directories === 1 ? '' : 's'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                  data-testid="files-selection-copy-path"
                  onClick={() => void copyPathsToClipboard('absolute', selectedPaths())}
                >
                  <Copy size={10} />
                  Copy Path
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                  data-testid="files-selection-copy-relative-path"
                  onClick={() => void copyPathsToClipboard('relative', selectedPaths())}
                >
                  <Copy size={10} />
                  Copy Relative Path
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-destructive/60 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10"
                  data-testid="files-selection-delete"
                  onClick={() => requestDelete(selectedPaths())}
                >
                  <Trash2 size={10} />
                  Delete…
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
                Rename is name-only. Move this folder with drag & drop or Cut and Paste.
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
                    History
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-muted"
                  data-testid="files-folder-rename"
                  onClick={() => beginRename(singleFolder.path)}
                >
                  <Pencil size={10} />
                  Rename…
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-destructive/60 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10"
                  data-testid="files-folder-delete"
                  onClick={() => requestDelete([singleFolder.path])}
                >
                  <Trash2 size={10} />
                  Delete folder…
                </button>
              </div>
            </div>
          </div>
        ) : activeTab === null ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <p className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground" data-testid="files-empty">
              Pick a file to read or edit it here. Saved edits land in this session's worktree, so the
              Agent and the Changes review see them immediately.
            </p>
          </div>
        ) : activeTab.load === 'loading' ? (
          <div className="flex flex-1 items-center justify-center p-6" data-testid="files-tab-loading">
            <p className="text-[11.5px] text-muted-foreground">Opening {activeTab.path}…</p>
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
                  Retry
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => requestClose(activeTab.path)}
                  data-testid="files-tab-failure-close"
                >
                  Close
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

      {replacePrompt !== null ? (
        <ReplaceFilesDialog
          matches={replacePrompt.matches}
          files={replacePrompt.files}
          paths={replacePrompt.paths}
          busy={replaceBusy}
          onConfirm={() => void confirmReplace()}
          onCancel={() => setReplacePrompt(null)}
        />
      ) : null}

      {context !== null ? (
        <ContextMenu
          x={context.x}
          y={context.y}
          items={buildContextItems()}
          ariaLabel="Files actions"
          testId="files-context-menu"
          onClose={() => setContext(null)}
        />
      ) : null}
    </div>
  )
}

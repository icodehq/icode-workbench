import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  FileSearch,
  Folder,
  FolderOpen,
  List,
  ListTree,
  Loader2,
  Minus,
  MoreHorizontal,
  Plus,
  Search,
  TerminalSquare,
  Trash2
} from 'lucide-react'
import { callApi } from '../lib/api'
import type {
  GitRangeFile,
  GitWorkspaceStatus
} from '../../../shared/domain/git-workspace'
import type { FileDiffPayload, FileDiffResult } from '../../../shared/schemas/changes'
import type { AppError } from '../../../shared/domain/errors'
import { makeAppError } from '../../../shared/domain/errors'
import type { LineComment } from '../review/drafts'
import {
  committedTreeEntries,
  diffScopeFor,
  reviewStatusFor,
  workingTreeGroups,
  type WorkingTreeArea,
  type WorkingTreeEntry,
  type WorkingTreeGroups
} from '../review/working-tree'
import { countUnifiedDiffChanges } from '../review/parse-unified-diff'
import { type DiffViewState } from './UnifiedDiffView'
import WorkingDiffView, { type WorkingDiffMode } from './WorkingDiffView'
import CommittedFileDiff from './history/CommittedFileDiff'
import ScmContextMenu, { type ScmMenuItem } from '../scm/ScmContextMenu'
import { useT } from '../i18n/use-i18n'
import { translate } from '../i18n/i18n-store'
import {
  EMPTY_SELECTION,
  pruneSelection,
  selectAll,
  selectOnly,
  selectRange,
  selectedEntries,
  selectionActions,
  selectionKey,
  toggleSelection,
  type ScmSelection
} from '../scm/selection-model'
import {
  scmGroups,
  scmRows,
  toggleCollapsed,
  type ScmFolderRow,
  type ScmGroupRow,
  type ScmResourceRow,
  type ScmSortKey,
  type ScmViewMode
} from '../scm/resource-tree'
import {
  loadScmSettings,
  saveScmSettings,
  subscribeScmSettings,
  type ScmSettings
} from '../scm/scm-settings'

type DiffState = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  diff?: FileDiffPayload
  error?: AppError
  stale?: boolean
}

type Props = {
  sessionId: string
  sessionState: string
  /** The commit this session's worktree was created from. */
  baseOid: string | null
  /** Read-only rows committed between the baseline and HEAD. */
  committed: GitRangeFile[] | null
  snapshot: GitWorkspaceStatus | null
  loading: boolean
  active: boolean
  refreshToken: number
  /** Bumped whenever the watcher saw a write, so the focused diff can refresh. */
  diffTick: number
  /** True when main's worktree watcher is driving refreshes. */
  watchActive: boolean
  /** The SCM sidebar's upper block (repository header and commit input). */
  sidebarHeader?: React.ReactNode
  /** Replaces the editor/diff area, e.g. with the History pane. */
  editorOverride?: React.ReactNode
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onStageEntries: (entries: WorkingTreeEntry[]) => void
  onUnstageEntries: (entries: WorkingTreeEntry[]) => void
  onDiscardEntries: (entries: WorkingTreeEntry[]) => void
  onDiscard: (entry: WorkingTreeEntry) => void
  onOpenPath: (path: string) => void
  onOpenTerminal: () => void
  comments: LineComment[]
  onAddComment: (comment: Omit<LineComment, 'id'>) => void
  onRemoveComment: (id: string) => void
  /** Applies one hunk patch to the index through the SCM controller. */
  onApplyHunk?: (
    path: string,
    patch: string,
    mode: 'stage' | 'unstage' | 'discard'
  ) => Promise<{ ok: boolean; message?: string }>
  /** Writes a merge result and stages the resolved path. */
  onResolveConflict?: (
    path: string,
    text: string
  ) => Promise<{ ok: boolean; message?: string }>
}

const SECTION_ORDER: WorkingTreeArea[] = ['conflicts', 'staged', 'unstaged', 'untracked']

const GROUP_KEY = {
  conflicts: 'scm.group.conflicts',
  staged: 'scm.group.staged',
  unstaged: 'scm.group.unstaged',
  untracked: 'scm.group.untracked',
  committed: 'scm.group.committed'
} as const

function fileParts(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf('/')
  return index === -1 ? { name: path, dir: '' } : { name: path.slice(index + 1), dir: path.slice(0, index) }
}

function allFolderEntries(row: ScmFolderRow, groups: WorkingTreeGroups): WorkingTreeEntry[] {
  const keys = new Set(row.resourceKeys)
  return [...groups.conflicts, ...groups.staged, ...groups.unstaged, ...groups.untracked].filter(
    (entry) => keys.has(entry.key)
  )
}

function statusLetter(entry: WorkingTreeEntry): string {
  switch (entry.entry.status) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'untracked':
      return 'U'
    case 'unmerged':
      return '!'
    default:
      return 'M'
  }
}

function statusTone(entry: WorkingTreeEntry): string {
  switch (entry.entry.status) {
    case 'added':
    case 'untracked':
      return 'text-add'
    case 'deleted':
    case 'unmerged':
      return 'text-destructive'
    case 'renamed':
    case 'copied':
      return 'text-info'
    default:
      return 'text-signal'
  }
}

function diffSignature(entry: WorkingTreeEntry, snapshot: GitWorkspaceStatus | null): string {
  return [
    snapshot?.headOid ?? '',
    entry.entry.code,
    entry.entry.oldPath ?? '',
    entry.added ?? '',
    entry.removed ?? '',
    entry.entry.binary ?? false
  ].join('|')
}

function diffViewState(state: DiffState | undefined): DiffViewState {
  if (!state || state.phase === 'idle') return { phase: 'idle' }
  if (state.phase === 'loading') return { phase: 'loading' }
  if (state.phase === 'error') {
    return {
      phase: 'error',
      error: state.error ?? makeAppError('GIT_READ_FAILED', translate('diff.readError'), {
        messageKey: 'diff.readError'
      })
    }
  }
  return { phase: 'ready', diff: state.diff!, ...(state.stale === true ? { stale: true } : {}) }
}

/**
 * The uncommitted half of Changes. Rows are area-specific: a path that is dirty
 * in both the index and the working tree appears in Staged Changes and Changes
 * with separate stats and separate diffs.
 */
export default function WorkingTreeView({
  sessionId,
  sessionState,
  baseOid,
  committed,
  snapshot,
  loading,
  active,
  refreshToken,
  diffTick,
  watchActive,
  sidebarHeader,
  editorOverride,
  onStage,
  onUnstage,
  onStageEntries,
  onUnstageEntries,
  onDiscardEntries,
  onDiscard,
  onOpenPath,
  onOpenTerminal,
  comments,
  onAddComment,
  onRemoveComment,
  onApplyHunk,
  onResolveConflict
}: Props): React.JSX.Element {
  const t = useT()
  const statusGroups = useMemo(() => workingTreeGroups(snapshot), [snapshot])
  const committedEntries = useMemo(
    () => (committed === null ? [] : committedTreeEntries(committed)),
    [committed]
  )
  const groups = useMemo(
    () => ({ ...statusGroups, committed: committedEntries }),
    [committedEntries, statusGroups]
  )
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const rowButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const [selection, setSelection] = useState<ScmSelection>(EMPTY_SELECTION)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    items: ScmMenuItem[]
    label: string
  } | null>(null)
  const [settings, setSettings] = useState<ScmSettings>(() => loadScmSettings())
  const [viewMode, setViewMode] = useState<ScmViewMode>(settings.viewMode)
  const [sort, setSort] = useState<ScmSortKey>(settings.sort)
  const [sidebarWidth, setSidebarWidth] = useState(settings.sidebarWidth)
  const resizing = useRef<{ startX: number; startWidth: number } | null>(null)
  const sidebarWidthRef = useRef(settings.sidebarWidth)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const signatures = useRef<Map<string, string>>(new Map())
  const inFlight = useRef<Map<string, Promise<void>>>(new Map())
  const generation = useRef(0)

  useEffect(() => subscribeScmSettings(setSettings), [])

  useEffect(() => {
    setSidebarWidth(settings.sidebarWidth)
    sidebarWidthRef.current = settings.sidebarWidth
  }, [settings.sidebarWidth])

  const rows = useMemo(() => {
    return scmRows(groups, {
      mode: viewMode,
      sort,
      query,
      untrackedMode: settings.untrackedMode,
      compactFolders: settings.compactFolders,
      collapsed
    })
  }, [collapsed, groups, query, settings.compactFolders, settings.untrackedMode, sort, viewMode])

  const displayGroups = useMemo(
    () => scmGroups(groups, { query, untrackedMode: settings.untrackedMode }),
    [groups, query, settings.untrackedMode]
  )
  const displayEntries = useMemo(
    () => new Map(displayGroups.map((group) => [group.id, group.entries])),
    [displayGroups]
  )
  const groupedRows = useMemo(() => {
    const result: Array<{ group: ScmGroupRow; rows: Array<ScmFolderRow | ScmResourceRow> }> = []
    for (const row of rows) {
      if (row.kind === 'group') result.push({ group: row, rows: [] })
      else result[result.length - 1]?.rows.push(row)
    }
    return result
  }, [rows])

  const visibleEntries = useMemo(
    () => rows.filter((row) => row.kind === 'resource').map((row) => row.entry),
    [rows]
  )
  const selected = visibleEntries.find((entry) => entry.key === selectedKey) ?? visibleEntries[0] ?? null

  const updateViewMode = (mode: ScmViewMode): void => {
    setViewMode(mode)
    saveScmSettings({ ...settings, viewMode: mode })
  }
  const updateSort = (next: ScmSortKey): void => {
    setSort(next)
    saveScmSettings({ ...settings, sort: next })
  }
  const updateDiffView = (mode: WorkingDiffMode): void => {
    saveScmSettings({ ...settings, diffView: mode })
  }

  const persistSidebarWidth = (next: number): void => {
    const clamped = Math.min(560, Math.max(240, Math.round(next)))
    setSidebarWidth(clamped)
    sidebarWidthRef.current = clamped
    saveScmSettings({ ...settings, sidebarWidth: clamped })
  }

  const beginResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizing.current = { startX: event.clientX, startWidth: sidebarWidthRef.current }
  }

  const moveResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizing.current === null) return
    const next = Math.min(
      560,
      Math.max(240, resizing.current.startWidth + event.clientX - resizing.current.startX)
    )
    setSidebarWidth(next)
    sidebarWidthRef.current = next
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizing.current === null) return
    resizing.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // The pointer release may already have happened.
    }
    saveScmSettings({ ...settings, sidebarWidth: sidebarWidthRef.current })
  }

  useEffect(() => {
    const next = new Map<string, string>()
    for (const area of SECTION_ORDER) {
      for (const entry of groups[area]) {
        next.set(entry.key, diffSignature(entry, snapshot))
      }
    }
    setDiffs((current) => {
      let changed = false
      const output: Record<string, DiffState> = {}
      for (const [key, state] of Object.entries(current)) {
        if (!next.has(key)) {
          changed = true
          continue
        }
        const previousSignature = signatures.current.get(key)
        if (state.phase === 'ready' && previousSignature !== undefined && previousSignature !== next.get(key)) {
          output[key] = { ...state, stale: true }
          changed = true
        } else {
          output[key] = state
        }
      }
      return changed ? output : current
    })
    signatures.current = next
  }, [groups, snapshot])

  // A new session or a new worktree rebuild starts a new diff generation.
  useEffect(() => {
    generation.current += 1
    signatures.current.clear()
    inFlight.current.clear()
    setDiffs({})
    setSelectedKey(null)
    setSelection(EMPTY_SELECTION)
    setQuery('')
    setCollapsed(new Set())
  }, [sessionId])

  // Selection keys survive a snapshot refresh only while the row still exists.
  useEffect(() => {
    const available = new Set(
      [
        ...groups.conflicts,
        ...groups.staged,
        ...groups.unstaged,
        ...groups.untracked,
        ...groups.committed
      ].map(selectionKey)
    )
    setSelection((current) => pruneSelection(current, available))
  }, [groups])

  const requestDiff = useCallback(
    (entry: WorkingTreeEntry) => {
      const scope = diffScopeFor(entry.area)
      if (scope === null) {
        // Committed rows never call this; their diff is read from base..HEAD
        // by CommittedFileDiff. Keep the contract total for the callback.
        return Promise.resolve({
          ok: true as const,
          value: {
            status: 'unavailable' as const,
            reason: 'invalid-baseline' as const,
            detail: t('scm.worktree.committedRow')
          }
        })
      }
      return callApi<FileDiffResult>(
        window.icode.git.changeDiff({
          sessionId,
          path: entry.entry.path,
          oldPath: entry.entry.oldPath,
          scope,
          status: reviewStatusFor(entry.entry),
          binary: entry.entry.binary ?? false,
          symlink: null,
          additions: entry.added,
          deletions: entry.removed
        })
      )
    },
    [sessionId]
  )

  const loadDiff = useCallback(
    (entry: WorkingTreeEntry, force = false): void => {
      if (entry.area === 'committed') return
      const current = diffs[entry.key]
      if (!force && current?.phase === 'ready' && current.stale !== true) return
      if (inFlight.current.has(entry.key)) return
      const run = (async (): Promise<void> => {
        const gen = generation.current
        setDiffs((prev) => ({
          ...prev,
          [entry.key]:
            prev[entry.key]?.phase === 'ready'
              ? { ...prev[entry.key]!, stale: true }
              : { phase: 'loading' }
        }))
        const result = await requestDiff(entry)
        if (generation.current !== gen) return
        if (!result.ok) {
          setDiffs((prev) => ({ ...prev, [entry.key]: { phase: 'error', error: result.error } }))
          return
        }
        if (result.value.status === 'available') {
          const value = result.value
          setDiffs((prev) => ({ ...prev, [entry.key]: { phase: 'ready', diff: value } }))
          return
        }
        const detail =
        'detail' in result.value ? result.value.detail : t('review.diffUnavailable')
        setDiffs((prev) => ({
          ...prev,
          [entry.key]: {
            phase: 'error',
            error: makeAppError('GIT_READ_FAILED', detail)
          }
        }))
      })()
      inFlight.current.set(entry.key, run)
      void run.finally(() => {
        if (inFlight.current.get(entry.key) === run) inFlight.current.delete(entry.key)
      })
    },
    [diffs, requestDiff]
  )

  /**
   * A quiet content refresh for the selected file.
   *
   * The status poll catches a changed file list or line count, but an Agent can
   * rewrite a line without changing either. Poll the selected diff itself and
   * replace it only when the patch differs, so there is no loading flicker and
   * an unchanged review does not re-render.
   */
  const refreshDiff = useCallback(
    (entry: WorkingTreeEntry): void => {
      if (entry.area === 'committed') return
      if (inFlight.current.has(entry.key)) return
      const gen = generation.current
      const run = (async (): Promise<void> => {
        const result = await requestDiff(entry)
        if (generation.current !== gen || !result.ok || result.value.status !== 'available') return
        const value = result.value
        // The status poll may not have caught a same-size edit yet. The patch is
        // the source of truth for the diff header until the next snapshot.
        const next =
          value.binary || value.truncated
            ? value
            : { ...value, ...countUnifiedDiffChanges(value.patch) }
        setDiffs((prev) => {
          const current = prev[entry.key]
          if (
            current?.phase === 'ready' &&
            current.diff?.patch === next.patch &&
            current.diff?.additions === next.additions &&
            current.diff?.deletions === next.deletions
          ) {
            return prev
          }
          return { ...prev, [entry.key]: { phase: 'ready', diff: next } }
        })
      })()
      inFlight.current.set(entry.key, run)
      void run.finally(() => {
        if (inFlight.current.get(entry.key) === run) inFlight.current.delete(entry.key)
      })
    },
    [requestDiff]
  )

  useEffect(() => {
    if (!active || selected === null || selected.area === 'committed') return
    loadDiff(selected)
  }, [active, diffTick, loadDiff, refreshToken, selected])

  useEffect(() => {
    if (!active || selected === null || selected.area === 'committed') return
    // With a live watcher, the status event bumps diffTick and the effect
    // above reloads the selected diff. The polling fallback remains for guest
    // targets and any watcher that failed.
    if (watchActive) return
    if (sessionState !== 'live' && sessionState !== 'starting') return
    let cancelled = false
    const timer = window.setInterval(() => {
      if (!cancelled && document.visibilityState === 'visible') refreshDiff(selected)
    }, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, refreshDiff, selected, sessionState, watchActive])

  const visibleKeys = useMemo(() => visibleEntries.map((entry) => entry.key), [visibleEntries])
  const selectedRows = selectedEntries(selection, groups)
  const selectedActions = selectionActions(selection, groups)

  const openMenu = (entry: WorkingTreeEntry, x: number, y: number): void => {
    if (entry.area !== 'committed' && !selection.selected.has(entry.key)) {
      setSelection(selectOnly(entry.key))
    }
    setSelectedKey(entry.key)
    setMenu({
      x,
      y,
      items: menuItems(entry),
      label: t('scm.worktree.actionsFor', { path: entry.entry.path })
    })
  }

  const openFolderMenu = (row: ScmFolderRow, x: number, y: number): void => {
    const entries = allFolderEntries(row, groups)
    const stageable = entries.filter(
      (entry) => entry.area === 'unstaged' || entry.area === 'untracked'
    )
    const unstageable = entries.filter((entry) => entry.area === 'staged')
    const discardable = entries.filter(
      (entry) => entry.area !== 'conflicts' && entry.area !== 'committed'
    )
    const selectFolder = (): void => {
      setSelection({ selected: new Set(row.resourceKeys), anchor: row.resourceKeys[0] ?? null })
    }
    const items: ScmMenuItem[] = [
      {
        id: 'folder-stage',
        label: t('scm.worktree.menu.folderStage', { count: stageable.length }),
        icon: <Plus size={12} />,
        disabled: stageable.length === 0,
        onSelect: () => {
          selectFolder()
          onStageEntries(stageable)
        }
      },
      {
        id: 'folder-unstage',
        label: t('scm.worktree.menu.folderUnstage', { count: unstageable.length }),
        icon: <Minus size={12} />,
        disabled: unstageable.length === 0,
        onSelect: () => {
          selectFolder()
          onUnstageEntries(unstageable)
        }
      },
      {
        id: 'folder-discard',
        label: t('scm.worktree.menu.folderDiscard', { count: discardable.length }),
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        disabled: discardable.length === 0,
        onSelect: () => {
          selectFolder()
          onDiscardEntries(discardable)
        }
      }
    ]
    setMenu({ x, y, items, label: t('scm.worktree.menu.actionsFor', { path: row.path }) })
  }

  const menuItems = (entry: WorkingTreeEntry): ScmMenuItem[] => {
    const copy = (text: string): void => {
      void navigator.clipboard?.writeText(text).catch(() => undefined)
    }
    if (entry.area === 'committed') {
      return [
        {
          id: 'open-changes',
          label: t('scm.worktree.menu.openChanges'),
          icon: <FileSearch size={12} />,
          onSelect: () => setSelectedKey(entry.key)
        },
        {
          id: 'open-files',
          label: t('scm.worktree.menu.openInFiles'),
          icon: <FolderOpen size={12} />,
          onSelect: () => onOpenPath(entry.entry.path)
        },
        {
          id: 'copy-path',
          label: t('scm.worktree.menu.copyPath'),
          icon: <Copy size={12} />,
          onSelect: () => copy(entry.entry.path)
        },
        {
          id: 'open-terminal',
          label: t('scm.worktree.menu.openTerminal'),
          icon: <TerminalSquare size={12} />,
          separatorBefore: true,
          onSelect: onOpenTerminal
        }
      ]
    }
    const inSelection = selection.selected.has(entry.key) && selectedRows.length > 1
    const targets = inSelection ? selectedRows : [entry]
    const stageTargets = targets.filter(
      (target) => target.area === 'unstaged' || target.area === 'untracked'
    )
    const unstageTargets = targets.filter((target) => target.area === 'staged')
    const discardTargets = targets.filter(
      (target) => target.area !== 'conflicts' && target.area !== 'committed'
    )
    const suffix = inSelection
      ? t('scm.worktree.menu.selectedSuffix', { count: targets.length })
      : ''
    return [
      {
        id: 'open-changes',
        label: t('scm.worktree.menu.openChanges'),
        icon: <FileSearch size={12} />,
        onSelect: () => setSelectedKey(entry.key)
      },
      {
        id: 'open-files',
        label: t('scm.worktree.menu.openInFiles'),
        icon: <FolderOpen size={12} />,
        onSelect: () => onOpenPath(entry.entry.path)
      },
      {
        id: 'copy-path',
        label: t('scm.worktree.menu.copyPath'),
        icon: <Copy size={12} />,
        onSelect: () => copy(entry.entry.path)
      },
      {
        id: 'copy-relative',
        label: t('scm.worktree.menu.copyRelativePath'),
        icon: <Copy size={12} />,
        onSelect: () => copy(entry.entry.path)
      },
      {
        id: 'open-terminal',
        label: t('scm.worktree.menu.openTerminal'),
        icon: <TerminalSquare size={12} />,
        separatorBefore: true,
        onSelect: onOpenTerminal
      },
      entry.area === 'conflicts'
        ? {
            id: 'conflict-terminal',
            label: t('scm.worktree.menu.resolveTerminal'),
            icon: <AlertTriangle size={12} />,
            onSelect: onOpenTerminal
          }
        : entry.area === 'staged'
          ? {
              id: 'unstage',
              label: `${t('scm.worktree.menu.unstage')}${suffix}`,
              icon: <Minus size={12} />,
              disabled: unstageTargets.length === 0,
              onSelect: () =>
                unstageTargets.length > 1
                  ? onUnstageEntries(unstageTargets)
                  : onUnstage(entry.entry.path)
            }
          : {
              id: 'stage',
              label: `${t('scm.worktree.menu.stage')}${suffix}`,
              icon: <Plus size={12} />,
              disabled: stageTargets.length === 0,
              onSelect: () =>
                stageTargets.length > 1
                  ? onStageEntries(stageTargets)
                  : onStage(entry.entry.path)
            },
      {
        id: 'discard',
        label:
          discardTargets.length > 1
            ? t('scm.worktree.menu.discardSelected', { count: discardTargets.length })
            : entry.area === 'untracked'
              ? t('scm.worktree.menu.deleteUntracked')
              : t('scm.worktree.menu.discardChanges'),
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        disabled: discardTargets.length === 0,
        reason: t('scm.worktree.menu.resolveBeforeDiscard'),
        onSelect: () =>
          discardTargets.length > 1
            ? onDiscardEntries(discardTargets)
            : onDiscard(entry)
      }
    ]
  }

  const onRowClick = (
    entry: WorkingTreeEntry,
    event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }
  ): void => {
    setSelectedKey(entry.key)
    // Committed rows are read-only: they open their diff but never join the
    // staging/discard selection.
    if (entry.area === 'committed') return
    if (event.shiftKey) {
      setSelection((current) => selectRange(current, visibleKeys, entry.key))
      return
    }
    if (event.metaKey || event.ctrlKey) {
      setSelection((current) => toggleSelection(current, entry.key))
      return
    }
    setSelection(selectOnly(entry.key))
  }

  const selectedState =
    selected !== null && selected.area !== 'committed' ? diffs[selected.key] : undefined

  const uncommittedTotal =
    groups.conflicts.length + groups.staged.length + groups.unstaged.length + groups.untracked.length
  const hasAnyChanges = uncommittedTotal + committedEntries.length > 0

  return (
    <div className="flex min-h-0 flex-1" data-testid="working-tree" data-session-state={sessionState}>
      <aside
        className="flex shrink-0 flex-col border-r border-border bg-card"
        style={{ width: `${String(sidebarWidth)}px` }}
        role="tree"
        aria-label={t('scm.worktree.changedFilesAria')}
        aria-multiselectable="true"
        onKeyDown={(event) => {
          const target = event.target
          const typing =
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
          const onTreeItem =
            target instanceof HTMLElement &&
            target.getAttribute('role') === 'treeitem' &&
            target.getAttribute('data-scm-row') === 'file'
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !typing) {
            event.preventDefault()
            setSelection(selectAll(visibleKeys))
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setSelection(EMPTY_SELECTION)
            return
          }
          if (!onTreeItem) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (visibleEntries.length === 0) return
            const current =
              selectedKey === null
                ? -1
                : visibleEntries.findIndex((entry) => entry.key === selectedKey)
            const nextIndex = Math.max(
              0,
              Math.min(
                visibleEntries.length - 1,
                current + (event.key === 'ArrowDown' ? 1 : -1)
              )
            )
            const next = visibleEntries[nextIndex]
            if (next === undefined) return
            setSelectedKey(next.key)
            window.requestAnimationFrame(() => rowButtonRefs.current.get(next.key)?.focus())
            return
          }
          if (event.key === ' ') {
            if (selected === null) return
            if (selected.area === 'conflicts' || selected.area === 'committed') return
            event.preventDefault()
            if (selected.area === 'staged') onUnstage(selected.entry.path)
            else onStage(selected.entry.path)
            return
          }
          if (event.key === 'Delete' && selected !== null && selected.area !== 'committed') {
            event.preventDefault()
            onDiscard(selected)
          }
        }}
      >
        {sidebarHeader}
        {selection.selected.size > 0 ? (
          <div
            className="flex flex-wrap items-center gap-1 border-b border-signal/40 bg-signal-weak px-2 py-1 text-[10px]"
            data-testid="scm-batch-bar"
          >
            <strong className="mr-1 text-foreground">{t('scm.selection.selected', { count: selection.selected.size })}</strong>
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 hover:bg-card disabled:opacity-40"
              disabled={selectedActions.stageable.length === 0}
              onClick={() => onStageEntries(selectedActions.stageable)}
              data-testid="scm-stage-selected"
            >
              {t('scm.worktree.stage')}
            </button>
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 hover:bg-card disabled:opacity-40"
              disabled={selectedActions.unstageable.length === 0}
              onClick={() => onUnstageEntries(selectedActions.unstageable)}
              data-testid="scm-unstage-selected"
            >
              {t('scm.worktree.unstage')}
            </button>
            <button
              type="button"
              className="rounded border border-destructive/50 px-1.5 py-0.5 text-destructive hover:bg-destructive/10 disabled:opacity-40"
              disabled={selectedActions.discardable.length === 0}
              onClick={() => onDiscardEntries(selectedActions.discardable)}
              data-testid="scm-discard-selected"
            >
              {t('scm.worktree.discard')}
            </button>
            <button
              type="button"
              className="ml-auto rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
              data-testid="scm-clear-selection"
              onClick={() => setSelection(EMPTY_SELECTION)}
            >
              {t('scm.worktree.clear')}
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <Search size={12} className="shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('scm.worktree.filter')}
            aria-label={t('scm.worktree.filterAria')}
            className="h-7 min-w-0 flex-1 rounded border border-border bg-transparent px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
            data-testid="working-tree-search"
          />
          <button
            type="button"
            className={`rounded p-1 ${viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            aria-label={t('scm.worktree.listView')}
            aria-pressed={viewMode === 'list'}
            title={t('scm.worktree.listView')}
            data-testid="scm-view-list"
            onClick={() => updateViewMode('list')}
          >
            <List size={12} />
          </button>
          <button
            type="button"
            className={`rounded p-1 ${viewMode === 'tree' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            aria-label={t('scm.worktree.treeView')}
            aria-pressed={viewMode === 'tree'}
            title={t('scm.worktree.treeView')}
            data-testid="scm-view-tree"
            onClick={() => updateViewMode('tree')}
          >
            <ListTree size={12} />
          </button>
          <select
            value={sort}
            onChange={(event) => updateSort(event.target.value as ScmSortKey)}
            aria-label={t('scm.worktree.sortAria')}
            title={t('scm.worktree.sortAria')}
            className="h-7 rounded border border-border bg-transparent px-1 text-[9.5px] text-muted-foreground outline-none"
            data-testid="scm-sort"
          >
            <option value="name">{t('scm.worktree.sort.name')}</option>
            <option value="path">{t('scm.worktree.sort.path')}</option>
            <option value="status">{t('scm.worktree.sort.status')}</option>
          </select>
        </div>
        {snapshot === null ? (
          <div
            className="px-3 py-4 text-[11px] text-muted-foreground"
            data-testid="working-tree-loading"
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" />
                {t('scm.changes.reading')}
              </span>
            ) : (
              t('review.gitStateUnavailable')
            )}
          </div>
        ) : !hasAnyChanges ? (
          <p className="px-3 py-4 text-[11px] text-muted-foreground">
            {baseOid === null
              ? t('scm.worktree.noChanges')
              : t('scm.worktree.matchesBase', { base: baseOid.slice(0, 7) })}
          </p>
        ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-muted-foreground">
              {t('scm.worktree.noMatch')}
            </p>
          ) : (
            groupedRows.map(({ group, rows: groupRows }) => {
              const groupEntries = displayEntries.get(group.id) ?? []
              return (
                <section
                  key={group.id}
                  role="group"
                  aria-label={t(GROUP_KEY[group.id])}
                  data-testid={`working-section-${group.id}`}
                >
                  <div className="flex h-7 items-center gap-1 border-b border-border bg-card px-1.5">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                      onClick={() => setCollapsed((current) => toggleCollapsed(current, group.id))}
                      aria-expanded={!group.collapsed}
                      data-testid={`working-section-toggle-${group.id}`}
                    >
                      {group.collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      <span className="truncate">{t(GROUP_KEY[group.id])}</span>
                      <span className="font-mono text-[9px] text-muted-foreground">{group.count}</span>
                    </button>
                    <span className="flex shrink-0 items-center gap-0.5">
                      {group.id === 'committed' ? null : group.id === 'conflicts' ? (
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title={t('scm.worktree.resolveConflicts')}
                          onClick={onOpenTerminal}
                        >
                          <TerminalSquare size={11} />
                        </button>
                      ) : (
                        <>
                          {group.id === 'staged' ? (
                            <button
                              type="button"
                              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                              title={t('scm.worktree.unstageAll')}
                              data-testid="git-unstage-all"
                              onClick={() => onUnstageEntries(groupEntries)}
                            >
                              <Minus size={11} />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                              title={t('scm.worktree.stageAll')}
                              data-testid={group.id === 'unstaged' ? 'git-stage-all' : undefined}
                              onClick={() => onStageEntries(groupEntries)}
                            >
                              <Plus size={11} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            title={t('scm.worktree.discardAll')}
                            onClick={() =>
                              onDiscardEntries(
                                groupEntries.filter(
                                  (entry) => entry.area !== 'conflicts' && entry.area !== 'committed'
                                )
                              )
                            }
                          >
                            <Trash2 size={11} />
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                  {group.collapsed ? null : (
                    <ul role="presentation">
                      {groupRows.map((row) => {
                        if (row.kind === 'folder') {
                          const allSelected =
                            row.resourceKeys.length > 0 &&
                            row.resourceKeys.every((key) => selection.selected.has(key))
                          return (
                            <li
                              key={row.id}
                              role="none"
                              className={`icode-scm-row flex min-h-8 items-center gap-1 border-b border-border/60 px-1.5 ${
                                allSelected ? 'bg-muted/60 text-foreground' : 'text-muted-foreground hover:bg-muted/50'
                              }`}
                              style={{ paddingLeft: `${String(6 + row.depth * 12)}px` }}
                              data-testid={`scm-folder-${row.group}-${row.path}`}
                              onContextMenu={(event) => {
                                if (row.group === 'committed') return
                                event.preventDefault()
                                openFolderMenu(row, event.clientX, event.clientY)
                              }}
                            >
                              {row.group === 'committed' ? null : (
                                <input
                                  type="checkbox"
                                  className="h-3 w-3 shrink-0 accent-signal"
                                  checked={allSelected}
                                  aria-label={t('scm.worktree.selectFolder', { path: row.path })}
                                  data-testid={`scm-folder-check-${row.group}-${row.path}`}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={() => {
                                    setSelection((current) => {
                                      const selected = new Set(current.selected)
                                      if (allSelected) {
                                        for (const key of row.resourceKeys) selected.delete(key)
                                      } else {
                                        for (const key of row.resourceKeys) selected.add(key)
                                      }
                                      return { selected, anchor: row.resourceKeys[0] ?? null }
                                    })
                                  }}
                                />
                              )}
                              <button
                                type="button"
                                role="treeitem"
                                data-scm-row="folder"
                                aria-level={row.depth + 1}
                                aria-selected={allSelected}
                                aria-expanded={!row.collapsed}
                                className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left"
                                onClick={() =>
                                  setCollapsed((current) => toggleCollapsed(current, row.id))
                                }
                                data-testid={`scm-folder-toggle-${row.group}-${row.path}`}
                              >
                                {row.collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                                <Folder size={11} />
                                <span className="truncate font-mono text-[10.5px]">{row.label}</span>
                                <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                                  {row.resourceKeys.length}
                                </span>
                              </button>
                              {row.group === 'committed' ? null : (
                                <button
                                  type="button"
                                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                  title={t('scm.worktree.folderActions')}
                                  aria-label={t('scm.worktree.actionsFor', { path: row.path })}
                                  data-testid={`scm-folder-more-${row.group}-${row.path}`}
                                  onClick={(event) => {
                                    const rect = event.currentTarget.getBoundingClientRect()
                                    openFolderMenu(row, rect.left - 180, rect.bottom + 4)
                                  }}
                                >
                                  <MoreHorizontal size={11} />
                                </button>
                              )}
                            </li>
                          )
                        }
                        const entry = row.entry
                        const { name, dir } = fileParts(entry.entry.path)
                        const note = entry.entry.oldPath ? `${entry.entry.oldPath} → ` : ''
                        const isSelected = selected?.key === entry.key
                        const isChecked = selection.selected.has(entry.key)
                        return (
                          <li
                            key={entry.key}
                            role="none"
                            className={`icode-scm-row flex min-h-9 items-center gap-1 border-b border-border/60 px-1.5 ${
                              isSelected
                                ? 'bg-muted text-foreground'
                                : isChecked
                                  ? 'bg-muted/60 text-foreground'
                                  : 'text-muted-foreground hover:bg-muted/50'
                            }`}
                            style={{ paddingLeft: `${String(6 + row.depth * 12)}px` }}
                            data-testid={`working-file-${entry.area}-${entry.entry.path}`}
                            data-area={entry.area}
                            data-selected={isChecked}
                            onContextMenu={(event) => {
                              event.preventDefault()
                              openMenu(entry, event.clientX, event.clientY)
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                                event.preventDefault()
                                const rect = event.currentTarget.getBoundingClientRect()
                                openMenu(entry, rect.left + 16, rect.bottom - 4)
                              }
                            }}
                          >
                            {entry.area === 'committed' ? null : (
                              <input
                                type="checkbox"
                                className="h-3 w-3 shrink-0 accent-signal"
                                checked={isChecked}
                                aria-label={`Select ${entry.entry.path}`}
                                data-testid={`scm-check-${entry.area}-${entry.entry.path}`}
                                onClick={(event) => event.stopPropagation()}
                                onChange={() => {
                                  setSelectedKey(entry.key)
                                  setSelection((current) => toggleSelection(current, entry.key))
                                }}
                              />
                            )}
                            <span className={`w-3 shrink-0 text-center font-mono text-[10px] font-semibold ${statusTone(entry)}`}>
                              {statusLetter(entry)}
                            </span>
                            <button
                              type="button"
                              role="treeitem"
                              data-scm-row="file"
                              aria-level={row.depth + 1}
                              aria-selected={isSelected || isChecked}
                              aria-label={entry.entry.path}
                              tabIndex={isSelected ? 0 : -1}
                              ref={(element) => {
                                if (element === null) rowButtonRefs.current.delete(entry.key)
                                else rowButtonRefs.current.set(entry.key, element)
                              }}
                              className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
                              onClick={(event) => onRowClick(entry, event)}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="flex min-w-0 items-baseline gap-1.5">
                                  <span className="truncate font-mono text-[11px] text-foreground">{name}</span>
                                  {dir ? <span className="truncate font-sans text-[9px] text-muted-foreground">{dir}</span> : null}
                                </span>
                                {note ? <span className="block truncate font-mono text-[9px] text-muted-foreground">{note}</span> : null}
                              </span>
                              <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                                {entry.added === null ? '—' : `+${String(entry.added)}`}{' '}
                                {entry.removed === null ? '' : `−${String(entry.removed)}`}
                              </span>
                            </button>
                            <span className="flex shrink-0 items-center gap-0.5">
                              {entry.area === 'committed' ? null : entry.area === 'conflicts' ? (
                                <button
                                  type="button"
                                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                  title={t('scm.worktree.openConflict')}
                                  onClick={onOpenTerminal}
                                >
                                  <AlertTriangle size={11} />
                                </button>
                              ) : entry.area === 'staged' ? (
                                <button
                                  type="button"
                                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                                  title={t('scm.worktree.unstage')}
                                  aria-label={`Unstage ${entry.entry.path}`}
                                  data-testid={`change-stage-${entry.area}-${entry.entry.path}`}
                                  onClick={() => onUnstage(entry.entry.path)}
                                >
                                  <Minus size={11} />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                                  title={t('scm.worktree.stage')}
                                  aria-label={`Stage ${entry.entry.path}`}
                                  data-testid={`change-stage-${entry.area}-${entry.entry.path}`}
                                  onClick={() => onStage(entry.entry.path)}
                                >
                                  <Plus size={11} />
                                </button>
                              )}
                              {entry.area === 'committed' || entry.area === 'conflicts' ? null : (
                                <button
                                  type="button"
                                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                  title={
                                    entry.area === 'untracked'
                                      ? t('scm.worktree.deleteUntrackedTitle')
                                      : t('scm.worktree.discardChangesTitle')
                                  }
                                  aria-label={`Discard ${entry.entry.path}`}
                                  data-testid={`change-discard-${entry.area}-${entry.entry.path}`}
                                  onClick={() => onDiscard(entry)}
                                >
                                  <Trash2 size={11} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                title={t('scm.worktree.openInFiles')}
                                aria-label={t('scm.worktree.openPathInFiles', { path: entry.entry.path })}
                                onClick={() => onOpenPath(entry.entry.path)}
                              >
                                <Search size={11} />
                              </button>
                              <button
                                type="button"
                                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                title={t('scm.worktree.moreActions')}
                                aria-label={t('scm.worktree.moreActionsFor', { path: entry.entry.path })}
                                data-testid={`scm-more-${entry.area}-${entry.entry.path}`}
                                onClick={(event) => {
                                  const rect = event.currentTarget.getBoundingClientRect()
                                  openMenu(entry, rect.left - 180, rect.bottom + 4)
                                }}
                              >
                                <MoreHorizontal size={11} />
                              </button>
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              )
            })
          )}
        </div>
        )}
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('scm.worktree.resizeAria')}
        title={t('scm.worktree.resizeTitle')}
        tabIndex={0}
        className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border focus-visible:bg-signal focus-visible:outline-none"
        data-testid="scm-sidebar-resizer"
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          persistSidebarWidth(sidebarWidthRef.current + (event.key === 'ArrowLeft' ? -16 : 16))
        }}
      />
      <div className="min-w-0 flex-1">
        {editorOverride !== undefined && editorOverride !== null ? (
          editorOverride
        ) : snapshot === null ? (
          loading ? (
            <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
              <Loader2 size={12} className="mr-2 animate-spin" />
              {t('scm.changes.reading')}
            </div>
          ) : (
            <div
              className="flex h-full items-center justify-center px-6 text-center text-[11px] text-signal"
              data-testid="working-tree-unavailable"
            >
              {t('scm.worktree.gitUnavailable')}
            </div>
          )
        ) : !hasAnyChanges ? (
          <div
            className="flex h-full items-center justify-center px-6 text-center"
            data-testid="working-tree-empty"
          >
            <div>
              <p className="text-[13px] font-medium text-foreground">
                {baseOid === null
                  ? t('scm.worktree.noChanges')
                  : t('scm.worktree.noChangesSince')}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {baseOid === null
                  ? t('scm.worktree.nothingDirty')
                  : t('scm.worktree.matchesBase', { base: baseOid.slice(0, 7) })}
              </p>
            </div>
          </div>
        ) : selected ? (
          selected.area === 'committed' &&
          selected.range !== undefined &&
          baseOid !== null ? (
            <CommittedFileDiff sessionId={sessionId} baseOid={baseOid} file={selected.range} />
          ) : (
            <WorkingDiffView
              sessionId={sessionId}
              entry={selected}
              state={diffViewState(selectedState)}
              onRetry={() => loadDiff(selected, true)}
              comments={comments.filter((comment) => comment.path === selected.entry.path)}
              onAddComment={onAddComment}
              onRemoveComment={onRemoveComment}
              scopeLabel={t(
                selected.area === 'staged'
                  ? 'scm.scope.staged'
                  : selected.area === 'untracked'
                    ? 'scm.scope.untracked'
                    : selected.area === 'conflicts'
                      ? 'scm.scope.conflict'
                      : 'scm.scope.unstaged'
              )}
              mode={settings.diffView}
              onModeChange={updateDiffView}
              onApplyHunk={
                onApplyHunk === undefined
                  ? undefined
                  : (patch, mode) => onApplyHunk(selected.entry.path, patch, mode)
              }
              onResolveConflict={
                onResolveConflict === undefined
                  ? undefined
                  : (text) => onResolveConflict(selected.entry.path, text)
              }
            />
          )
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
            {t('scm.worktree.selectFile')}
          </div>
        )}
      </div>
      {menu ? (
        <ScmContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          ariaLabel={menu.label}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}

export type { WorkingTreeGroups }

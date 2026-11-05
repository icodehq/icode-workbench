import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  History,
  Layers,
  List,
  Loader2,
  Clock,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  Tag,
  Undo2,
  X
} from 'lucide-react'
import { callApi } from '../lib/api'
import type {
  GitCommitActionPayload,
  GitCommitDetailPayload,
  GitFileAtRevisionPayload,
  GitLogPayload,
  GitRangeDiffPayload,
  GitResetPayload,
  GitRevisionFileDiffPayload
} from '../../../shared/icode-api'
import {
  GIT_EMPTY_TREE_OID,
  type GitCommitDetail,
  type GitLogEntry,
  type GitRangeFile
} from '../../../shared/domain/git-workspace'
import { makeAppError } from '../../../shared/domain/errors'
import type { Notice } from '../state/workspace'
import UnifiedDiffView, { type DiffViewState } from './UnifiedDiffView'
import MonacoDiffView from './MonacoDiffView'
import ScmContextMenu, { type ScmMenuItem } from '../scm/ScmContextMenu'
import ScmCommitDialog, {
  type CommitDialogKind,
  type ResetMode
} from './ScmCommitDialog'
import { buildHistoryGraph, type HistoryGraphRow } from '../scm/history-graph'
import { buildCommitFileTree, flattenCommitFileTree } from '../scm/commit-file-tree'
import {
  CommitFileDiffSection,
  LaneGraph,
  commitFilePayload,
  commitFileSides,
  fileName,
  refLabel,
  relativeTime,
  statusLetter,
  statusTone
} from './history/HistoryViewParts'

type Props = {
  sessionId: string
  /** The commit this session's worktree was created from. */
  baseOid: string | null
  notify: (notice: Notice) => void
  onClose: () => void
  /** Restricts History to commits touching this worktree-relative path. */
  initialPath?: string
  /** Asks Source Control to re-read status after a worktree-changing action. */
  onChanged?: () => void
}

type PageState =
  | { status: 'loading' }
  | {
      status: 'ready'
      branch: string | null
      upstream: string | null
      ahead: number
      behind: number
      commits: GitLogEntry[]
      hasMore: boolean
      nextSkip: number
    }
  | { status: 'error'; message: string }

export default function ScmHistoryView({
  sessionId,
  baseOid,
  notify,
  onClose,
  initialPath = '',
  onChanged
}: Props): React.JSX.Element {
  const [page, setPage] = useState<PageState>({ status: 'loading' })
  const [loadingMore, setLoadingMore] = useState(false)
  const [scope, setScope] = useState(baseOid === null ? 'HEAD' : 'SESSION')
  const scopeRef = useRef(baseOid === null ? 'HEAD' : 'SESSION')
  const [historyView, setHistoryView] = useState<'list' | 'timeline'>('list')
  /** Presents the selected commit's files flat (VS Code's list mode) or as a tree. */
  const [fileView, setFileView] = useState<'list' | 'tree'>('list')
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set())
  const [pathFilter, setPathFilter] = useState(initialPath)
  const pathRef = useRef(initialPath)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<GitLogEntry | null>(null)
  const [selectedOids, setSelectedOids] = useState<Set<string>>(() => new Set())
  const [range, setRange] = useState<{
    from: GitLogEntry
    to: GitLogEntry
    files: GitRangeFile[]
    truncated: boolean
  } | null>(null)
  const [rangeBusy, setRangeBusy] = useState(false)
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [parentChoice, setParentChoice] = useState<string | null>(null)
  const [file, setFile] = useState<GitRangeFile | null>(null)
  const [fileDiff, setFileDiff] = useState<Extract<GitRevisionFileDiffPayload, { status: 'ok' }> | null>(
    null
  )
  const [fileSides, setFileSides] = useState<{ original: string; modified: string } | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [multiOpen, setMultiOpen] = useState(false)
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialogKind, setDialogKind] = useState<CommitDialogKind | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const pageGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const fileGeneration = useRef(0)

  const load = useCallback(
    async (
      skip: number,
      append: boolean,
      refScope = scopeRef.current,
      filterPath = pathRef.current
    ): Promise<void> => {
      const generation = pageGeneration.current + 1
      pageGeneration.current = generation
      if (append) setLoadingMore(true)
      else setPage({ status: 'loading' })
      const result = await callApi<GitLogPayload>(
        window.icode.git.log({
          sessionId,
          limit: 50,
          skip,
          ...(refScope === 'SESSION' && baseOid !== null ? { ref: `${baseOid}..HEAD` } : {}),
          ...(filterPath.length > 0 ? { path: filterPath } : {})
        })
      )
      if (pageGeneration.current !== generation) return
      setLoadingMore(false)
      if (!result.ok) {
        if (append) {
          notify({ tone: 'error', message: result.error.message })
          return
        }
        setPage({ status: 'error', message: result.error.message })
        return
      }
      if (result.value.status === 'unavailable') {
        if (append) {
          notify({ tone: 'error', message: result.value.detail })
          return
        }
        setPage({ status: 'error', message: result.value.detail })
        return
      }
      const value = result.value
      setPage((current) => {
        const commits =
          append && current.status === 'ready'
            ? [...current.commits, ...value.commits]
            : value.commits
        // A page boundary can repeat the boundary commit when HEAD advanced
        // between reads; keep the first occurrence so React keys stay unique.
        const seen = new Set<string>()
        const unique = commits.filter((commit) => {
          if (seen.has(commit.oid)) return false
          seen.add(commit.oid)
          return true
        })
        return {
          status: 'ready',
          branch: value.branch,
          upstream: value.upstream,
          ahead: value.ahead,
          behind: value.behind,
          commits: unique,
          hasMore: value.hasMore,
          nextSkip: value.nextSkip
        }
      })
    },
    [baseOid, notify, sessionId]
  )

  useEffect(() => {
    setSelected(null)
    setDetail(null)
    setFile(null)
    setFileDiff(null)
    setQuery('')
    const nextScope = baseOid === null ? 'HEAD' : 'SESSION'
    setScope(nextScope)
    scopeRef.current = nextScope
    setPathFilter(initialPath)
    pathRef.current = initialPath
    void load(0, false, nextScope, initialPath)
  }, [baseOid, initialPath, load, sessionId])

  const changeScope = (next: string): void => {
    setScope(next)
    scopeRef.current = next
    setSelected(null)
    setDetail(null)
    setFile(null)
    setMultiOpen(false)
    void load(0, false, next)
  }

  const clearPathFilter = (): void => {
    setPathFilter('')
    pathRef.current = ''
    setSelected(null)
    setDetail(null)
    setFile(null)
    setMultiOpen(false)
    void load(0, false, scopeRef.current, '')
  }

  const rangeFileSides = async (
    fromOid: string,
    toOid: string,
    target: GitRangeFile
  ): Promise<{ original: string; modified: string } | null> => {
    const originalPath = target.oldPath ?? target.path
    const [originalRead, modifiedRead] = await Promise.all([
      callApi<GitFileAtRevisionPayload>(
        window.icode.git.fileAtRevision({ sessionId, rev: fromOid, path: originalPath })
      ),
      callApi<GitFileAtRevisionPayload>(
        window.icode.git.fileAtRevision({ sessionId, rev: toOid, path: target.path })
      )
    ])
    const textOf = (
      result: typeof originalRead,
      allowMissing: boolean
    ): string | null => {
      if (!result.ok) return null
      if (result.value.status !== 'ok') return allowMissing ? '' : null
      if (result.value.binary || result.value.tooLarge) return null
      return result.value.text
    }
    const original = textOf(originalRead, target.status === 'added')
    const modified = textOf(modifiedRead, target.status === 'deleted')
    if (original === null || modified === null) return null
    return { original, modified }
  }

  const openCommit = useCallback(
    async (entry: GitLogEntry, parent?: string): Promise<void> => {
      const generation = detailGeneration.current + 1
      detailGeneration.current = generation
      setSelected(entry)
      setRange(null)
      setDetail(null)
      setDetailError(null)
      setDetailLoading(true)
      setParentChoice(parent ?? null)
      setFile(null)
      setFileDiff(null)
      setFileSides(null)
      setFileError(null)
      setFileLoading(false)
      setMultiOpen(false)
      fileGeneration.current += 1
      const result = await callApi<GitCommitDetailPayload>(
        window.icode.git.commitDetail({
          sessionId,
          oid: entry.oid,
          ...(parent === undefined ? {} : { parent })
        })
      )
      if (detailGeneration.current !== generation) return
      setDetailLoading(false)
      if (!result.ok) {
        setDetailError(result.error.message)
        return
      }
      if (result.value.status === 'unavailable') {
        setDetailError(result.value.detail)
        return
      }
      const value = result.value
      setDetail({
        oid: value.oid,
        shortOid: value.shortOid,
        parents: value.parents,
        subject: value.subject,
        body: value.body,
        author: value.author,
        authorEmail: value.authorEmail,
        authoredAt: value.authoredAt,
        parentOid: value.parentOid,
        files: value.files,
        additions: value.additions,
        deletions: value.deletions,
        truncated: value.truncated
      })
    },
    [sessionId]
  )

  const openFile = useCallback(
    async (target: GitRangeFile): Promise<void> => {
      if (detail === null) return
      const generation = fileGeneration.current + 1
      fileGeneration.current = generation
      setFile(target)
      setFileDiff(null)
      setFileSides(null)
      setFileError(null)
      setFileLoading(true)
      const from = detail.parentOid ?? GIT_EMPTY_TREE_OID
      const [result, sides] = await Promise.all([
        callApi<GitRevisionFileDiffPayload>(
          window.icode.git.revisionFileDiff({
            sessionId,
            from,
            to: detail.oid,
            path: target.path,
            ...(target.oldPath ? { oldPath: target.oldPath } : {})
          })
        ),
        commitFileSides(sessionId, detail, target)
      ])
      if (fileGeneration.current !== generation) return
      setFileLoading(false)
      if (!result.ok) {
        setFileError(result.error.message)
        return
      }
      if (result.value.status === 'unavailable') {
        setFileError(result.value.detail)
        return
      }
      setFileDiff(result.value)
      setFileSides(sides)
    },
    [detail, sessionId]
  )

  const toggleSelected = (oid: string): void => {
    setSelectedOids((current) => {
      const next = new Set(current)
      if (next.has(oid)) next.delete(oid)
      else next.add(oid)
      return next
    })
  }

  const selectedCommits = useMemo(
    () =>
      page.status === 'ready'
        ? page.commits.filter((commit) => selectedOids.has(commit.oid))
        : [],
    [page, selectedOids]
  )

  useEffect(() => {
    if (page.status !== 'ready') return
    const available = new Set(page.commits.map((commit) => commit.oid))
    setSelectedOids((current) => {
      const next = new Set([...current].filter((oid) => available.has(oid)))
      return next.size === current.size ? current : next
    })
  }, [page])

  const compareSelected = async (): Promise<void> => {
    if (selectedCommits.length < 2 || rangeBusy) return
    const to = selectedCommits[0]!
    const from = selectedCommits[selectedCommits.length - 1]!
    setRangeBusy(true)
    setRangeError(null)
    try {
      const result = await callApi<GitRangeDiffPayload>(
        window.icode.git.rangeDiff({ sessionId, from: from.oid, to: to.oid })
      )
      if (!result.ok) {
        setRangeError(result.error.message)
        return
      }
      if (result.value.status === 'unavailable') {
        setRangeError(result.value.detail)
        return
      }
      setRange({
        from,
        to,
        files: result.value.files,
        truncated: result.value.truncated
      })
      setSelected(null)
      setDetail(null)
      setMultiOpen(false)
      setFile(null)
      setFileDiff(null)
      setFileSides(null)
      setFileError(null)
      setFileLoading(false)
      fileGeneration.current += 1
    } finally {
      setRangeBusy(false)
    }
  }

  const openRangeFile = async (target: GitRangeFile): Promise<void> => {
    if (range === null) return
    const generation = fileGeneration.current + 1
    fileGeneration.current = generation
    setFile(target)
    setFileDiff(null)
    setFileSides(null)
    setFileError(null)
    setFileLoading(true)
    const [result, sides] = await Promise.all([
      callApi<GitRevisionFileDiffPayload>(
        window.icode.git.revisionFileDiff({
          sessionId,
          from: range.from.oid,
          to: range.to.oid,
          path: target.path,
          ...(target.oldPath ? { oldPath: target.oldPath } : {})
        })
      ),
      rangeFileSides(range.from.oid, range.to.oid, target)
    ])
    if (fileGeneration.current !== generation) return
    setFileLoading(false)
    if (!result.ok) {
      setFileError(result.error.message)
      return
    }
    if (result.value.status === 'unavailable') {
      setFileError(result.value.detail)
      return
    }
    setFileDiff(result.value)
    setFileSides(sides)
  }

  const copySelectedHashes = async (): Promise<void> => {
    if (selectedCommits.length === 0) return
    await copy(selectedCommits.map((commit) => commit.oid).join('\n'))
  }

  const rows = useMemo(
    () => (page.status === 'ready' ? buildHistoryGraph(page.commits) : []),
    [page]
  )
  const maxLane = useMemo(
    () => rows.reduce((max, row) => Math.max(max, row.lane, ...row.lanes, ...row.parentLanes), 0),
    [rows]
  )
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return rows
    return rows.filter(
      (row) =>
        row.entry.subject.toLowerCase().includes(needle) ||
        row.entry.author.toLowerCase().includes(needle) ||
        row.entry.authorEmail.toLowerCase().includes(needle) ||
        row.entry.shortOid.startsWith(needle) ||
        row.entry.refs.some((ref) => ref.toLowerCase().includes(needle))
    )
  }, [query, rows])

  const timelineGroups = useMemo(() => {
    const groups: Array<{ key: string; label: string; rows: HistoryGraphRow[] }> = []
    for (const row of visibleRows) {
      const date = new Date(row.entry.authoredAt * 1000)
      const key = `${String(date.getFullYear())}-${String(date.getMonth())}-${String(date.getDate())}`
      let group = groups[groups.length - 1]
      if (group === undefined || group.key !== key) {
        const today = new Date()
        const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
        const sameDay = (other: Date): boolean =>
          other.getFullYear() === date.getFullYear() &&
          other.getMonth() === date.getMonth() &&
          other.getDate() === date.getDate()
        const label = sameDay(today)
          ? 'Today'
          : sameDay(yesterday)
            ? 'Yesterday'
            : date.toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric'
              })
        group = { key, label, rows: [] }
        groups.push(group)
      }
      group.rows.push(row)
    }
    return groups
  }, [visibleRows])

  const commitFileRows = useMemo(() => {
    if (fileView !== 'tree' || detail === null) return []
    return flattenCommitFileTree(buildCommitFileTree(detail.files), collapsedFolders)
  }, [collapsedFolders, detail, fileView])

  const toggleFolder = (path: string): void => {
    setCollapsedFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      notify({ tone: 'success', message: `Copied ${text}` })
    } catch {
      notify({ tone: 'error', message: 'Clipboard is unavailable.' })
    }
  }

  const openDialog = (kind: CommitDialogKind): void => {
    setCommitMenu(null)
    setActionError(null)
    setDialogKind(kind)
  }

  const runCommitAction = async (value: { mode?: ResetMode }): Promise<void> => {
    if (selected === null || dialogKind === null || actionBusy) return
    setActionBusy(true)
    setActionError(null)
    const fail = (message: string): void => {
      setActionError(message)
      setActionBusy(false)
    }
    try {
      if (dialogKind === 'cherry-pick' || dialogKind === 'revert') {
        const action = dialogKind
        const result = await callApi<GitCommitActionPayload>(
          action === 'cherry-pick'
            ? window.icode.git.cherryPick({ sessionId, oid: selected.oid })
            : window.icode.git.revert({ sessionId, oid: selected.oid })
        )
        if (!result.ok) return fail(result.error.message)
        if (result.value.status === 'unavailable') return fail(result.value.detail)
        notify({
          tone: 'success',
          message:
            action === 'cherry-pick'
              ? `Cherry-picked as ${result.value.shortOid}: ${result.value.subject}`
              : `Reverted as ${result.value.shortOid}: ${result.value.subject}`
        })
        setDialogKind(null)
        await load(0, false)
        onChanged?.()
      } else {
        const mode = value.mode ?? 'mixed'
        const result = await callApi<GitResetPayload>(
          window.icode.git.reset({ sessionId, oid: selected.oid, mode })
        )
        if (!result.ok) return fail(result.error.message)
        if (result.value.status === 'unavailable') return fail(result.value.detail)
        notify({
          tone: 'success',
          message: `Reset ${result.value.branch ?? 'HEAD'} to ${selected.shortOid} (${mode})`
        })
        setDialogKind(null)
        setSelected(null)
        setDetail(null)
        await load(0, false)
        onChanged?.()
      }
      setActionBusy(false)
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The Git action failed.')
    }
  }

  const commitMenuItems = (): ScmMenuItem[] => {
    if (selected === null) return []
    return [
      {
        id: 'cherry-pick',
        label: 'Cherry-pick commit',
        icon: <GitCommitHorizontal size={12} />,
        testId: 'scm-commit-cherry-pick',
        onSelect: () => openDialog('cherry-pick')
      },
      {
        id: 'revert',
        label: 'Revert commit',
        icon: <Undo2 size={12} />,
        testId: 'scm-commit-revert',
        onSelect: () => openDialog('revert')
      },
      {
        id: 'reset',
        label: 'Reset branch to here…',
        icon: <RotateCcw size={12} />,
        danger: true,
        separatorBefore: true,
        testId: 'scm-commit-reset',
        onSelect: () => openDialog('reset')
      },
      {
        id: 'copy-message',
        label: 'Copy commit message',
        icon: <Copy size={12} />,
        separatorBefore: true,
        testId: 'scm-commit-copy-message',
        onSelect: () => void copy(selected.subject)
      }
    ]
  }

  const renderCommitRow = (row: HistoryGraphRow): React.JSX.Element => {
    const entry = row.entry
    const active = selected?.oid === entry.oid
    return (
      <li key={entry.oid} role="presentation" className="flex items-stretch border-b border-border/60">
        <input
          type="checkbox"
          className="ml-2 mt-2 h-3 w-3 shrink-0 accent-signal"
          checked={selectedOids.has(entry.oid)}
          aria-label={`Select commit ${entry.shortOid}`}
          data-testid={`scm-history-check-${entry.shortOid}`}
          onChange={() => toggleSelected(entry.oid)}
        />
        <button
          type="button"
          role="option"
          aria-selected={selectedOids.has(entry.oid) || active}
          aria-label={`${entry.subject}, ${entry.author}, ${entry.shortOid}`}
          className={`flex min-w-0 flex-1 items-start gap-1.5 px-1 py-1 text-left ${
            active ? 'bg-muted' : 'hover:bg-muted/50'
          }`}
          onClick={() => void openCommit(entry)}
          aria-current={active ? 'true' : undefined}
          data-testid={`scm-history-commit-${entry.shortOid}`}
          title={`${entry.subject}\n${entry.author} <${entry.authorEmail}>\n${new Date(entry.authoredAt * 1000).toLocaleString()}`}
        >
          <LaneGraph row={row} maxLane={maxLane} />
          <span className="min-w-0 flex-1 pt-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              <span className="min-w-0 truncate text-[11.5px] text-foreground">
                {entry.subject}
              </span>
              {entry.refs.slice(0, 3).map((ref) => (
                <span
                  key={ref}
                  className={`inline-flex max-w-[180px] shrink-0 items-center gap-0.5 truncate rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] ${
                    ref.startsWith('HEAD')
                      ? 'border-add/50 bg-add-weak text-add'
                      : ref.startsWith('tag:')
                        ? 'border-signal-line bg-signal-weak text-signal'
                        : 'border-info/40 bg-info-weak text-info'
                  }`}
                >
                  {ref.startsWith('tag:') ? <Tag size={8} /> : null}
                  {refLabel(ref)}
                </span>
              ))}
              {entry.refs.length > 3 ? (
                <span className="text-[8.5px] text-muted-foreground">
                  +{entry.refs.length - 3}
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-[9.5px] text-muted-foreground">
              {entry.author} · {relativeTime(entry.authoredAt)}
            </span>
          </span>
          <span className="shrink-0 pt-1 font-mono text-[9.5px] text-accent">
            {entry.shortOid}
          </span>
        </button>
      </li>
    )
  }

  const renderDetailFile = (entry: GitRangeFile, depth: number): React.JSX.Element => {
    const name = fileName(entry.path)
    const oldName = entry.oldPath === null ? null : fileName(entry.oldPath)
    const label =
      fileView === 'tree'
        ? oldName !== null && oldName !== name
          ? `${oldName} → ${name}`
          : name
        : `${entry.oldPath ? `${entry.oldPath} → ` : ''}${entry.path}`
    return (
      <button
        type="button"
        className="flex w-full items-center gap-1.5 border-b border-border/60 py-1.5 pr-3 text-left hover:bg-muted/50"
        style={{ paddingLeft: `${String(12 + depth * 12)}px` }}
        onClick={() => void openFile(entry)}
        title={entry.path}
        data-testid={`scm-history-file-${entry.path}`}
      >
        <span className={`w-3 shrink-0 text-center font-mono text-[10px] font-semibold ${statusTone(entry.status)}`}>
          {statusLetter(entry.status)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground">
          {label}
        </span>
        {entry.binary ? (
          <span className="shrink-0 rounded bg-muted px-1 text-[8.5px] text-muted-foreground">
            binary
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
            +{entry.additions ?? 0} −{entry.deletions ?? 0}
          </span>
        )}
      </button>
    )
  }

  const fileDiffState: DiffViewState = fileLoading
    ? { phase: 'loading' }
    : fileError !== null
      ? {
          phase: 'error',
          error: makeAppError('GIT_READ_FAILED', fileError)
        }
      : fileDiff !== null && file !== null
        ? { phase: 'ready', diff: commitFilePayload(sessionId, file, fileDiff) }
        : { phase: 'idle' }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="scm-history">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <History size={13} className="shrink-0 text-muted-foreground" />
        <span className="text-[11.5px] font-semibold text-foreground">History</span>
        {page.status === 'ready' && page.branch !== null ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
            {page.branch}
          </span>
        ) : null}
        {page.status === 'ready' && page.ahead > 0 ? (
          <span
            className="shrink-0 rounded-full border border-info/40 bg-info-weak px-1.5 py-0.5 font-mono text-[9px] text-info"
            title={`${String(page.ahead)} commit(s) to push to ${page.upstream ?? 'the upstream'}`}
            data-testid="scm-history-outgoing"
          >
            ↑{page.ahead}
          </span>
        ) : null}
        {page.status === 'ready' && page.behind > 0 ? (
          <span
            className="shrink-0 rounded-full border border-signal-line bg-signal-weak px-1.5 py-0.5 font-mono text-[9px] text-signal"
            title={`${String(page.behind)} commit(s) to pull from ${page.upstream ?? 'the upstream'}`}
            data-testid="scm-history-incoming"
          >
            ↓{page.behind}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-[10.5px] hover:bg-muted disabled:opacity-40"
            onClick={() => void load(0, false)}
            disabled={page.status === 'loading'}
            data-testid="scm-history-refresh"
          >
            <RefreshCw size={10} className={page.status === 'loading' ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label="Close commit history"
            title="Back to changes"
            data-testid="scm-history-close"
          >
            <X size={13} />
          </button>
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={`flex min-w-0 flex-1 flex-col ${file !== null || multiOpen ? 'hidden' : ''}`}>
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search size={12} className="shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter commits by subject, author, hash or ref…"
              aria-label="Filter commits"
              className="h-7 min-w-0 flex-1 rounded border border-border bg-transparent px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
              data-testid="scm-history-search"
            />
            <select
              value={scope}
              onChange={(event) => changeScope(event.target.value)}
              aria-label="History ref"
              title="History ref"
              className="h-7 max-w-[170px] shrink-0 rounded border border-border bg-transparent px-1 text-[9.5px] text-muted-foreground outline-none"
              data-testid="scm-history-ref"
            >
              <option value="SESSION">This session</option>
              <option value="HEAD">Current branch</option>
            </select>
            {pathFilter.length > 0 ? (
              <span
                className="inline-flex h-7 min-w-0 max-w-[190px] shrink items-center gap-1 rounded border border-info/40 bg-info-weak px-1.5 font-mono text-[9px] text-info"
                title={`Only commits touching ${pathFilter}`}
                data-testid="scm-history-path"
              >
                <span className="min-w-0 truncate">{pathFilter}</span>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 hover:bg-info/15"
                  onClick={clearPathFilter}
                  aria-label="Clear path filter"
                  data-testid="scm-history-clear-path"
                >
                  <X size={9} />
                </button>
              </span>
            ) : null}
            <span className="inline-flex shrink-0 overflow-hidden rounded border border-border">
              <button
                type="button"
                className={`p-1 ${historyView === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setHistoryView('list')}
                aria-pressed={historyView === 'list'}
                aria-label="List view"
                title="List view"
                data-testid="scm-history-view-list"
              >
                <List size={10} />
              </button>
              <button
                type="button"
                className={`border-l border-border p-1 ${historyView === 'timeline' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setHistoryView('timeline')}
                aria-pressed={historyView === 'timeline'}
                aria-label="Timeline view"
                title="Timeline view"
                data-testid="scm-history-view-timeline"
              >
                <Clock size={10} />
              </button>
            </span>
            <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
              {page.status === 'ready' ? `${String(page.commits.length)} loaded` : ''}
            </span>
          </div>

          {selectedOids.size > 0 ? (
            <div
              className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-1.5"
              data-testid="scm-history-selection"
            >
              <span className="text-[10px] text-foreground">
                {selectedOids.size} commit{selectedOids.size === 1 ? '' : 's'} selected
              </span>
              <span className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  data-testid="scm-history-copy-selected"
                  onClick={() => void copySelectedHashes()}
                >
                  <Copy size={9} />
                  Copy hashes
                </button>
                <button
                  type="button"
                  className="rounded border border-signal-line bg-signal-weak px-1.5 py-0.5 text-[9px] text-signal hover:brightness-95 disabled:opacity-40"
                  disabled={selectedCommits.length < 2 || rangeBusy}
                  title={
                    selectedCommits.length < 2
                      ? 'Select at least two commits to compare'
                      : 'Compare the oldest and newest selected commits'
                  }
                  data-testid="scm-history-compare-selected"
                  onClick={() => void compareSelected()}
                >
                  {rangeBusy ? 'Comparing…' : 'Compare'}
                </button>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-foreground"
                  data-testid="scm-history-clear-selection"
                  onClick={() => setSelectedOids(new Set())}
                >
                  Clear
                </button>
              </span>
              {rangeError !== null ? (
                <p className="w-full text-[9px] text-destructive" data-testid="scm-range-error">
                  {rangeError}
                </p>
              ) : null}
            </div>
          ) : null}

          {page.status === 'loading' ? (
            <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
              <Loader2 size={12} className="mr-2 animate-spin" />
              Reading commit history…
            </div>
          ) : page.status === 'error' ? (
            <div
              className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-signal"
              data-testid="scm-history-error"
            >
              <AlertTriangle size={14} />
              <p>{page.message}</p>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-[10.5px] text-foreground hover:bg-muted"
                onClick={() => void load(0, false)}
              >
                Try again
              </button>
            </div>
          ) : page.commits.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 text-[11px] text-muted-foreground" data-testid="scm-history-empty">
              This worktree has no commits yet.
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto" data-testid="scm-history-list">
                {visibleRows.length === 0 ? (
                  <p className="px-3 py-4 text-[11px] text-muted-foreground">
                    No commits match this filter.
                  </p>
                ) : (
                  historyView === 'timeline' ? (
                    <div data-testid="scm-history-timeline">
                      {timelineGroups.map((group) => (
                        <section key={group.key}>
                          <h3 className="sticky top-0 z-[1] border-b border-border bg-card px-2 py-1 text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {group.label}
                            <span className="ml-1.5 font-mono text-[9px] font-normal">
                              {group.rows.length}
                            </span>
                          </h3>
                          <ul
                            role="listbox"
                            aria-label={group.label}
                            aria-multiselectable="true"
                          >
                            {group.rows.map(renderCommitRow)}
                          </ul>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <ul role="listbox" aria-label="Commit history" aria-multiselectable="true">
                      {visibleRows.map(renderCommitRow)}
                    </ul>
                  )
                )}
              </div>
              {page.hasMore ? (
                <div className="shrink-0 border-t border-border bg-card px-2 py-1.5 text-center">
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1.5 rounded border border-border px-3 text-[10.5px] hover:bg-muted disabled:opacity-40"
                    onClick={() => void load(page.nextSkip, true)}
                    disabled={loadingMore}
                    data-testid="scm-history-load-more"
                  >
                    {loadingMore ? <Loader2 size={10} className="animate-spin" /> : <ChevronDown size={10} />}
                    Load more commits
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div
          className={`flex shrink-0 flex-col bg-card ${
            file !== null || multiOpen
              ? 'min-w-0 flex-1'
              : 'w-[min(430px,45%)] min-w-[280px] border-l border-border'
          }`}
          data-testid="scm-history-detail"
        >
          {range !== null ? (
            <div className="flex min-h-0 flex-1 flex-col" data-testid="scm-range-compare">
              <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setRange(null)
                    setFile(null)
                    setFileDiff(null)
                    setFileSides(null)
                    setFileError(null)
                  }}
                  data-testid="scm-range-back"
                >
                  <ArrowLeft size={11} />
                  History
                </button>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground"
                  data-testid="scm-range-header"
                >
                  {range.from.shortOid}..{range.to.shortOid}
                </span>
                <span className="shrink-0 text-[9.5px] text-muted-foreground">
                  {String(range.files.length)} file{range.files.length === 1 ? '' : 's'}
                </span>
              </div>
              {file !== null ? (
                <>
                  <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => {
                        setFile(null)
                        setFileDiff(null)
                        setFileSides(null)
                        setFileError(null)
                      }}
                      data-testid="scm-range-file-back"
                    >
                      <ArrowLeft size={11} />
                      Files
                    </button>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground">
                      {file.path}
                    </span>
                    <span className={`shrink-0 font-mono text-[9px] ${statusTone(file.status)}`}>
                      {statusLetter(file.status)}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1" data-testid="scm-range-file-diff">
                    {fileSides !== null ? (
                      <MonacoDiffView
                        path={file.path}
                        original={fileSides.original}
                        modified={fileSides.modified}
                        fallback={
                          <UnifiedDiffView
                            path={file.path}
                            state={fileDiffState}
                            onRetry={() => void openRangeFile(file)}
                            scopeLabel={`${range.from.shortOid}..${range.to.shortOid}`}
                          />
                        }
                      />
                    ) : (
                      <UnifiedDiffView
                        path={file.path}
                        state={fileDiffState}
                        onRetry={() => void openRangeFile(file)}
                        scopeLabel={`${range.from.shortOid}..${range.to.shortOid}`}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {range.truncated ? (
                    <p className="border-b border-signal-line bg-signal-weak px-3 py-1.5 text-[10px] text-signal">
                      This comparison is truncated to the first 5,000 files.
                    </p>
                  ) : null}
                  {range.files.length === 0 ? (
                    <p className="px-3 py-4 text-[11px] text-muted-foreground">
                      The selected commits have no file changes between them.
                    </p>
                  ) : (
                    <ul>
                      {range.files.map((entry) => (
                        <li key={`${entry.oldPath ?? ''}:${entry.path}`}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 border-b border-border/60 px-2 py-1 text-left hover:bg-muted/40"
                            data-testid={`scm-range-file-${entry.path}`}
                            onClick={() => void openRangeFile(entry)}
                          >
                            <span className={`w-3 shrink-0 font-mono text-[9px] font-semibold ${statusTone(entry.status)}`}>
                              {statusLetter(entry.status)}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground">
                              {entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
                            </span>
                            <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                              {entry.binary
                                ? 'binary'
                                : `${entry.additions === null ? '—' : `+${String(entry.additions)}`} ${
                                    entry.deletions === null ? '' : `−${String(entry.deletions)}`
                                  }`}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ) : multiOpen && detail !== null ? (
            <div className="flex min-h-0 flex-1 flex-col" data-testid="scm-multi-diff">
              <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => setMultiOpen(false)}
                  data-testid="scm-multi-diff-back"
                >
                  <ArrowLeft size={11} />
                  Commit
                </button>
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                  {detail.subject}
                </span>
                <span className="shrink-0 text-[9.5px] text-muted-foreground">
                  {String(Math.min(detail.files.length, 50))} of {String(detail.files.length)} files
                </span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                {detail.files.length === 0 ? (
                  <p className="px-2 py-4 text-[11px] text-muted-foreground">
                    This commit changed no files.
                  </p>
                ) : (
                  detail.files.slice(0, 50).map((entry) => (
                    <CommitFileDiffSection
                      key={`${entry.oldPath ?? ''}:${entry.path}`}
                      sessionId={sessionId}
                      commit={detail}
                      file={entry}
                    />
                  ))
                )}
                {detail.files.length > 50 ? (
                  <p className="px-2 py-2 text-[10px] text-signal">
                    The first 50 files are shown. Open the remaining files one at a time from the
                    commit detail.
                  </p>
                ) : null}
              </div>
            </div>
          ) : selected === null ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-[11px] text-muted-foreground">
              Select a commit to see its details.
            </div>
          ) : detailLoading ? (
            <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
              <Loader2 size={12} className="mr-2 animate-spin" />
              Reading commit…
            </div>
          ) : detailError !== null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-signal">
              <AlertTriangle size={14} />
              <p>{detailError}</p>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-[10.5px] text-foreground hover:bg-muted"
                onClick={() => void openCommit(selected, parentChoice ?? undefined)}
              >
                Try again
              </button>
            </div>
          ) : detail === null ? null : file !== null ? (
            <>
              <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setFile(null)
                    setFileDiff(null)
                    setFileSides(null)
                    setFileError(null)
                  }}
                  data-testid="scm-history-file-back"
                >
                  <ArrowLeft size={11} />
                  Files
                </button>
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground">
                  {file.path}
                </span>
                <span className={`shrink-0 font-mono text-[9px] ${statusTone(file.status)}`}>
                  {statusLetter(file.status)}
                </span>
              </div>
              <div className="min-h-0 flex-1" data-testid="scm-history-file-diff">
                {fileSides !== null ? (
                  <MonacoDiffView
                    path={file.path}
                    original={fileSides.original}
                    modified={fileSides.modified}
                    fallback={
                      <UnifiedDiffView
                        path={file.path}
                        state={fileDiffState}
                        onRetry={() => void openFile(file)}
                        scopeLabel={`commit ${detail.shortOid}`}
                      />
                    }
                  />
                ) : (
                  <UnifiedDiffView
                    path={file.path}
                    state={fileDiffState}
                    onRetry={() => void openFile(file)}
                    scopeLabel={`commit ${detail.shortOid}`}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="border-b border-border px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <GitCommitHorizontal size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-[12.5px] font-medium text-foreground">
                      {detail.subject}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {detail.author} &lt;{detail.authorEmail}&gt; ·{' '}
                      {new Date(detail.authoredAt * 1000).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => void copy(detail.oid)}
                    aria-label={`Copy commit ${detail.shortOid}`}
                    title={`Copy ${detail.oid}`}
                  >
                    <Copy size={11} />
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Commit actions"
                    title="Commit actions"
                    data-testid="scm-commit-actions"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      setCommitMenu({ x: rect.left - 220, y: rect.bottom + 4 })
                    }}
                  >
                    <MoreHorizontal size={11} />
                  </button>
                </div>
                {detail.body.length > 0 && detail.body !== detail.subject ? (
                  <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[10.5px] leading-relaxed text-muted-foreground">
                    {detail.body}
                  </pre>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                    {detail.shortOid}
                  </span>
                  <span className="text-muted-foreground">
                    {String(detail.files.length)} file{detail.files.length === 1 ? '' : 's'}
                  </span>
                  <span className="font-mono text-add">+{String(detail.additions)}</span>
                  <span className="font-mono text-destructive">−{String(detail.deletions)}</span>
                  {detail.truncated ? (
                    <span className="text-signal">first 5,000 files</span>
                  ) : null}
                  {detail.files.length > 0 ? (
                    <span className="ml-auto inline-flex overflow-hidden rounded border border-border">
                      <button
                        type="button"
                        className={`p-1 ${fileView === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        onClick={() => setFileView('list')}
                        aria-pressed={fileView === 'list'}
                        aria-label="Show changed files as a list"
                        title="Show changed files as a list"
                        data-testid="scm-history-files-list"
                      >
                        <List size={10} />
                      </button>
                      <button
                        type="button"
                        className={`border-l border-border p-1 ${fileView === 'tree' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        onClick={() => setFileView('tree')}
                        aria-pressed={fileView === 'tree'}
                        aria-label="Show changed files as a tree"
                        title="Show changed files as a tree"
                        data-testid="scm-history-files-tree"
                      >
                        <Folder size={10} />
                      </button>
                    </span>
                  ) : null}
                  {detail.files.length > 0 ? (
                    <button
                      type="button"
                      className="inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[9.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => setMultiOpen(true)}
                      data-testid="scm-history-open-all"
                    >
                      <Layers size={10} />
                      Open all changes
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <span className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                    Compare with
                  </span>
                  {detail.parents.length === 0 ? (
                    <span className="font-mono text-[10px] text-muted-foreground">empty tree</span>
                  ) : detail.parents.length === 1 ? (
                    <span className="font-mono text-[10px] text-foreground">
                      {detail.parents[0]!.slice(0, 7)}
                    </span>
                  ) : (
                    <select
                      className="h-6 rounded border border-border bg-background px-1 font-mono text-[10px] text-foreground"
                      value={detail.parentOid ?? ''}
                      onChange={(event) => {
                        const parent = event.target.value
                        if (parent.length > 0) void openCommit(selected, parent)
                      }}
                      aria-label="Compare commit with parent"
                      data-testid="scm-history-parent"
                    >
                      {detail.parents.map((parent) => (
                        <option key={parent} value={parent}>
                          {parent.slice(0, 7)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              <ul>
                {detail.files.length === 0 ? (
                  <li className="px-3 py-4 text-[11px] text-muted-foreground">
                    This commit changed no files.
                  </li>
                ) : fileView === 'tree' ? (
                  commitFileRows.map((row) =>
                    row.kind === 'folder' ? (
                      <li key={`folder:${row.path}`}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-1.5 border-b border-border/60 py-1.5 pr-3 text-left hover:bg-muted/50"
                          style={{ paddingLeft: `${String(12 + row.depth * 12)}px` }}
                          onClick={() => toggleFolder(row.path)}
                          aria-expanded={!row.collapsed}
                          title={row.path}
                          data-testid={`scm-history-folder-${row.path}`}
                        >
                          {row.collapsed ? (
                            <ChevronRight size={10} className="shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronDown size={10} className="shrink-0 text-muted-foreground" />
                          )}
                          {row.collapsed ? (
                            <Folder size={10} className="shrink-0 text-muted-foreground" />
                          ) : (
                            <FolderOpen size={10} className="shrink-0 text-muted-foreground" />
                          )}
                          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground">
                            {row.name}
                          </span>
                        </button>
                      </li>
                    ) : (
                      <li key={`${row.file.oldPath ?? ''}:${row.file.path}`}>
                        {renderDetailFile(row.file, row.depth)}
                      </li>
                    )
                  )
                ) : (
                  detail.files.map((entry) => (
                    <li key={`${entry.oldPath ?? ''}:${entry.path}`}>
                      {renderDetailFile(entry, 0)}
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
        </div>
      </div>
      {commitMenu !== null ? (
        <ScmContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          items={commitMenuItems()}
          ariaLabel="Commit actions"
          onClose={() => setCommitMenu(null)}
        />
      ) : null}
      {dialogKind !== null && selected !== null ? (
        <ScmCommitDialog
          kind={dialogKind}
          shortOid={selected.shortOid}
          subject={selected.subject}
          busy={actionBusy}
          error={actionError}
          onCancel={() => {
            if (!actionBusy) setDialogKind(null)
          }}
          onSubmit={(value) => void runCommitAction(value)}
        />
      ) : null}
    </div>
  )
}

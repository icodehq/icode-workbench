import { translate, getLocale } from '../../i18n/i18n-store'
import { formatDateTime } from '../../../../shared/i18n'
import { useCallback, useEffect, useState } from 'react'
import { callApi } from '../../lib/api'
import type {
  GitFileAtRevisionPayload,
  GitRevisionFileDiffPayload
} from '../../../../shared/icode-api'
import {
  GIT_EMPTY_TREE_OID,
  type GitCommitDetail,
  type GitRangeFile
} from '../../../../shared/domain/git-workspace'
import type { FileDiffPayload } from '../../../../shared/schemas/changes'
import { makeAppError } from '../../../../shared/domain/errors'
import UnifiedDiffView, { type DiffViewState } from '../UnifiedDiffView'
import MonacoDiffView from '../MonacoDiffView'
import type { HistoryGraphRow } from '../../scm/history-graph'

const LANE_COLORS = [
  'var(--icode-lane-1)',
  'var(--icode-lane-2)',
  'var(--icode-lane-3)',
  'var(--icode-lane-4)',
  'var(--icode-lane-5)',
  'var(--icode-lane-6)'
]

function laneColor(color: number): string {
  return LANE_COLORS[color % LANE_COLORS.length] ?? LANE_COLORS[0]!
}

export function relativeTime(seconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds)
  if (delta < 60) return translate('relative.justNow')
  if (delta < 3600) return translate('relative.minutesAgo', { count: Math.floor(delta / 60) })
  if (delta < 86_400) return translate('relative.hoursAgo', { count: Math.floor(delta / 3600) })
  if (delta < 86_400 * 30) return translate('relative.daysAgo', { count: Math.floor(delta / 86_400) })
  return formatDateTime(getLocale(), seconds * 1000, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

export function statusLetter(status: string): string {
  switch (status) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    default:
      return 'M'
  }
}

export function statusTone(status: string): string {
  switch (status) {
    case 'added':
      return 'text-add'
    case 'deleted':
      return 'text-destructive'
    case 'renamed':
    case 'copied':
      return 'text-info'
    default:
      return 'text-signal'
  }
}

export function LaneGraph({
  row,
  maxLane
}: {
  row: HistoryGraphRow
  maxLane: number
}): React.JSX.Element {
  const width = Math.max(14, (maxLane + 1) * 12)
  const x = (lane: number): number => lane * 12 + 6
  return (
    <svg
      width={width}
      height={30}
      className="shrink-0"
      aria-hidden="true"
      data-testid={`scm-history-lane-${row.entry.shortOid}`}
    >
      {row.lanes.map((lane) => (
        <line
          key={`lane-${String(lane)}`}
          x1={x(lane)}
          x2={x(lane)}
          y1={0}
          y2={30}
          stroke={laneColor(lane)}
          strokeWidth={1.5}
          opacity={0.5}
        />
      ))}
      {row.parentLanes
        .filter((lane) => lane !== row.lane)
        .map((lane) => (
          <path
            key={`parent-${String(lane)}`}
            d={`M ${String(x(row.lane))} 15 Q ${String(x(row.lane))} 27 ${String(x(lane))} 30`}
            fill="none"
            stroke={laneColor(lane)}
            strokeWidth={1.5}
            opacity={0.7}
          />
        ))}
      <circle
        cx={x(row.lane)}
        cy={15}
        r={row.merge ? 4 : 3.5}
        fill={laneColor(row.color)}
        stroke="var(--icode-panel)"
        strokeWidth={1.5}
      />
    </svg>
  )
}

export function fileName(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

export function refLabel(ref: string): string {
  if (ref.startsWith('tag: ')) return ref.slice(5)
  if (ref.startsWith('HEAD -> ')) return 'HEAD'
  return ref
}

export function commitFilePayload(
  sessionId: string,
  file: GitRangeFile,
  result: Extract<GitRevisionFileDiffPayload, { status: 'ok' }>
): FileDiffPayload {
  return {
    status: 'available',
    sessionId,
    path: file.path,
    oldPath: file.oldPath,
    fileStatus: file.status === 'copied' ? 'added' : file.status,
    patch: result.patch,
    truncated: result.truncated,
    truncatedReason: result.truncated ? 'bytes' : null,
    binary: result.binary,
    symlink: null,
    additions: result.additions,
    deletions: result.deletions
  }
}

/**
 * Reads both sides of a committed file for Monaco's side-by-side diff.
 *
 * An added/deleted file legitimately has no blob on one side, so an unavailable
 * read is treated as empty text for that case. Binary, too-large, or otherwise
 * unreadable sides return null and the unified patch renderer stays in charge.
 */
export async function commitFileSides(
  sessionId: string,
  commit: GitCommitDetail,
  file: GitRangeFile
): Promise<{ original: string; modified: string } | null> {
  const originalPath = file.oldPath ?? file.path
  const [originalResult, modifiedResult] = await Promise.all([
    commit.parentOid === null
      ? Promise.resolve(null)
      : callApi<GitFileAtRevisionPayload>(
          window.icode.git.fileAtRevision({
            sessionId,
            rev: commit.parentOid,
            path: originalPath
          })
        ),
    callApi<GitFileAtRevisionPayload>(
      window.icode.git.fileAtRevision({
        sessionId,
        rev: commit.oid,
        path: file.path
      })
    )
  ])
  const textOf = (
    result: Awaited<ReturnType<typeof callApi<GitFileAtRevisionPayload>>>
  ): string | null => {
    if (!result.ok) return null
    if (result.value.status !== 'ok') return null
    if (result.value.binary || result.value.tooLarge) return null
    return result.value.text
  }
  const missing = (
    result: Awaited<ReturnType<typeof callApi<GitFileAtRevisionPayload>>>
  ): boolean => result.ok && result.value.status === 'unavailable'
  const modifiedText = textOf(modifiedResult)
  if (commit.parentOid === null) {
    if (modifiedText === null && !(missing(modifiedResult) && file.status === 'deleted')) {
      return null
    }
    return { original: '', modified: modifiedText ?? '' }
  }
  const originalText = originalResult === null ? '' : textOf(originalResult)
  const originalValid =
    originalText !== null || (originalResult !== null && missing(originalResult) && file.status === 'added')
  const modifiedValid =
    modifiedText !== null || (missing(modifiedResult) && file.status === 'deleted')
  if (!originalValid || !modifiedValid) return null
  return { original: originalText ?? '', modified: modifiedText ?? '' }
}

/**
 * One lazily fetched file inside a commit's multi-diff.
 *
 * Each section owns its request so a slow or binary file cannot block the
 * rest. The unified renderer is reused; Monaco's lazy multi-diff replaces
 * this mount policy in Phase 5.
 */
export function CommitFileDiffSection({
  sessionId,
  commit,
  file
}: {
  sessionId: string
  commit: GitCommitDetail
  file: GitRangeFile
}): React.JSX.Element {
  const [state, setState] = useState<DiffViewState>({ phase: 'loading' })
  const [sides, setSides] = useState<{ original: string; modified: string } | null>(null)
  const load = useCallback(async (): Promise<void> => {
    setState({ phase: 'loading' })
    setSides(null)
    const from = commit.parentOid ?? GIT_EMPTY_TREE_OID
    const [result, loadedSides] = await Promise.all([
      callApi<GitRevisionFileDiffPayload>(
        window.icode.git.revisionFileDiff({
          sessionId,
          from,
          to: commit.oid,
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {})
        })
      ),
      commitFileSides(sessionId, commit, file)
    ])
    if (!result.ok) {
      setState({ phase: 'error', error: result.error })
      return
    }
    if (result.value.status === 'unavailable') {
      setState({
        phase: 'error',
        error: makeAppError('GIT_READ_FAILED', result.value.detail)
      })
      return
    }
    setSides(loadedSides)
    setState({ phase: 'ready', diff: commitFilePayload(sessionId, file, result.value) })
  }, [commit, file, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section
      className="overflow-hidden rounded-md border border-border bg-card"
      data-testid={`scm-multi-file-${file.path}`}
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-border px-2">
        <span className={`w-3 shrink-0 text-center font-mono text-[10px] font-semibold ${statusTone(file.status)}`}>
          {statusLetter(file.status)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground">
          {file.oldPath ? `${file.oldPath} → ` : ''}
          {file.path}
        </span>
        {file.binary ? (
          <span className="shrink-0 rounded bg-muted px-1 text-[8.5px] text-muted-foreground">
            binary
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
            +{file.additions ?? 0} −{file.deletions ?? 0}
          </span>
        )}
      </div>
      <div className="h-[360px]">
        {sides !== null ? (
          <MonacoDiffView
            path={file.path}
            original={sides.original}
            modified={sides.modified}
            fallback={
              <UnifiedDiffView
                path={file.path}
                state={state}
                onRetry={() => void load()}
                scopeLabel={`commit ${commit.shortOid}`}
              />
            }
          />
        ) : (
          <UnifiedDiffView
            path={file.path}
            state={state}
            onRetry={() => void load()}
            scopeLabel={`commit ${commit.shortOid}`}
          />
        )}
      </div>
    </section>
  )
}

/**
 * Full-pane History in the Source Control editor area.
 *
 * The list is a paginated lane graph; selecting a commit opens its detail with
 * a parent selector and first-parent file list. A file opens the existing
 * unified diff renderer fed by `git.revisionFileDiff`, so committed review does
 * not wait for Monaco.
 */

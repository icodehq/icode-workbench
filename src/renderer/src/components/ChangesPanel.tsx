import { AlertTriangle, FileDiff, GitBranch, RefreshCw } from 'lucide-react'
import type { ReviewFilePayload } from '../../../shared/schemas/review'
import type { SessionReview } from '../review/use-session-review'
import type { ReviewState } from '../review/review-state'
import { diffStateFor } from '../review/review-state'
import UnifiedDiffView from './UnifiedDiffView'
import {
  ReviewEmpty,
  ReviewError,
  ReviewLoading,
  ReviewUnavailable,
  statusGlyph,
  statusTone
} from './ReviewStates'

type Props = {
  review: SessionReview
  sessionId: string
  sessionState: string
  /** Present for isolated sessions; null for legacy/primary-checkout sessions. */
  worktreeBranch: string | null
  baselineOid: string | null
}

function countLabel(file: ReviewFilePayload): string {
  if (file.binary) return 'binary'
  if (file.additions === null || file.deletions === null) return '—'
  return `+${String(file.additions)} −${String(file.deletions)}`
}

function FileRow({
  file,
  selected,
  onSelect
}: {
  file: ReviewFilePayload
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
          selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
        }`}
        onClick={onSelect}
        aria-selected={selected}
        data-testid={`review-file-${file.path}`}
        data-status={file.status}
        data-area={file.area}
      >
        <span className={`w-3 shrink-0 font-mono text-[10px] ${statusTone(file)}`}>
          {statusGlyph(file)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px]" title={file.path}>
            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          </span>
          <span className="flex gap-1.5 text-[9px] text-muted-foreground">
            {file.binary ? <span className="text-sky-400">binary</span> : null}
            {file.symlink ? <span className="text-sky-400">symlink</span> : null}
            {file.area === 'conflicted' ? (
              <span className="text-red-400">conflict</span>
            ) : file.area === 'untracked' ? (
              <span>untracked</span>
            ) : null}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
          {countLabel(file)}
        </span>
      </button>
    </li>
  )
}

function ListBody({
  state,
  review
}: {
  state: ReviewState
  review: SessionReview
}): React.JSX.Element {
  if (state.phase === 'loading' || state.phase === 'idle') return <ReviewLoading />
  if (state.phase === 'unavailable') {
    return <ReviewUnavailable state={state} onRefresh={review.refresh} />
  }
  if (state.phase === 'error') return <ReviewError state={state} onRefresh={review.refresh} />
  if (state.phase === 'empty') return <ReviewEmpty state={state} onRefresh={review.refresh} />
  return (
    <div className="flex h-full min-h-0">
      <div className="w-[280px] shrink-0 overflow-y-auto border-r border-border px-2 py-2">
        {state.listTruncated ? (
          <p className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[9px] text-amber-200">
            Showing the first 1,000 changed files.
          </p>
        ) : null}
        <ul className="space-y-0.5">
          {state.files.map((file) => (
            <FileRow
              key={`${file.oldPath ?? ''}:${file.path}`}
              file={file}
              selected={file.path === state.selectedPath}
              onSelect={() => review.selectFile(file.path)}
            />
          ))}
        </ul>
      </div>
      <div className="min-w-0 flex-1">
        {state.selectedPath === null ? (
          <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
            Select a file to see its changes.
          </div>
        ) : (
          <UnifiedDiffView
            path={state.selectedPath}
            state={diffStateFor(state, state.selectedPath)}
            onRetry={() => review.retryDiff(state.selectedPath!)}
          />
        )}
      </div>
    </div>
  )
}

export default function ChangesPanel({
  review,
  sessionId,
  sessionState,
  worktreeBranch,
  baselineOid
}: Props): React.JSX.Element {
  const { state } = review
  const banner = state.phase === 'ready' || state.phase === 'empty'

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="changes-panel"
      data-phase={state.phase}
      data-session-id={sessionId}
      data-session-state={sessionState}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <FileDiff size={12} className="text-muted-foreground" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Changes
        </span>
        {worktreeBranch ? (
          <span className="inline-flex items-center gap-1 font-mono text-[9px] text-muted-foreground">
            <GitBranch size={9} />
            {worktreeBranch}
          </span>
        ) : null}
        {baselineOid ? (
          <span className="font-mono text-[9px] text-muted-foreground">
            since {baselineOid.slice(0, 10)}
          </span>
        ) : null}
        {banner && state.files.length > 0 ? (
          <span className="text-[9px] text-muted-foreground" data-testid="review-file-count">
            {state.files.length} file{state.files.length === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[9px] text-muted-foreground" title="This view never modifies files">
            read-only
          </span>
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[10px] hover:bg-muted disabled:opacity-40"
            onClick={review.refresh}
            disabled={state.phase === 'loading'}
            data-testid="review-refresh"
          >
            <RefreshCw size={10} className={state.phase === 'loading' ? 'animate-spin' : ''} />
            Refresh
          </button>
        </span>
      </div>
      {state.error && state.phase !== 'error' ? (
        <div className="flex items-center gap-1.5 border-b border-destructive/40 bg-destructive/10 px-3 py-1 text-[10px] text-red-200">
          <AlertTriangle size={11} />
          {state.error.message}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ListBody state={state} review={review} />
      </div>
    </div>
  )
}

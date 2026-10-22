import { AlertTriangle, FileDiff, FileWarning } from 'lucide-react'
import type { ReviewFilePayload, ReviewUnavailableReason } from '../../../shared/schemas/review'
import type { ReviewState } from '../review/review-state'

type Props = {
  state: ReviewState
  onRefresh: () => void
}

const UNAVAILABLE_TITLE: Record<ReviewUnavailableReason, string> = {
  'primary-checkout': 'No review for this session',
  'worktree-missing': 'The session worktree is missing',
  'worktree-inconsistent': 'The worktree cannot be verified',
  'worktree-failed': 'The session worktree failed to start',
  'invalid-baseline': 'The session baseline is unavailable'
}

const UNAVAILABLE_BODY: Record<ReviewUnavailableReason, string> = {
  'primary-checkout':
    'This session runs in the primary checkout, so its changes cannot be separated from work that did not come from this session. ADE will not invent a baseline.',
  'worktree-missing':
    'The directory is gone, so there is nothing to read. Re-create it from the retained branch, then reopen this view.',
  'worktree-inconsistent':
    'Git does not recognise this directory as the session worktree. Nothing is read until that is resolved.',
  'worktree-failed': 'Worktree creation failed, so the session never had a baseline to review.',
  'invalid-baseline':
    'The commit this session started from is no longer available, so no diff can be computed.'
}

export function ReviewUnavailable({ state }: Props): React.JSX.Element {
  const reason = state.unavailable?.reason ?? 'invalid-baseline'
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <FileWarning size={15} className="text-amber-400" />
          <h2 className="text-[13px] font-semibold" data-testid="review-unavailable-reason">
            {UNAVAILABLE_TITLE[reason]}
          </h2>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {UNAVAILABLE_BODY[reason]}
        </p>
        {state.unavailable?.detail ? (
          <p className="mt-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            {state.unavailable.detail}
          </p>
        ) : null}
        {reason === 'primary-checkout' ? null : (
          <p className="mt-3 text-[10px] text-muted-foreground">
            Open the Terminal view for this session to continue working.
          </p>
        )}
      </div>
    </div>
  )
}

export function ReviewEmpty({ state, onRefresh }: Props): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 text-center">
        <FileDiff size={18} className="mx-auto text-muted-foreground" />
        <h2 className="mt-2 text-[13px] font-semibold" data-testid="review-empty">
          No changes since this session started
        </h2>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Changes the agent commits, stages, or leaves untracked will appear here.
        </p>
        {state.baselineOid ? (
          <p className="mt-2 font-mono text-[9px] text-muted-foreground">
            baseline {state.baselineOid.slice(0, 12)}
          </p>
        ) : null}
        <button
          type="button"
          className="mt-4 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
          onClick={onRefresh}
          data-testid="review-refresh-empty"
        >
          Refresh
        </button>
      </div>
    </div>
  )
}

export function ReviewError({ state, onRefresh }: Props): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-destructive/40 bg-card p-5">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-destructive">
          <AlertTriangle size={15} />
          <span data-testid="review-error">The session changes could not be read</span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {state.error?.message ?? 'Git did not return a usable result.'}
        </p>
        {state.error?.detail ? (
          <p className="mt-2 break-words rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
            {state.error.detail}
          </p>
        ) : null}
        <button
          type="button"
          className="mt-4 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
          onClick={onRefresh}
          data-testid="review-retry"
        >
          Retry
        </button>
      </div>
    </div>
  )
}

export function ReviewLoading(): React.JSX.Element {
  return (
    <div className="space-y-2 p-4" data-testid="review-loading">
      {[0, 1, 2, 3, 4].map((row) => (
        <div
          key={row}
          className="h-8 animate-pulse rounded-md border border-border bg-card/60"
          style={{ opacity: 1 - row * 0.15 }}
        />
      ))}
    </div>
  )
}

export function statusGlyph(file: ReviewFilePayload): string {
  switch (file.status) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    default:
      return 'M'
  }
}

export function statusTone(file: ReviewFilePayload): string {
  if (file.area === 'conflicted') return 'text-red-400'
  switch (file.status) {
    case 'added':
      return 'text-emerald-400'
    case 'deleted':
      return 'text-red-400'
    case 'renamed':
      return 'text-sky-400'
    default:
      return 'text-amber-400'
  }
}

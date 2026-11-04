import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import type { ReviewDiffPayload } from '../../../shared/schemas/review'
import type { LineComment } from '../review/drafts'
import { lineSelectionKey } from '../review/hunk-patch'
import { collapseContext, parseUnifiedDiff, type DiffHunk } from '../review/parse-unified-diff'

export type DiffViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; diff: ReviewDiffPayload; stale?: boolean }
  | { phase: 'error'; error: AppError }

export type LineAction = {
  mode: 'stage' | 'unstage'
  /** Index of the hunk whose selected lines are applying. */
  pending: number | null
  onRun: (hunkIndex: number, selected: ReadonlySet<string>) => void
  /** Optional destructive worktree action for the selected lines. */
  discard?: {
    pending: number | null
    onRun: (hunkIndex: number, selected: ReadonlySet<string>) => void
  }
}

export type HunkAction = {
  mode: 'stage' | 'unstage'
  /** Index of the hunk currently applying, so only that button is disabled. */
  pending: number | null
  onRun: (hunkIndex: number) => void
  /** Optional destructive worktree action, confirmed inline before applying. */
  discard?: {
    pending: number | null
    /** Index awaiting confirmation, or null. */
    confirm: number | null
    onAsk: (hunkIndex: number) => void
    onCancel: () => void
    onRun: (hunkIndex: number) => void
  }
  /** Optional per-line selection and apply action. */
  lineAction?: LineAction
}

type Props = {
  path: string
  state: DiffViewState
  onRetry: () => void
  /** Names the comparison: staged, unstaged, untracked or conflict. */
  scopeLabel?: string
  /** Line comments already attached to this file. */
  comments?: LineComment[]
  onAddComment?: (comment: Omit<LineComment, 'id'>) => void
  onRemoveComment?: (id: string) => void
  /** Extra header controls, e.g. the working-tree split/unified toggle. */
  headerActions?: React.ReactNode
  /** A non-blocking explanation shown below the header. */
  notice?: string
  /** Stage/unstage action rendered on every hunk header. */
  hunkAction?: HunkAction
}

/** `LineComment` lives with the draft store so the panel can keep it across mounts. */
export type { LineComment } from '../review/drafts'

/**
 * A truncated diff can still contain hundreds of thousands of lines. Rendering
 * them all freezes the window, so only the first slice is mounted; the banner
 * above already states that the change is incomplete.
 */
const MAX_RENDERED_LINES = 1500

function HunkView({
  hunk,
  index,
  path,
  comments,
  onAddComment,
  onRemoveComment,
  hunkAction
}: {
  hunk: DiffHunk
  index: number
  path: string
  comments: LineComment[]
  onAddComment?: (comment: Omit<LineComment, 'id'>) => void
  onRemoveComment?: (id: string) => void
  hunkAction?: HunkAction
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [composing, setComposing] = useState<{ side: 'new' | 'old'; line: number } | null>(null)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [lineConfirm, setLineConfirm] = useState(false)
  const rows = useMemo(() => collapseContext(hunk, 2, index), [hunk, index])
  const lineAction = hunkAction?.lineAction

  useEffect(() => {
    setSelected(new Set())
    setLineConfirm(false)
  }, [hunk])

  useEffect(() => {
    setLineConfirm(false)
  }, [selected])

  const toggleLine = (side: 'old' | 'new', line: number): void => {
    const key = lineSelectionKey(side, line)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const composer = (side: 'new' | 'old', line: number): React.JSX.Element | null => {
    if (composing === null || composing.side !== side || composing.line !== line) return null
    return (
      <div className="ml-[92px] mr-2 my-1 rounded border border-border bg-muted/30 p-1.5" data-testid="line-comment-composer">
        <textarea
          autoFocus
          value={draft}
          placeholder={`Comment on ${path}:${line}`}
          className="h-12 w-full resize-none bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="line-comment-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setComposing(null)
              setDraft('')
            }
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              const text = draft.trim()
              if (text.length === 0) return
              onAddComment?.({ path, side, line, text })
              setComposing(null)
              setDraft('')
            }
          }}
        />
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted"
            data-testid="line-comment-add"
            onClick={() => {
              const text = draft.trim()
              if (text.length === 0) return
              onAddComment?.({ path, side, line, text })
              setComposing(null)
              setDraft('')
            }}
          >
            Add note
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              setComposing(null)
              setDraft('')
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  const anchored = (side: 'new' | 'old', line: number): React.JSX.Element[] =>
    comments
      .filter((comment) => comment.side === side && comment.line === line)
      .map((comment) => (
        <div
          key={comment.id}
          className="ml-[92px] mr-2 my-0.5 flex items-start gap-2 rounded border border-add/30 bg-add-weak px-2 py-1"
          data-testid={`line-comment-${comment.side}-${String(comment.line)}`}
        >
          <span className="font-mono text-[9px] text-add">
            {comment.side === 'old' ? 'removed' : ''} line {comment.line}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap text-[11px] text-foreground">{comment.text}</span>
          <button
            type="button"
            className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => onRemoveComment?.(comment.id)}
            data-testid={`line-comment-remove-${comment.side}-${String(comment.line)}`}
          >
            remove
          </button>
        </div>
      ))

  return (
    <div data-testid="diff-hunk">
      <div className="sticky-none flex items-center gap-2 bg-muted/40 px-3 py-1 font-mono text-[10.5px] text-muted-foreground">
        <span className="min-w-0 truncate">{hunk.header}</span>
        {hunkAction ? (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {lineAction && selected.size > 0 ? (
              <>
                <button
                  type="button"
                  className="rounded border border-signal-line bg-signal-weak px-1.5 py-0.5 font-sans text-[9.5px] text-signal hover:brightness-95 disabled:opacity-50"
                  disabled={lineAction.pending === index}
                  data-testid={`hunk-lines-${lineAction.mode}-${String(index)}`}
                  title={`${lineAction.mode === 'stage' ? 'Stage' : 'Unstage'} the selected changed lines`}
                  onClick={() => lineAction.onRun(index, new Set(selected))}
                >
                  {lineAction.pending === index
                    ? 'Applying…'
                    : `${lineAction.mode === 'stage' ? 'Stage' : 'Unstage'} ${String(selected.size)} Line${selected.size === 1 ? '' : 's'}`}
                </button>
                {lineAction.discard ? (
                  lineConfirm ? (
                    <>
                      <span className="font-sans text-[9px] text-destructive">
                        Discard {String(selected.size)} line{selected.size === 1 ? '' : 's'}?
                      </span>
                      <button
                        type="button"
                        className="rounded border border-destructive bg-destructive px-1.5 py-0.5 font-sans text-[9.5px] text-white hover:opacity-90 disabled:opacity-50"
                        disabled={lineAction.discard.pending === index}
                        data-testid={`hunk-lines-discard-yes-${String(index)}`}
                        onClick={() => {
                          setLineConfirm(false)
                          lineAction.discard?.onRun(index, new Set(selected))
                        }}
                      >
                        {lineAction.discard.pending === index ? 'Discarding…' : 'Discard'}
                      </button>
                      <button
                        type="button"
                        className="rounded px-1 py-0.5 font-sans text-[9px] text-muted-foreground hover:text-foreground"
                        data-testid={`hunk-lines-discard-cancel-${String(index)}`}
                        onClick={() => setLineConfirm(false)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="rounded border border-destructive/40 bg-card px-1.5 py-0.5 font-sans text-[9.5px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      disabled={lineAction.discard.pending === index}
                      data-testid={`hunk-lines-discard-${String(index)}`}
                      title="Discard the selected changed lines from the worktree"
                      onClick={() => setLineConfirm(true)}
                    >
                      Discard {String(selected.size)} Line{selected.size === 1 ? '' : 's'}
                    </button>
                  )
                ) : null}
                <button
                  type="button"
                  className="rounded px-1 py-0.5 font-sans text-[9px] text-muted-foreground hover:text-foreground"
                  data-testid={`hunk-lines-clear-${String(index)}`}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="rounded border border-border bg-card px-1.5 py-0.5 font-sans text-[9.5px] text-foreground hover:bg-muted disabled:opacity-50"
              disabled={hunkAction.pending === index}
              data-testid={`hunk-${hunkAction.mode}-${String(index)}`}
              title={
                hunkAction.mode === 'stage'
                  ? 'Stage this hunk'
                  : 'Unstage this hunk, leaving the worktree unchanged'
              }
              onClick={() => hunkAction.onRun(index)}
            >
              {hunkAction.pending === index
                ? 'Applying…'
                : hunkAction.mode === 'stage'
                  ? 'Stage Hunk'
                  : 'Unstage Hunk'}
            </button>
            {hunkAction.discard ? (
              hunkAction.discard.confirm === index ? (
                <>
                  <span className="font-sans text-[9px] text-destructive">Discard hunk?</span>
                  <button
                    type="button"
                    className="rounded border border-destructive bg-destructive px-1.5 py-0.5 font-sans text-[9.5px] text-white hover:opacity-90 disabled:opacity-50"
                    disabled={hunkAction.discard.pending === index}
                    data-testid={`hunk-discard-yes-${String(index)}`}
                    onClick={() => hunkAction.discard?.onRun(index)}
                  >
                    {hunkAction.discard.pending === index ? 'Discarding…' : 'Discard'}
                  </button>
                  <button
                    type="button"
                    className="rounded px-1 py-0.5 font-sans text-[9.5px] text-muted-foreground hover:text-foreground"
                    data-testid={`hunk-discard-cancel-${String(index)}`}
                    onClick={() => hunkAction.discard?.onCancel()}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="rounded border border-destructive/40 bg-card px-1.5 py-0.5 font-sans text-[9.5px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  disabled={hunkAction.discard.pending === index}
                  data-testid={`hunk-discard-${String(index)}`}
                  title="Discard this hunk from the worktree"
                  onClick={() => hunkAction.discard?.onAsk(index)}
                >
                  {hunkAction.discard.pending === index ? 'Discarding…' : 'Discard Hunk'}
                </button>
              )
            ) : null}
          </span>
        ) : null}
      </div>
      {rows.map((row, rowIndex) => {
        if (row.kind === 'line') {
          const line = row.line
          const tone =
            line.kind === 'add'
              ? 'bg-add-weak text-add'
              : line.kind === 'remove'
                ? 'bg-destructive/10 text-destructive'
                : line.kind === 'meta'
                  ? 'text-muted-foreground italic'
                  : 'text-foreground/90'
          const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
          // A removal only exists in the pre-image, so its note is addressed to
          // the old line; everything else is addressed to the new one.
          const anchorSide: 'new' | 'old' = line.kind === 'remove' ? 'old' : 'new'
          const anchorLine = anchorSide === 'new' ? line.newLine : line.oldLine
          const canComment = onAddComment !== undefined && anchorLine !== null && line.kind !== 'meta'
          const selectable = lineAction !== undefined && (line.kind === 'add' || line.kind === 'remove')
          const selectSide: 'old' | 'new' = line.kind === 'remove' ? 'old' : 'new'
          const selectLine = selectSide === 'old' ? line.oldLine : line.newLine
          const openComposer = (): void => {
            if (!canComment || anchorLine === null) return
            setDraft('')
            setComposing({ side: anchorSide, line: anchorLine })
          }
          return (
            <div key={`${String(index)}-${String(rowIndex)}`}>
              <div
                className={`group flex ${tone} ${canComment ? 'cursor-pointer hover:bg-muted/30' : ''}`}
                onClick={canComment ? openComposer : undefined}
                data-testid={canComment ? `diff-line-${anchorSide}-${String(anchorLine)}` : undefined}
                title={canComment ? `Comment on line ${String(anchorLine)}` : undefined}
              >
                {lineAction ? (
                  <span
                    className="flex w-4 shrink-0 select-none items-center justify-center"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {selectable && selectLine !== null ? (
                      <input
                        type="checkbox"
                        className="h-2.5 w-2.5 cursor-pointer accent-signal"
                        checked={selected.has(lineSelectionKey(selectSide, selectLine))}
                        title={`Select ${selectSide === 'old' ? 'removed' : 'added'} line ${String(selectLine)}`}
                        aria-label={`Select ${selectSide === 'old' ? 'removed' : 'added'} line ${String(selectLine)}`}
                        data-testid={`diff-select-${selectSide}-${String(selectLine)}`}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => toggleLine(selectSide, selectLine)}
                      />
                    ) : null}
                  </span>
                ) : null}
                <span className="w-10 shrink-0 select-none border-r border-border/50 px-1 text-right font-mono text-[10.5px] text-muted-foreground">
                  {line.oldLine ?? ''}
                </span>
                <span className="w-10 shrink-0 select-none border-r border-border/50 px-1 text-right font-mono text-[10.5px] text-muted-foreground">
                  {line.newLine ?? ''}
                </span>
                <span className="w-3 shrink-0 select-none text-center font-mono text-[10px] opacity-60">
                  {line.kind === 'meta' ? ' ' : marker}
                </span>
                <span className="whitespace-pre pr-3 font-mono text-[11.5px] leading-[1.6]">
                  {line.text}
                  {line.crlf ? <span className="ml-1 text-[8px] text-muted-foreground">CRLF</span> : null}
                </span>
                {canComment ? (
                  <span className="ml-auto shrink-0 select-none pr-2 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">
                    +
                  </span>
                ) : null}
              </div>
              {anchorLine !== null ? anchored(anchorSide, anchorLine) : null}
              {anchorLine !== null ? composer(anchorSide, anchorLine) : null}
            </div>
          )
        }
        const isOpen = expanded.has(row.id)
        return (
          <div key={row.id}>
            <button
              type="button"
              className="flex w-full items-center gap-1 border-y border-border/40 bg-muted/20 px-3 py-1 text-left font-mono text-[10.5px] text-muted-foreground hover:bg-muted/40"
              onClick={() =>
                setExpanded((previous) => {
                  const next = new Set(previous)
                  if (next.has(row.id)) next.delete(row.id)
                  else next.add(row.id)
                  return next
                })
              }
              data-testid="diff-expand-context"
            >
              {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {isOpen ? 'Hide' : 'Show'} {row.count} unchanged line{row.count === 1 ? '' : 's'}
            </button>
            {isOpen
              ? row.lines.map((line, lineIndex) => (
                  <div
                    key={`${row.id}-${String(lineIndex)}`}
                    className="flex text-foreground/70"
                  >
                    <span className="w-10 shrink-0 border-r border-border/50 px-1 text-right font-mono text-[10.5px] text-muted-foreground">
                      {line.oldLine ?? ''}
                    </span>
                    <span className="w-10 shrink-0 border-r border-border/50 px-1 text-right font-mono text-[10.5px] text-muted-foreground">
                      {line.newLine ?? ''}
                    </span>
                    <span className="w-3 shrink-0" />
                    <span className="whitespace-pre pr-3 font-mono text-[11.5px] leading-[1.6]">
                      {line.text}
                    </span>
                  </div>
                ))
              : null}
          </div>
        )
      })}
    </div>
  )
}

export default function UnifiedDiffView({
  path,
  state,
  onRetry,
  scopeLabel,
  comments = [],
  onAddComment,
  onRemoveComment,
  headerActions,
  notice,
  hunkAction
}: Props): React.JSX.Element {
  if (state.phase === 'loading' || state.phase === 'idle') {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
        Loading diff…
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-md border border-destructive/40 bg-card p-4">
          <p className="text-[12px] font-medium text-destructive">The diff could not be read</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{state.error.message}</p>
          {state.error.detail ? (
            <p className="mt-1 break-words font-mono text-[10.5px] text-muted-foreground">
              {state.error.detail}
            </p>
          ) : null}
          <button
            type="button"
            className="mt-3 rounded-md border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted"
            onClick={onRetry}
            data-testid="review-diff-retry"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }
  return (
    <DiffBody
      path={path}
      diff={state.diff}
      stale={state.stale === true}
      scopeLabel={scopeLabel}
      comments={comments}
      onAddComment={onAddComment}
      onRemoveComment={onRemoveComment}
      headerActions={headerActions}
      notice={notice}
      hunkAction={hunkAction}
    />
  )
}

/**
 * Shared header for the unified and split working-tree diff renderers.
 *
 * Keeping one header means the path, scope, counts and layout toggle read the
 * same in both views and the smoke's selectors survive a view switch.
 */
export function DiffHeader({
  diff,
  stale,
  scopeLabel,
  headerActions,
  notice
}: {
  diff: ReviewDiffPayload
  stale: boolean
  scopeLabel?: string
  headerActions?: React.ReactNode
  notice?: string
}): React.JSX.Element {
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate font-mono text-[11px] text-foreground/90">
          {diff.oldPath ? `${diff.oldPath} → ${diff.path}` : diff.path}
        </span>
        <span className="rounded-sm border border-border px-1 text-[9px] uppercase text-muted-foreground">
          {diff.fileStatus}
        </span>
        {scopeLabel ? (
          <span
            className="rounded-sm border border-signal-line bg-signal-weak px-1 text-[9px] uppercase text-signal"
            data-testid="review-diff-scope"
          >
            {scopeLabel}
          </span>
        ) : null}
        {stale ? (
          <span
            className="shrink-0 text-[10px] text-muted-foreground"
            data-testid="review-diff-updating"
          >
            updating…
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">
          {diff.additions === null ? '—' : `+${String(diff.additions)}`}{' '}
          {diff.deletions === null ? '' : `−${String(diff.deletions)}`}
        </span>
        {headerActions ? <span className="flex shrink-0 items-center gap-1">{headerActions}</span> : null}
      </div>

      {notice ? (
        <div
          className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground"
          data-testid="review-diff-notice"
        >
          {notice}
        </div>
      ) : null}
    </>
  )
}

export function DiffBody({
  path,
  diff,
  stale,
  scopeLabel,
  comments,
  onAddComment,
  onRemoveComment,
  headerActions,
  notice,
  showHeader = true,
  hunkAction
}: {
  path: string
  diff: ReviewDiffPayload
  stale: boolean
  scopeLabel?: string
  comments: LineComment[]
  onAddComment?: (comment: Omit<LineComment, 'id'>) => void
  onRemoveComment?: (id: string) => void
  headerActions?: React.ReactNode
  notice?: string
  /** False when a parent already rendered the shared header, e.g. in a split view. */
  showHeader?: boolean
  hunkAction?: HunkAction
}): React.JSX.Element {
  const parsed = useMemo(() => parseUnifiedDiff(diff.patch), [diff.patch])
  const totalLines = parsed.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  const omitted = Math.max(0, totalLines - MAX_RENDERED_LINES)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={`review-diff-${path}`}>
      {showHeader ? (
        <DiffHeader
          diff={diff}
          stale={stale}
          scopeLabel={scopeLabel}
          headerActions={headerActions}
          notice={notice}
        />
      ) : null}

      {diff.truncated ? (
        <div
          className="shrink-0 border-b border-signal-line bg-signal-weak px-3 py-1.5 text-[10px] text-signal"
          data-testid="review-diff-truncated"
        >
          This diff is incomplete: Git output exceeded the {diff.truncatedReason === 'timeout' ? 'time limit' : '2 MiB view limit'}.
          Open the session terminal if you need the full change.
        </div>
      ) : null}

      {diff.symlink === true ? (
        <div className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
          This entry is a symbolic link. The diff shows the link target, never the target file's contents.
        </div>
      ) : null}

      {diff.binary ? (
        <div className="flex flex-1 items-center justify-center p-6" data-testid="review-diff-binary">
          <div className="text-center">
            <p className="text-[12px] font-medium">Binary file</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Git cannot show a text diff for this file. Nothing else is read.
            </p>
          </div>
        </div>
      ) : parsed.hunks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-[11px] text-muted-foreground">
          Git returned no textual changes for this file.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto font-mono" data-testid="review-diff-body">
          {(() => {
            let remaining = MAX_RENDERED_LINES
            const rendered: React.JSX.Element[] = []
            for (const [index, hunk] of parsed.hunks.entries()) {
              if (remaining <= 0) break
              const visibleHunk =
                hunk.lines.length <= remaining
                  ? hunk
                  : { ...hunk, lines: hunk.lines.slice(0, remaining) }
              remaining -= visibleHunk.lines.length
              rendered.push(
                <HunkView
                  key={`${String(index)}-${hunk.header}`}
                  hunk={visibleHunk}
                  index={index}
                  path={path}
                  comments={comments}
                  onAddComment={onAddComment}
                  onRemoveComment={onRemoveComment}
                  hunkAction={hunkAction}
                />
              )
            }
            return rendered
          })()}
          {omitted > 0 ? (
            <div
              className="border-t border-border bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground"
              data-testid="review-diff-render-cap"
            >
              Showing the first {MAX_RENDERED_LINES.toLocaleString()} of {totalLines.toLocaleString()}{' '}
              lines. Open the session terminal to inspect the rest.
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

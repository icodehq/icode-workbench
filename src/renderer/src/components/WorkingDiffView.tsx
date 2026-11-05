import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type {
  FileContentPayload,
  GitFileAtRevisionPayload,
  GitIndexFilePayload
} from '../../../shared/icode-api'
import { callApi } from '../lib/api'
import type { FileDiffPayload } from '../../../shared/schemas/changes'
import type { LineComment } from '../review/drafts'
import { buildLinePatch, hunkPatch } from '../review/hunk-patch'
import type { WorkingTreeEntry } from '../review/working-tree'
import MergeEditor from './MergeEditor'
import MonacoDiffView from './MonacoDiffView'
import UnifiedDiffView, {
  DiffBody,
  DiffHeader,
  type DiffViewState,
  type HunkAction
} from './UnifiedDiffView'

export type WorkingDiffMode = 'sideBySide' | 'inline'

type Props = {
  sessionId: string
  entry: WorkingTreeEntry
  state: DiffViewState
  scopeLabel: string
  mode: WorkingDiffMode
  onModeChange: (mode: WorkingDiffMode) => void
  onRetry: () => void
  comments: LineComment[]
  onAddComment: (comment: Omit<LineComment, 'id'>) => void
  onRemoveComment: (id: string) => void
  /** Applies one hunk of this file to the index. */
  onApplyHunk?: (
    patch: string,
    mode: 'stage' | 'unstage' | 'discard'
  ) => Promise<{ ok: boolean; message?: string }>
  /** Writes and stages a resolved conflict. */
  onResolveConflict?: (text: string) => Promise<{ ok: boolean; message?: string }>
}

type SideRead = { ok: true; text: string } | { ok: false; error: string }

type SidesState =
  | { phase: 'loading' }
  | { phase: 'ready'; diff: FileDiffPayload; original: string; modified: string }
  | { phase: 'error'; diff: FileDiffPayload; reason: string }

async function readRevision(
  sessionId: string,
  rev: string,
  path: string,
  allowMissing: boolean
): Promise<SideRead> {
  const result = await callApi<GitFileAtRevisionPayload>(
    window.icode.git.fileAtRevision({ sessionId, rev, path })
  )
  if (!result.ok) return { ok: false, error: result.error.message }
  const value = result.value
  if (value.status !== 'ok') {
    return allowMissing
      ? { ok: true, text: '' }
      : { ok: false, error: value.detail }
  }
  if (value.binary) return { ok: false, error: 'Binary content cannot be shown side by side.' }
  if (value.tooLarge) return { ok: false, error: 'This file is too large for a side-by-side view.' }
  return { ok: true, text: value.text }
}

async function readIndex(
  sessionId: string,
  path: string,
  allowMissing: boolean
): Promise<SideRead> {
  const result = await callApi<GitIndexFilePayload>(
    window.icode.git.indexFile({ sessionId, path })
  )
  if (!result.ok) return { ok: false, error: result.error.message }
  const value = result.value
  if (value.status !== 'ok') {
    return allowMissing ? { ok: true, text: '' } : { ok: false, error: value.detail }
  }
  if (value.binary) return { ok: false, error: 'Binary content cannot be shown side by side.' }
  if (value.tooLarge) return { ok: false, error: 'This file is too large for a side-by-side view.' }
  return { ok: true, text: value.text }
}

async function readWorktree(
  sessionId: string,
  path: string,
  allowMissing: boolean
): Promise<SideRead> {
  const result = await callApi<FileContentPayload>(window.icode.files.read({ sessionId, path }))
  if (!result.ok) return { ok: false, error: result.error.message }
  const value = result.value
  if (value.status !== 'ok') {
    if (allowMissing && value.reason === 'not-found') return { ok: true, text: '' }
    return { ok: false, error: value.detail }
  }
  if (value.binary) return { ok: false, error: 'Binary content cannot be shown side by side.' }
  if (value.tooLarge) return { ok: false, error: 'This file is too large for a side-by-side view.' }
  return { ok: true, text: value.text }
}

function LayoutToggle({
  mode,
  onChange
}: {
  mode: WorkingDiffMode
  onChange: (mode: WorkingDiffMode) => void
}): React.JSX.Element {
  const base =
    'px-1.5 py-0.5 text-[9.5px] font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-signal'
  return (
    <span
      role="group"
      aria-label="Diff layout"
      className="inline-flex overflow-hidden rounded-sm border border-border bg-card"
    >
      <button
        type="button"
        className={`${base} ${
          mode === 'sideBySide'
            ? 'bg-signal-weak text-signal'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
        aria-pressed={mode === 'sideBySide'}
        title="Show both sides side by side; line notes use the Unified view"
        data-testid="diff-view-split"
        onClick={() => onChange('sideBySide')}
      >
        Split
      </button>
      <button
        type="button"
        className={`${base} border-l border-border ${
          mode === 'inline'
            ? 'bg-signal-weak text-signal'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
        aria-pressed={mode === 'inline'}
        title="Show one unified diff with line notes"
        data-testid="diff-view-unified"
        onClick={() => onChange('inline')}
      >
        Unified
      </button>
    </span>
  )
}

/**
 * The working-tree diff, in either a read-only Monaco split or the unified
 * renderer.
 *
 * The unified renderer is the only one that can anchor review notes, so it is
 * never removed: it is the default fallback, and a split view with existing
 * notes says where they went. Both sides are complete file texts fetched from
 * the index and worktree rather than reconstructed from patch hunks.
 */
export default function WorkingDiffView({
  sessionId,
  entry,
  state,
  scopeLabel,
  mode,
  onModeChange,
  onRetry,
  comments,
  onAddComment,
  onRemoveComment,
  onApplyHunk,
  onResolveConflict
}: Props): React.JSX.Element {
  const { area, entry: resource } = entry
  const path = resource.path
  const oldPath = resource.oldPath ?? resource.path
  const status = resource.status
  const diff = state.phase === 'ready' ? state.diff : null
  // A conflict's value is its markers, which live in the unified text and are
  // not rendered by Monaco's side-by-side canvas. The merge editor will own
  // this entry later; until then, do not hide the markers behind Split.
  const splitEligible =
    diff !== null &&
    area !== 'conflicts' &&
    !diff.binary &&
    diff.truncated !== true &&
    diff.symlink !== true
  const [sides, setSides] = useState<SidesState>({ phase: 'loading' })
  const [conflictMode, setConflictMode] = useState<'merge' | 'diff'>('merge')
  const [hunkPending, setHunkPending] = useState<number | null>(null)
  const [linePending, setLinePending] = useState<number | null>(null)
  const [lineDiscardPending, setLineDiscardPending] = useState<number | null>(null)
  const [discardPending, setDiscardPending] = useState<number | null>(null)
  const [discardConfirm, setDiscardConfirm] = useState<number | null>(null)
  const [hunkError, setHunkError] = useState<string | null>(null)

  useEffect(() => {
    setHunkError(null)
    setHunkPending(null)
    setLinePending(null)
    setLineDiscardPending(null)
    setDiscardPending(null)
    setDiscardConfirm(null)
  }, [diff])

  useEffect(() => {
    setConflictMode('merge')
  }, [path])

  useEffect(() => {
    if (mode !== 'sideBySide' || diff === null || !splitEligible) return
    let cancelled = false
    setSides({ phase: 'loading' })
    void (async (): Promise<void> => {
      const originalRead =
        area === 'untracked'
          ? Promise.resolve<SideRead>({ ok: true, text: '' })
          : area === 'staged'
            ? readRevision(sessionId, 'HEAD', oldPath, status === 'added')
            : readIndex(sessionId, oldPath, false)
      const modifiedRead =
        status === 'deleted'
          ? Promise.resolve<SideRead>({ ok: true, text: '' })
          : area === 'staged'
            ? readIndex(sessionId, path, status === 'added')
            : readWorktree(sessionId, path, false)
      const [original, modified] = await Promise.all([originalRead, modifiedRead])
      if (cancelled) return
      if (!original.ok) {
        setSides({ phase: 'error', diff, reason: original.error })
        return
      }
      if (!modified.ok) {
        setSides({ phase: 'error', diff, reason: modified.error })
        return
      }
      setSides({ phase: 'ready', diff, original: original.text, modified: modified.text })
    })()
    return () => {
      cancelled = true
    }
  }, [area, diff, mode, oldPath, path, sessionId, splitEligible, status])

  const toggle = useMemo(
    () => <LayoutToggle mode={mode} onChange={onModeChange} />,
    [mode, onModeChange]
  )

  const hunkMode: 'stage' | 'unstage' | null =
    area === 'staged'
      ? 'unstage'
      : area === 'unstaged' || area === 'untracked'
        ? 'stage'
        : null
  const statusAllowsHunks =
    status === 'modified' || status === 'added' || status === 'untracked'
  const hunkEligible =
    diff !== null &&
    hunkMode !== null &&
    statusAllowsHunks &&
    onApplyHunk !== undefined &&
    !diff.binary &&
    diff.truncated !== true &&
    diff.symlink !== true

  const runHunk = async (
    index: number,
    actionMode: 'stage' | 'unstage' | 'discard'
  ): Promise<void> => {
    if (diff === null || onApplyHunk === undefined) return
    const patch = hunkPatch(diff.patch, index)
    if (patch === null) {
      setHunkError('That hunk is no longer in the diff.')
      return
    }
    setHunkError(null)
    setDiscardConfirm(null)
    if (actionMode === 'discard') setDiscardPending(index)
    else setHunkPending(index)
    try {
      const result = await onApplyHunk(patch, actionMode)
      if (!result.ok) setHunkError(result.message ?? 'Git did not apply that hunk.')
    } finally {
      if (actionMode === 'discard') setDiscardPending(null)
      else setHunkPending(null)
    }
  }

  const runLines = async (
    index: number,
    selected: ReadonlySet<string>,
    actionMode: 'stage' | 'unstage' | 'discard'
  ): Promise<void> => {
    if (diff === null || onApplyHunk === undefined) return
    const built = buildLinePatch(
      diff.patch,
      index,
      selected,
      actionMode === 'stage' ? 'forward' : 'reverse'
    )
    if (built.status === 'error') {
      setHunkError(built.error)
      return
    }
    setHunkError(null)
    if (actionMode === 'discard') setLineDiscardPending(index)
    else setLinePending(index)
    try {
      const result = await onApplyHunk(built.patch, actionMode)
      if (!result.ok) setHunkError(result.message ?? 'Git did not apply those lines.')
    } finally {
      if (actionMode === 'discard') setLineDiscardPending(null)
      else setLinePending(null)
    }
  }

  const canDiscardHunk =
    hunkMode === 'stage' && area === 'unstaged' && status === 'modified'
  const hunkAction: HunkAction | undefined = hunkEligible
    ? {
        mode: hunkMode,
        pending: hunkPending,
        onRun: (index) => void runHunk(index, hunkMode),
        lineAction: {
          mode: hunkMode,
          pending: linePending,
          onRun: (index, selected) => void runLines(index, selected, hunkMode),
          ...(canDiscardHunk
            ? {
                discard: {
                  pending: lineDiscardPending,
                  onRun: (index: number, selected: ReadonlySet<string>) =>
                    void runLines(index, selected, 'discard')
                }
              }
            : {})
        },
        ...(canDiscardHunk
          ? {
              discard: {
                pending: discardPending,
                confirm: discardConfirm,
                onAsk: (index: number) => setDiscardConfirm(index),
                onCancel: () => setDiscardConfirm(null),
                onRun: (index: number) => void runHunk(index, 'discard')
              }
            }
          : {})
      }
    : undefined

  if (area === 'conflicts') {
    if (diff !== null && conflictMode === 'merge' && onResolveConflict !== undefined) {
      return (
        <MergeEditor
          sessionId={sessionId}
          path={path}
          onResolve={onResolveConflict}
          onShowDiff={() => setConflictMode('diff')}
        />
      )
    }
    return (
      <UnifiedDiffView
        path={path}
        state={state}
        onRetry={onRetry}
        comments={comments}
        onAddComment={onAddComment}
        onRemoveComment={onRemoveComment}
        scopeLabel={scopeLabel}
        headerActions={
          diff !== null && onResolveConflict !== undefined ? (
            <button
              type="button"
              className="rounded border border-border bg-card px-1.5 py-0.5 text-[9.5px] text-foreground hover:bg-muted"
              data-testid="merge-open"
              onClick={() => setConflictMode('merge')}
            >
              Merge Editor
            </button>
          ) : undefined
        }
        notice={hunkError ?? undefined}
      />
    )
  }

  if (mode === 'inline' || diff === null) {
    return (
      <UnifiedDiffView
        path={path}
        state={state}
        onRetry={onRetry}
        comments={comments}
        onAddComment={onAddComment}
        onRemoveComment={onRemoveComment}
        scopeLabel={scopeLabel}
        headerActions={diff === null ? undefined : toggle}
        hunkAction={hunkAction}
        notice={hunkError ?? undefined}
      />
    )
  }

  const unifiedBody = (
    <DiffBody
      path={path}
      diff={diff}
      stale={state.phase === 'ready' && state.stale === true}
      scopeLabel={scopeLabel}
      comments={comments}
      onAddComment={onAddComment}
      onRemoveComment={onRemoveComment}
      showHeader={false}
      hunkAction={hunkAction}
    />
  )

  if (!splitEligible) {
    return (
      <UnifiedDiffView
        path={path}
        state={state}
        onRetry={onRetry}
        comments={comments}
        onAddComment={onAddComment}
        onRemoveComment={onRemoveComment}
        scopeLabel={scopeLabel}
        headerActions={toggle}
        hunkAction={hunkAction}
        notice={
          diff.binary || diff.symlink === true
            ? 'Side-by-side view is unavailable for this entry.'
            : 'Side-by-side view is unavailable for a truncated diff.'
        }
      />
    )
  }

  if (sides.phase === 'error' && sides.diff === diff) {
    return (
      <UnifiedDiffView
        path={path}
        state={state}
        onRetry={onRetry}
        comments={comments}
        onAddComment={onAddComment}
        onRemoveComment={onRemoveComment}
        scopeLabel={scopeLabel}
        headerActions={toggle}
        hunkAction={hunkAction}
        notice={
          hunkError !== null
            ? `${hunkError} Side-by-side view is unavailable: ${sides.reason}`
            : `Side-by-side view is unavailable: ${sides.reason}`
        }
      />
    )
  }

  const ready = sides.phase === 'ready' && sides.diff === diff
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={`review-diff-${path}`}>
      <DiffHeader
        diff={diff}
        stale={state.phase === 'ready' && state.stale === true}
        scopeLabel={scopeLabel}
        headerActions={toggle}
      />
      {hunkError !== null ? (
        <div
          className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[10px] text-destructive"
          data-testid="hunk-action-error"
        >
          {hunkError}
        </div>
      ) : null}
      {comments.length > 0 ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-add/30 bg-add-weak px-3 py-1.5 text-[10px] text-foreground"
          data-testid="diff-notes-banner"
        >
          <span>
            {comments.length} line note{comments.length === 1 ? '' : 's'} on this file.
          </span>
          <button
            type="button"
            className="rounded border border-add/40 px-1.5 py-0.5 text-[9.5px] hover:bg-add/10"
            data-testid="diff-notes-show-unified"
            onClick={() => onModeChange('inline')}
          >
            Open Unified to read or edit
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {ready ? (
          <MonacoDiffView
            path={path}
            original={sides.original}
            modified={sides.modified}
            fallback={unifiedBody}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
            <Loader2 size={12} className="mr-2 animate-spin" />
            Reading both sides…
          </div>
        )}
      </div>
    </div>
  )
}

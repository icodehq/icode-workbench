import { useRef, useState } from 'react'
import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react'
import type { WorktreeBlocker } from '../../../shared/schemas/ipc'
import type { WorktreeRemovalOutcome } from '../state/use-workspace'
import { useT, useTp } from '../i18n/use-i18n'

type Props = {
  repoName: string
  branch: string
  path: string
  /** Direct sessions that leave with the checkout. */
  sessionCount: number
  /** Open Files tabs with unsaved text for this workspace. */
  unsavedCount?: number
  onClose: () => void
  onRemove: (deleteBranch: boolean) => Promise<WorktreeRemovalOutcome>
  onDiscard: (confirmBranch: string, deleteBranch: boolean) => Promise<boolean>
}

function blockerTitle(blocker: WorktreeBlocker, t: ReturnType<typeof useT>): string {
  switch (blocker.kind) {
    case 'dirty':
      return t('scm.cleanup.blocker.dirty')
    case 'unmerged':
      return t('scm.cleanup.blocker.unmerged')
    case 'missing':
      return t('scm.cleanup.blocker.missing')
    case 'inconsistent':
      return t('scm.cleanup.blocker.inconsistent')
    default:
      return t('scm.cleanup.blocker.unknown')
  }
}

/**
 * Worktree-first removal.
 *
 * The normal dialog says only what leaves the machine; a Git blocker switches
 * the same dialog to the exceptional state, where the destructive escape hatch
 * names the exact branch it will discard.
 */
export default function RemoveWorktreeDialog({
  repoName,
  branch,
  path,
  sessionCount,
  unsavedCount = 0,
  onClose,
  onRemove,
  onDiscard
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [blocker, setBlocker] = useState<WorktreeBlocker | null>(null)

  const confirm = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const outcome = await onRemove(deleteBranch)
    busyRef.current = false
    setBusy(false)
    if (outcome.status === 'removed') {
      onClose()
      return
    }
    if (outcome.status === 'blocked') setBlocker(outcome.blocker)
  }

  const discard = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const removed = await onDiscard(branch, deleteBranch)
    busyRef.current = false
    setBusy(false)
    if (removed) onClose()
  }

  const dirty = blocker?.kind === 'dirty'
  const unmerged = blocker?.kind === 'unmerged'
  const blocked = blocker !== null

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('worktree.remove.title')}
      data-testid="remove-worktree-dialog"
      data-blocker={blocker?.kind ?? ''}
    >
      <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            {blocked ? (
              <AlertTriangle size={15} className="text-signal" />
            ) : (
              <Trash2 size={15} className="text-destructive" />
            )}
            <h2 className="text-[16px] font-semibold">
              {blocker === null ? t('worktree.remove.title') : blockerTitle(blocker, t)}
            </h2>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>

        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {blocker === null
            ? tp('worktree.remove.bodySessions', sessionCount, { branch })
            : dirty
              ? t('scm.cleanup.body.dirty')
              : unmerged
                ? t('scm.cleanup.body.unmerged')
                : blocker.kind === 'missing'
                  ? t('worktree.remove.missingBody')
                  : t('scm.cleanup.body.unknown')}
        </p>

        <dl className="mt-3 space-y-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <div className="break-all">
            {t('worktree.remove.repo')} <span className="text-foreground">{repoName}</span>
          </div>
          <div className="break-all">
            {t('scm.cleanup.branch')} <span className="text-foreground">{branch}</span>
          </div>
          <div className="break-all">
            {t('worktree.remove.path')} <span className="text-foreground">{path}</span>
          </div>
          <div>
            {t('worktree.remove.sessions')}{' '}
            <span className="text-foreground">{sessionCount}</span>
          </div>
          {blocker?.commits !== undefined ? (
            <div>
              {t('scm.cleanup.unmergedCommits')}{' '}
              <span className="text-foreground">{blocker.commits}</span>
            </div>
          ) : null}
          {blocker?.detail ? <div className="break-all">{blocker.detail}</div> : null}
        </dl>

        {unsavedCount > 0 && !blocked ? (
          <p
            className="mt-2 rounded border border-signal/40 bg-signal-weak px-2 py-1.5 text-[11px] leading-relaxed text-signal"
            data-testid="remove-worktree-unsaved"
          >
            {tp('session.remove.unsaved', unsavedCount)}
          </p>
        ) : null}

        {blocker?.files && blocker.files.length > 0 ? (
          <div className="mt-3 max-h-36 overflow-y-auto rounded-md border border-border bg-background px-3 py-2">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
              {t('scm.cleanup.modifiedFiles')}
            </p>
            <ul className="mt-1 space-y-0.5 font-mono text-[10px]">
              {blocker.files.slice(0, 40).map((file) => (
                <li key={file} className="truncate">
                  {file}
                </li>
              ))}
            </ul>
            {blocker.files.length > 40 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('scm.cleanup.more', { count: blocker.files.length - 40 })}
              </p>
            ) : null}
          </div>
        ) : null}

        {blocker === null ? (
          <label
            className={`mt-4 flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2.5 transition-colors ${
              deleteBranch
                ? 'border-destructive/50 bg-destructive/5'
                : 'border-border hover:bg-muted/40'
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-3.5 shrink-0 accent-destructive"
              checked={deleteBranch}
              onChange={(event) => setDeleteBranch(event.target.checked)}
              data-testid="remove-worktree-delete-branch"
            />
            <span className="min-w-0">
              <span className="block text-[12px] font-medium">
                {t('session.remove.deleteBranch', { branch })}
              </span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">
                {t('session.remove.deleteBranchBody')}
              </span>
            </span>
          </label>
        ) : null}

        {dirty ? (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3">
            <p className="text-[12px] font-medium text-destructive">
              {deleteBranch
                ? t('worktree.remove.discardTitleDeleteBranch')
                : t('worktree.remove.discardTitle')}
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {deleteBranch
                ? t('scm.cleanup.discardBodyDeleteBranch', { branch })
                : t('scm.cleanup.discardBody', { branch })}
            </p>
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-destructive px-2.5 py-1.5 text-[12px] font-medium text-danger-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void discard()}
              disabled={busy}
              data-testid="remove-worktree-discard"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              {deleteBranch
                ? t('worktree.remove.discardDeleteBranch')
                : t('worktree.remove.discard')}
            </button>
          </div>
        ) : null}

        {unmerged ? (
          <div className="mt-4 rounded-md border border-border bg-muted/20 px-3 py-3">
            <p className="text-[12px] font-medium text-foreground">
              {deleteBranch
                ? t('worktree.remove.checkoutTitleDeleteBranch')
                : t('worktree.remove.checkoutTitle')}
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {deleteBranch
                ? t('scm.cleanup.removeCheckoutBodyDeleteBranch', {
                    branch,
                    commits: blocker?.commits ?? 0
                  })
                : t('scm.cleanup.removeCheckoutBody', { branch })}
            </p>
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void discard()}
              disabled={busy}
              data-testid="remove-worktree-checkout"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              {deleteBranch
                ? t('scm.cleanup.removeCheckoutDeleteBranch')
                : t('scm.cleanup.removeCheckout')}
            </button>
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          {blocked ? (
            <button
              type="button"
              className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
              onClick={onClose}
              data-testid="remove-worktree-keep"
            >
              {t('scm.cleanup.keep')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
                onClick={onClose}
                data-testid="remove-worktree-cancel"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="h-9 rounded-md bg-destructive px-3.5 text-[12px] font-medium text-danger-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void confirm()}
                disabled={busy}
                data-testid="remove-worktree-confirm"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : null}
                {t('worktree.remove.confirm')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

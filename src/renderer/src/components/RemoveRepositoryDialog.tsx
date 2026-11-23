import { useEffect } from 'react'
import { Trash2, X } from 'lucide-react'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import { useT } from '../i18n/use-i18n'

type Props = {
  repo: RepositorySummary
  sessionCount: number
  worktreeCount: number
  onClose: () => void
  onConfirm: () => void
}

/**
 * Removing a project stops its sessions and deletes their worktrees, so it
 * must be confirmed. The dialog says what leaves the machine, what is
 * protected, and what stays — the repository folder itself is untouched.
 */
export default function RemoveRepositoryDialog({
  repo,
  sessionCount,
  worktreeCount,
  onClose,
  onConfirm
}: Props): React.JSX.Element {
  const t = useT()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('projects.remove.title', { name: repo.displayName })}
      data-testid="remove-repository-dialog"
    >
      <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Trash2 size={15} className="text-destructive" />
            <h2 className="text-[16px] font-semibold">
              {t('projects.remove.title', { name: repo.displayName })}
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
          {t('projects.remove.body')}
        </p>
        <p
          className="mt-2 font-mono text-[10.5px] text-muted-foreground"
          data-testid="remove-repository-impact"
        >
          {t('projects.remove.impact', { sessions: sessionCount, worktrees: worktreeCount })}
        </p>
        <p className="mt-2 rounded border border-border bg-muted/40 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {t('projects.remove.recovery')}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
            onClick={onClose}
            autoFocus
            data-testid="remove-repository-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="h-9 rounded-md bg-destructive px-3.5 text-[12px] font-medium text-danger-ink hover:opacity-90"
            onClick={onConfirm}
            data-testid="confirm-remove-repo"
          >
            {t('projects.remove.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

import { Trash2, X } from 'lucide-react'
import type { SessionSummary } from '../../../shared/schemas/ipc'

type Props = {
  session: SessionSummary
  /** Open Files tabs with unsaved text for this session. */
  unsavedCount?: number
  onClose: () => void
  onConfirm: () => void
}

/**
 * Remove is the one user-facing way to end a session.
 *
 * A live process is stopped first and the worktree is checked before deletion,
 * but those are implementation details. The normal dialog says only what the
 * user loses and what iCode protects; the exceptional dirty/unmerged state is
 * explained by the cleanup dialog after the attempt.
 */
export default function RemoveSessionDialog({
  session,
  unsavedCount = 0,
  onClose,
  onConfirm
}: Props): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Remove session"
      data-testid="remove-session-dialog"
    >
      <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Trash2 size={15} className="text-destructive" />
            <h2 className="text-[16px] font-semibold">Remove session?</h2>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          Remove <span className="font-medium text-foreground">{session.title}</span>? The
          session and its files are removed. Its branch is kept, and uncommitted work is
          protected.
        </p>
        {unsavedCount > 0 ? (
          <p
            className="mt-2 rounded border border-signal/40 bg-signal-weak px-2 py-1.5 text-[11px] leading-relaxed text-signal"
            data-testid="remove-session-unsaved"
          >
            {unsavedCount} unsaved file{unsavedCount === 1 ? '' : 's'} in Files will be lost.
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
            onClick={onClose}
            data-testid="remove-session-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="h-9 rounded-md bg-destructive px-3.5 text-[12px] font-medium text-black hover:opacity-90"
            onClick={onConfirm}
            data-testid="remove-session-confirm"
          >
            Remove session
          </button>
        </div>
      </div>
    </div>
  )
}

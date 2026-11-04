import { Moon, X } from 'lucide-react'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import { wakeDescription } from '../../../shared/domain/session-sleep'

type Props = {
  session: SessionSummary
  onClose: () => void
  onConfirm: () => void
}

/**
 * Sleep stops the process for real; it is not a suspended process. The copy
 * names what survives and what Wake will do for this harness, so a Shell user
 * is never promised a restored environment.
 */
export default function SleepSessionDialog({
  session,
  onClose,
  onConfirm
}: Props): React.JSX.Element {
  const working = session.activity?.state === 'working'
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Sleep session"
      data-testid="sleep-session-dialog"
    >
      <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Moon size={15} className="text-info" />
            <h2 className="text-[16px] font-semibold">Sleep session?</h2>
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
          <span className="font-medium text-foreground">{session.title}</span> stops its terminal
          process and frees CPU and memory. The session, worktree and branch stay.
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {wakeDescription(session.harness)} Terminal scrollback is not preserved.
        </p>
        {working ? (
          <p className="mt-2 rounded border border-signal-line bg-signal-weak px-2 py-1.5 text-[11px] leading-relaxed text-signal">
            The agent is still working. Sleeping interrupts the current turn.
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
            onClick={onClose}
            data-testid="sleep-session-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="h-9 rounded-md bg-info px-3.5 text-[12px] font-medium text-black hover:opacity-90"
            onClick={onConfirm}
            data-testid="sleep-session-confirm"
          >
            Sleep session
          </button>
        </div>
      </div>
    </div>
  )
}

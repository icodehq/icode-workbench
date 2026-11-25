import { AlertTriangle, X } from 'lucide-react'
import { isAgentHarness } from '../../../../shared/domain/harness'
import type { SessionSummary } from '../../../../shared/schemas/ipc'
import { useT } from '../../i18n/use-i18n'

/**
 * Confirmation before a session tab's X kills the process behind it.
 *
 * Closing a tab is not just navigation here: it ends the running agent or
 * terminal. The worktree, branch and open editor buffers stay, and the session
 * remains in the sidebar as stopped so it can be restarted.
 */
export default function StopSessionDialog({
  session,
  onCancel,
  onConfirm
}: {
  session: SessionSummary
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useT()
  const agent = isAgentHarness(session.harness)
  const title = t('session.stop.title', { title: session.title })
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="stop-session-dialog"
    >
      <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-destructive" />
            <h2 className="text-[16px] font-semibold">{title}</h2>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onCancel}
            aria-label={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {agent ? t('session.stop.agentBody') : t('session.stop.terminalBody')}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
            onClick={onCancel}
            data-testid="stop-session-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="h-9 rounded-md border border-destructive/50 bg-destructive/10 px-3 text-[12px] font-medium text-destructive hover:bg-destructive/20"
            onClick={onConfirm}
            data-testid="stop-session-confirm"
          >
            {agent ? t('session.stop.confirmAgent') : t('session.stop.confirmTerminal')}
          </button>
        </div>
      </div>
    </div>
  )
}

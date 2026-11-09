import { useEffect } from 'react'
import { AlertTriangle, Loader2, Undo2 } from 'lucide-react'
import { useT } from '../i18n/use-i18n'

type Props = {
  message: string
  hasStaged: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Amending rewrites the last local commit. It is deliberately separate from
 * Commit & push and never offers a force-push: a rewritten commit should not be
 * published by a confirmation dialog.
 */
export default function AmendDialog({
  message,
  hasStaged,
  busy,
  onCancel,
  onConfirm
}: Props): React.JSX.Element {
  const t = useT()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('scm.amend.aria')}
      data-testid="amend-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div className="icode-modal w-[min(520px,100%)] overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-[var(--icode-shadow-overlay)]">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-[14px] font-semibold">{t('scm.amend.title')}</h2>
          <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
            {t('scm.amend.body')}
          </p>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div className="flex items-start gap-2 rounded-md border border-signal-line bg-signal-weak px-3 py-2 text-[11px] leading-relaxed text-signal">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              {t('scm.amend.warning')}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {message.trim().length > 0
              ? t('scm.amend.withMessage', { message: message.trim() })
              : t('scm.amend.keepMessage')}
            {hasStaged ? t('scm.amend.hasStaged') : t('scm.amend.noStaged')}
          </p>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted disabled:opacity-40"
            onClick={onCancel}
            disabled={busy}
          >
            {t('scm.amend.cancel')}
          </button>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive hover:bg-destructive/15 disabled:opacity-40"
            onClick={onConfirm}
            disabled={busy}
            data-testid="amend-confirm"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
            {t('scm.amend.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

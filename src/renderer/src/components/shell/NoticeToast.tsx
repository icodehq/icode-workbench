import { useEffect } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import type { Notice } from '../../state/workspace'
import { useT } from '../../i18n/use-i18n'

type Props = {
  notice: Notice | null
  onDismiss: () => void
}

/** Global transient notice. The old full-width status bar was its only home. */
export default function NoticeToast({ notice, onDismiss }: Props): React.JSX.Element | null {
  const t = useT()
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(onDismiss, notice.tone === 'error' ? 8000 : 4500)
    return () => window.clearTimeout(timer)
  }, [notice, onDismiss])

  if (!notice) return null
  const tone =
    notice.tone === 'error'
      ? 'border-destructive/40 bg-destructive/12 text-destructive'
      : notice.tone === 'success'
        ? 'border-add/40 bg-add-weak text-add'
        : 'border-border bg-card text-foreground'
  const Icon = notice.tone === 'error' ? AlertCircle : notice.tone === 'success' ? CheckCircle2 : Info
  return (
    <div
      className={`fixed bottom-4 left-1/2 z-[70] flex max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-2 rounded-lg border px-3 py-2 text-[11px] shadow-xl ${tone}`}
      role="status"
      data-testid="notice"
      data-tone={notice.tone}
    >
      <Icon size={13} className="shrink-0" />
      <span className="min-w-0 flex-1" title={notice.detail}>
        {notice.message}
      </span>
      {notice.action ? (
        <button
          type="button"
          className="shrink-0 rounded border border-current/30 px-1.5 py-0.5 text-[10px] font-medium hover:bg-white/10"
          data-testid="notice-action"
          onClick={() => {
            const action = notice.action
            onDismiss()
            action?.run()
          }}
        >
          {notice.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="shrink-0 rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100"
        onClick={onDismiss}
        aria-label={t('status.dismiss')}
      >
        <X size={10} />
      </button>
    </div>
  )
}

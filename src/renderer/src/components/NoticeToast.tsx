import { useEffect } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import type { Notice } from '../state/workspace'

type Props = {
  notice: Notice | null
  onDismiss: () => void
}

const TONE = {
  info: {
    className: 'border-info/40 bg-info-weak text-info',
    Icon: Info
  },
  success: {
    className: 'border-add/40 bg-add-weak text-add',
    Icon: CheckCircle2
  },
  error: {
    className: 'border-destructive/50 bg-destructive/10 text-destructive',
    Icon: AlertCircle
  }
} as const

export default function NoticeToast({ notice, onDismiss }: Props): React.JSX.Element | null {
  useEffect(() => {
    if (!notice) return
    // Errors stay long enough to read the detail; confirmations are transient.
    const timer = window.setTimeout(onDismiss, notice.tone === 'error' ? 8000 : 4500)
    return () => window.clearTimeout(timer)
  }, [notice, onDismiss])
  if (!notice) return null
  const tone = TONE[notice.tone]
  return (
    <div
      className={`fixed bottom-10 right-3 z-50 flex w-[380px] max-w-[calc(100vw-24px)] items-start gap-2 rounded-md border px-3 py-2 text-[11px] shadow-xl ${tone.className}`}
      role="status"
      data-testid="notice"
      data-tone={notice.tone}
    >
      <tone.Icon size={13} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="leading-relaxed">{notice.message}</p>
        {notice.detail ? (
          <p className="mt-1 break-words font-mono text-[9px] leading-relaxed opacity-80">
            {notice.detail}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className="rounded p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <X size={12} />
      </button>
    </div>
  )
}

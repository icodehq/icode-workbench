import { AlertTriangle, Loader2, X } from 'lucide-react'
import type { RemovalPrompt } from '../state/workspace'

type Props = {
  prompt: RemovalPrompt
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

export default function RemovalDialog({
  prompt,
  busy,
  onCancel,
  onConfirm
}: Props): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm repository removal"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-amber-400" />
            <h2 className="text-[14px] font-semibold">Remove {prompt.repoName}?</h2>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onCancel}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          This unregisters the repository and permanently deletes{' '}
          {prompt.sessions.length === 1
            ? 'one stored session record'
            : `${String(prompt.sessions.length)} stored session records`}
          . Files on disk are not touched.
        </p>
        <ul className="mt-3 max-h-40 overflow-y-auto rounded-md border border-border bg-background px-3 py-2">
          {prompt.sessions.map((session) => (
            <li key={session.id} className="truncate py-0.5 text-[11px]">
              {session.title}
              <span className="ml-2 text-[9px] text-muted-foreground">{session.state}</span>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted"
            onClick={onCancel}
            disabled={busy}
          >
            Keep repository
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-[11px] font-medium text-black hover:opacity-90 disabled:opacity-50"
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-remove-repo"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            Remove repository
          </button>
        </div>
      </div>
    </div>
  )
}

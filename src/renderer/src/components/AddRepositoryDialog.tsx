import { useState } from 'react'
import { Loader2, X } from 'lucide-react'

type Props = {
  onClose: () => void
  onSubmit: (path: string) => Promise<boolean>
}

export default function AddRepositoryDialog({ onClose, onSubmit }: Props): React.JSX.Element {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    const ok = await onSubmit(path)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Register repository"
    >
      <form
        className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl"
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[14px] font-semibold">Register a repository</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              ADE only registers the path. Your files and Git checkout are not modified.
            </p>
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

        <label className="mt-4 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Local Git repository path
        </label>
        <input
          autoFocus
          className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[12px] outline-none focus:border-accent"
          placeholder="/home/you/projects/my-repo"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          spellCheck={false}
          data-testid="add-repo-input"
        />
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          The path must be an existing Git working tree visible to this machine.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={busy || path.trim().length === 0}
            data-testid="add-repo-submit"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            Register
          </button>
        </div>
      </form>
    </div>
  )
}

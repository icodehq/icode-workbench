import { useEffect } from 'react'
import { Copy, X } from 'lucide-react'
import type { GitHistoryPayload } from '../../../shared/icode-api'
import type { Notice } from '../state/workspace'

type HistoryData = Extract<GitHistoryPayload, { status: 'ok' }>

type Props = {
  data: HistoryData
  notify: (notice: Notice) => void
  onClose: () => void
}

/** Read-only commit log for the worktree; never invokes a checkout or reset. */
export default function GitHistoryDialog({ data, notify, onClose }: Props): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const copy = async (oid: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(oid)
      notify({ tone: 'success', message: `Copied ${oid}` })
    } catch {
      notify({ tone: 'error', message: 'Clipboard is unavailable.' })
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Recent commits"
      data-testid="git-history-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="icode-modal flex max-h-[80vh] w-[min(580px,100%)] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-[var(--icode-shadow-overlay)]">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold">Recent commits</h2>
            <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground">
              {data.branch ?? 'detached HEAD'} · this worktree
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label="Close commit history"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {data.commits.length === 0 ? (
            <p className="px-2 py-5 text-[11.5px] text-muted-foreground">This worktree has no commits yet.</p>
          ) : (
            <ul className="space-y-1">
              {data.commits.map((commit) => (
                <li
                  key={commit.oid}
                  className="flex items-start gap-2 rounded-md px-2 py-2 hover:bg-muted/50"
                  data-testid={`git-history-commit-${commit.oid}`}
                >
                  <span className="shrink-0 pt-0.5 font-mono text-[10.5px] text-accent">{commit.oid}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[11.5px] text-foreground">{commit.subject}</span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      {commit.author} · {commit.when}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => void copy(commit.oid)}
                    title={`Copy ${commit.oid}`}
                    aria-label={`Copy commit ${commit.oid}`}
                  >
                    <Copy size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          <span className="text-[10px] text-muted-foreground">Read-only · git log in this worktree</span>
          <button
            type="button"
            className="ml-auto rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

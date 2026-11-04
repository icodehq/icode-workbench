import { useEffect } from 'react'
import { FileDiff, X } from 'lucide-react'
import type { GitComparePayload } from '../../../shared/icode-api'

type CompareData = Extract<GitComparePayload, { status: 'ok' }>

type Props = {
  data: CompareData
  onClose: () => void
  onOpenChanges: () => void
}

function statusClass(status: string): string {
  if (status === 'A') return 'text-add'
  if (status === 'D') return 'text-destructive'
  if (status === 'R') return 'text-info'
  return 'text-signal'
}

/**
 * A summary of the worktree against the commit it started from.
 *
 * The actual line review lives in Changes; this dialog exists to answer whether
 * the branch is ready to publish without duplicating the diff surface.
 */
export default function GitCompareDialog({
  data,
  onClose,
  onOpenChanges
}: Props): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Compare with baseline"
      data-testid="git-compare-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="icode-modal flex max-h-[80vh] w-[min(600px,100%)] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-[var(--icode-shadow-overlay)]">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold">Compare with baseline</h2>
            <p className="mt-1 font-mono text-[10.5px] text-muted-foreground">
              {data.baseOid.slice(0, 10)} → HEAD
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label="Close comparison"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5">
          <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
            ↑ {data.ahead} ahead
          </span>
          <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            ↓ {data.behind} behind
          </span>
          <span className="text-[10.5px] text-muted-foreground">
            {data.files.length} changed file{data.files.length === 1 ? '' : 's'}
            {data.truncated ? ' · showing the first 200' : ''}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {data.files.length === 0 ? (
            <p className="px-2 py-5 text-[11.5px] text-muted-foreground">
              No changes against the baseline.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {data.files.map((file) => (
                <li
                  key={`${file.oldPath ?? ''}:${file.path}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                  data-testid={`git-compare-file-${file.path}`}
                >
                  <span className={`w-4 shrink-0 font-mono text-[11px] ${statusClass(file.status)}`}>
                    {file.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                    {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {file.binary
                      ? 'binary'
                      : `+${file.additions ?? '—'} −${file.deletions ?? '—'}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          <span className="text-[10px] text-muted-foreground">The line-by-line diff is in Changes.</span>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink hover:opacity-90"
            onClick={() => {
              onClose()
              onOpenChanges()
            }}
            data-testid="git-compare-open-changes"
          >
            <FileDiff size={11} />
            Open Changes
          </button>
        </div>
      </div>
    </div>
  )
}

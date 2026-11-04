import { useEffect, useState } from 'react'
import { AlertTriangle, GitBranch, Loader2, X } from 'lucide-react'
import type { SessionCleanupPrompt } from '../state/workspace'

type Props = {
  prompt: SessionCleanupPrompt
  busy: boolean
  onClose: () => void
  onDiscard: (confirmBranch: string) => Promise<boolean>
  onRecover: () => void
}

function blockerTitle(prompt: SessionCleanupPrompt): string {
  switch (prompt.blocker?.kind) {
    case 'dirty':
      return 'Uncommitted changes block removal'
    case 'unmerged':
      return 'Unmerged commits block removal'
    case 'missing':
      return 'The worktree is missing'
    case 'inconsistent':
      return 'The worktree cannot be verified'
    default:
      return 'This session cannot be removed yet'
  }
}

/**
 * Removal is blocked, not confirmable, when work is at risk. The only
 * destructive path is a separate discard that requires the exact branch name.
 */
export default function WorktreeCleanupDialog({
  prompt,
  busy,
  onClose,
  onDiscard,
  onRecover
}: Props): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const blocker = prompt.blocker
  const discardable = blocker?.kind === 'dirty' || blocker?.kind === 'unmerged'
  const recoverable = blocker?.kind === 'missing'
  const confirmMatches = typed.trim() === prompt.branch

  useEffect(() => {
    setTyped('')
  }, [prompt.sessionId, prompt.branch])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Session worktree cleanup"
      data-testid="worktree-cleanup-dialog"
    >
      <div className="icode-modal w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-signal" />
            <h2 className="text-[16px] font-semibold">{blockerTitle(prompt)}</h2>
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
          {blocker?.kind === 'dirty'
            ? 'Commit the work in the session terminal, or discard the worktree deliberately. iCode will not delete a worktree that contains changes.'
            : blocker?.kind === 'unmerged'
              ? 'The branch has commits that are not in the primary checkout. Merge them, or discard the worktree deliberately.'
              : blocker?.kind === 'missing'
                ? 'The directory is gone, so nothing will be deleted. Re-create the checkout from the retained branch, then remove the session normally.'
                : 'iCode could not verify this worktree. Nothing will be deleted until the state can be inspected.'}
        </p>

        <dl className="mt-3 space-y-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <div>
            session <span className="text-foreground">{prompt.title}</span>
          </div>
          <div>
            branch <span className="text-foreground">{prompt.branch || '—'}</span>
          </div>
          {blocker?.commits !== undefined ? (
            <div>
              unmerged commits <span className="text-foreground">{blocker.commits}</span>
            </div>
          ) : null}
          {blocker?.detail ? <div className="break-all">{blocker.detail}</div> : null}
        </dl>

        {blocker?.files && blocker.files.length > 0 ? (
          <div className="mt-3 max-h-36 overflow-y-auto rounded-md border border-border bg-background px-3 py-2">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Modified files
            </p>
            <ul className="mt-1 space-y-0.5 font-mono text-[10px]">
              {blocker.files.slice(0, 40).map((file) => (
                <li key={file} className="truncate">
                  {file}
                </li>
              ))}
            </ul>
            {blocker.files.length > 40 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                +{blocker.files.length - 40} more
              </p>
            ) : null}
          </div>
        ) : null}

        {recoverable ? (
          <button
            type="button"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-muted"
            onClick={onRecover}
            data-testid="cleanup-recover"
          >
            <GitBranch size={12} />
            Re-create worktree from {prompt.branch}
          </button>
        ) : null}

        {discardable ? (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3">
            <p className="text-[12px] font-medium text-destructive">
              Discard the worktree and lose the changes above
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              The branch is kept, so committed work remains reachable. Uncommitted files are
              deleted with the checkout. Type{' '}
              <span className="font-mono text-foreground">{prompt.branch}</span> to confirm.
            </p>
            <input
              className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:border-destructive"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={prompt.branch}
              spellCheck={false}
              data-testid="discard-confirm-input"
            />
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-destructive px-2.5 py-1.5 text-[12px] font-medium text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void onDiscard(prompt.branch)}
              disabled={!confirmMatches || busy}
              data-testid="discard-confirm"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              Discard worktree
            </button>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
            onClick={onClose}
          >
            Keep worktree
          </button>
        </div>
      </div>
    </div>
  )
}

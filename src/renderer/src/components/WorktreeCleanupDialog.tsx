import { useEffect, useState } from 'react'
import { AlertTriangle, GitBranch, Loader2, X } from 'lucide-react'
import type { SessionCleanupPrompt } from '../state/workspace'
import { useT } from '../i18n/use-i18n'

type Props = {
  prompt: SessionCleanupPrompt
  busy: boolean
  onClose: () => void
  onDiscard: (confirmBranch: string) => Promise<boolean>
  onRecover: () => void
}

function blockerTitle(prompt: SessionCleanupPrompt, t: ReturnType<typeof useT>): string {
  switch (prompt.blocker?.kind) {
    case 'dirty':
      return t('scm.cleanup.blocker.dirty')
    case 'unmerged':
      return t('scm.cleanup.blocker.unmerged')
    case 'missing':
      return t('scm.cleanup.blocker.missing')
    case 'inconsistent':
      return t('scm.cleanup.blocker.inconsistent')
    default:
      return t('scm.cleanup.blocker.unknown')
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
  const t = useT()
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
      aria-label={t('scm.cleanup.aria')}
      data-testid="worktree-cleanup-dialog"
    >
      <div className="icode-modal w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-signal" />
            <h2 className="text-[16px] font-semibold">{blockerTitle(prompt, t)}</h2>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>

        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {blocker?.kind === 'dirty'
            ? t('scm.cleanup.body.dirty')
            : blocker?.kind === 'unmerged'
              ? t('scm.cleanup.body.unmerged')
              : blocker?.kind === 'missing'
                ? t('scm.cleanup.body.missing')
                : t('scm.cleanup.body.unknown')}
        </p>

        <dl className="mt-3 space-y-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <div>
            {t('scm.cleanup.session')} <span className="text-foreground">{prompt.title}</span>
          </div>
          <div>
            {t('scm.cleanup.branch')} <span className="text-foreground">{prompt.branch || '—'}</span>
          </div>
          {blocker?.commits !== undefined ? (
            <div>
              {t('scm.cleanup.unmergedCommits')}{' '}
              <span className="text-foreground">{blocker.commits}</span>
            </div>
          ) : null}
          {blocker?.detail ? <div className="break-all">{blocker.detail}</div> : null}
        </dl>

        {blocker?.files && blocker.files.length > 0 ? (
          <div className="mt-3 max-h-36 overflow-y-auto rounded-md border border-border bg-background px-3 py-2">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
              {t('scm.cleanup.modifiedFiles')}
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
                {t('scm.cleanup.more', { count: blocker.files.length - 40 })}
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
            {t('scm.cleanup.recover', { branch: prompt.branch })}
          </button>
        ) : null}

        {discardable ? (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3">
            <p className="text-[12px] font-medium text-destructive">
              {t('scm.cleanup.discardTitle')}
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {t('scm.cleanup.discardBody', { branch: prompt.branch })}
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
              {t('scm.cleanup.discard')}
            </button>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
            onClick={onClose}
          >
            {t('scm.cleanup.keep')}
          </button>
        </div>
      </div>
    </div>
  )
}

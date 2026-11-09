import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import type { BranchCleanupPrompt } from '../state/workspace'
import { useT } from '../i18n/use-i18n'

type Props = {
  prompt: BranchCleanupPrompt
  busy: boolean
  onClose: () => void
  onConfirm: (confirmBranch: string) => Promise<void>
}

/**
 * Branch deletion is separate from worktree removal. Unmerged commits require
 * the exact branch name, never a boolean acknowledgement.
 */
export default function BranchCleanupDialog({
  prompt,
  busy,
  onClose,
  onConfirm
}: Props): React.JSX.Element {
  const t = useT()
  const [typed, setTyped] = useState('')

  useEffect(() => {
    setTyped('')
  }, [prompt.branch])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('scm.branchDelete.aria')}
      data-testid="branch-cleanup-dialog"
    >
      <div className="icode-modal w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-signal" />
            <h2 className="text-[16px] font-semibold">{t('scm.branchDelete.title')}</h2>
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
          {t('scm.branchDelete.body', {
            branch: prompt.branch,
            commits: prompt.commits
          })}
        </p>
        <input
          className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:border-destructive"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={prompt.branch}
          spellCheck={false}
          data-testid="branch-confirm-input"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
            onClick={onClose}
          >
            {t('scm.branchDelete.keep')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 h-9 rounded-md bg-destructive px-3.5 text-[12px] font-medium text-black hover:opacity-90 disabled:opacity-40"
            disabled={typed.trim() !== prompt.branch || busy}
            onClick={() => void onConfirm(prompt.branch)}
            data-testid="branch-confirm-delete"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            {t('scm.branchDelete.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}

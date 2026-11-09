import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RotateCcw, Undo2 } from 'lucide-react'
import { useT } from '../i18n/use-i18n'

export type CommitDialogKind = 'cherry-pick' | 'revert' | 'reset'
export type ResetMode = 'soft' | 'mixed' | 'hard'

type Props = {
  kind: CommitDialogKind
  shortOid: string
  subject: string
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (value: { mode?: ResetMode }) => void
}

const TITLE_KEYS: Record<
  CommitDialogKind,
  'scm.commitDialog.cherryPick' | 'scm.commitDialog.revert' | 'scm.commitDialog.reset'
> = {
  'cherry-pick': 'scm.commitDialog.cherryPick',
  revert: 'scm.commitDialog.revert',
  reset: 'scm.commitDialog.reset'
}

/**
 * Confirmation for a commit action from History.
 *
 * Cherry-pick and revert create commits; reset can discard work. The dialog
 * names the commit and states the effect before the action runs, and failure
 * text stays inline so the dialog is not lost when Git refuses.
 */
export default function ScmCommitDialog({
  kind,
  shortOid,
  subject,
  busy,
  error,
  onCancel,
  onSubmit
}: Props): React.JSX.Element {
  const t = useT()
  const [mode, setMode] = useState<ResetMode>('mixed')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel])

  const danger = kind === 'reset' || kind === 'revert'
  const Icon = kind === 'reset' ? RotateCcw : Undo2

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t(TITLE_KEYS[kind])}
      data-testid="scm-commit-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div className="icode-modal w-[min(520px,100%)] overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-[var(--icode-shadow-overlay)]">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-[14px] font-semibold">{t(TITLE_KEYS[kind])}</h2>
          <p className="mt-1 min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">
            {shortOid} · {subject}
          </p>
        </div>
        <div className="space-y-3 px-4 py-3">
          {kind === 'cherry-pick' ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t('scm.commitDialog.cherryBody')}
            </p>
          ) : null}

          {kind === 'revert' ? (
            <div className="flex items-start gap-2 rounded-md border border-signal-line bg-signal-weak px-3 py-2 text-[11px] leading-relaxed text-signal">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                {t('scm.commitDialog.revertBody')}
              </span>
            </div>
          ) : null}

          {kind === 'reset' ? (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-[11px] text-foreground">
                {t('scm.commitDialog.resetMode')}
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as ResetMode)}
                  className="h-7 rounded border border-border bg-background px-1.5 font-mono text-[10.5px]"
                  data-testid="scm-reset-mode"
                >
                  <option value="soft">{t('scm.commitDialog.soft')}</option>
                  <option value="mixed">{t('scm.commitDialog.mixed')}</option>
                  <option value="hard">{t('scm.commitDialog.hard')}</option>
                </select>
              </label>
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  {t('scm.commitDialog.resetMoves', {
                    oid: shortOid,
                    detail:
                      mode === 'hard'
                        ? t('scm.commitDialog.resetHard')
                        : t('scm.commitDialog.resetSoft')
                  })}
                </span>
              </div>
            </div>
          ) : null}

          {error !== null ? (
            <div
              className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-[10.5px] leading-relaxed text-destructive"
              data-testid="scm-commit-error"
            >
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted disabled:opacity-40"
            onClick={onCancel}
            disabled={busy}
            data-testid="scm-commit-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`ml-auto inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] disabled:opacity-40 ${
              danger
                ? 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15'
                : 'border-add/50 bg-add-weak text-foreground hover:bg-add/20'
            }`}
            onClick={() => onSubmit(kind === 'reset' ? { mode } : {})}
            disabled={busy}
            data-testid="scm-commit-confirm"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
            {kind === 'cherry-pick'
              ? t('scm.commitDialog.cherryPickAction')
              : kind === 'revert'
                ? t('scm.commitDialog.revertAction')
                : t('scm.commitDialog.resetAction')}
          </button>
        </div>
      </div>
    </div>
  )
}

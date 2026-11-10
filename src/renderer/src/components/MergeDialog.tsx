import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, GitMerge, Loader2 } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import type { MergeRecordPayload } from '../../../shared/schemas/ipc'
import { callApi } from '../lib/api'
import { useT } from '../i18n/use-i18n'
import { useBranchRefs } from '../state/use-branch-refs'

type Props = {
  session: SessionSummary
  /** Chain tasks default to their shared branch. */
  defaultTarget?: string | null
  /** Dependents exist, so the chain branch is the only valid target. */
  lockTarget?: boolean
  onClose: () => void
  onMerged: (record: MergeRecordPayload) => void
  onConflicted: (record: MergeRecordPayload) => void
}

function errorText(error: AppError | null, fallback: string): string | null {
  if (error === null) return null
  return error.message.length > 0 ? error.message : fallback
}

export default function MergeDialog({
  session,
  defaultTarget = null,
  lockTarget = false,
  onClose,
  onMerged,
  onConflicted
}: Props): React.JSX.Element {
  const t = useT()
  const branchRefs = useBranchRefs(session.repoId)
  const [target, setTarget] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [record, setRecord] = useState<MergeRecordPayload | null>(null)

  const sourceBranch = session.worktree?.branch ?? null
  const options = useMemo(
    () =>
      branchRefs.refs
        .filter((ref) => ref.name !== sourceBranch)
        .map((ref) => ({
          ref,
          disabled:
            ref.worktreePath !== null &&
            ref.worktreePath !== session.worktree?.path
        })),
    [branchRefs.refs, session.worktree?.path, sourceBranch]
  )

  useEffect(() => {
    if (target.length > 0) return
    if (defaultTarget !== null && defaultTarget.length > 0) {
      setTarget(defaultTarget)
      return
    }
    const primary = branchRefs.refs.find((ref) => ref.primaryHead)
    if (primary) setTarget(primary.name)
  }, [branchRefs.refs, defaultTarget, target])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await callApi(window.icode.merge.state({ sessionId: session.id }))
      if (cancelled || !result.ok) return
      if (result.value && result.value.state === 'conflicted') setRecord(result.value)
    })()
    return () => {
      cancelled = true
    }
  }, [session.id])

  const submit = async (): Promise<void> => {
    if (busy || target.length === 0) return
    setBusy(true)
    setError(null)
    const result = await callApi(
      window.icode.merge.start({
        sessionId: session.id,
        targetBranch: target,
        ...(message.trim().length > 0 ? { commitMessage: message.trim() } : {})
      })
    )
    setBusy(false)
    if (!result.ok) {
      setError(errorText(result.error, t('merge.error')))
      return
    }
    setRecord(result.value.record)
    if (result.value.status === 'merged') onMerged(result.value.record)
    else onConflicted(result.value.record)
  }

  const continueMerge = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await callApi(window.icode.merge.continueMerge({ sessionId: session.id }))
    setBusy(false)
    if (!result.ok) {
      setError(errorText(result.error, t('merge.error')))
      return
    }
    setRecord(result.value.record)
    if (result.value.status === 'merged') onMerged(result.value.record)
    else onConflicted(result.value.record)
  }

  const abort = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await callApi(window.icode.merge.abort({ sessionId: session.id }))
    setBusy(false)
    if (!result.ok) {
      setError(errorText(result.error, t('merge.error')))
      return
    }
    setRecord(result.value)
    onClose()
  }

  const conflicted = record?.state === 'conflicted'

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('merge.title')}
      data-testid="merge-dialog"
    >
      <div className="icode-modal flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-[16px] font-semibold">
              <GitMerge size={15} />
              {t('merge.title')}
            </h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('merge.subtitle', {
                source: sourceBranch ?? t('merge.unknownBranch')
              })}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          {conflicted ? (
            <>
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle size={12} />
                  {t('merge.conflictTitle')}
                </p>
                <p className="mt-1 text-[10.5px]">{t('merge.conflictHint')}</p>
                <ul className="mt-1.5 space-y-0.5 font-mono text-[10px]">
                  {record.conflictFiles.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-md border border-border px-3 text-[11px] hover:bg-muted"
                  onClick={() => void abort()}
                  disabled={busy}
                  data-testid="merge-abort"
                >
                  {t('merge.abort')}
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[11px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
                  onClick={() => void continueMerge()}
                  disabled={busy}
                  data-testid="merge-continue"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : null}
                  {t('merge.continue')}
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('merge.target')}
                {lockTarget && defaultTarget !== null ? (
                  <span
                    className="mt-1.5 flex h-9 items-center rounded-md border border-border bg-muted/40 px-3 font-mono text-[12px] font-normal normal-case tracking-normal"
                    data-testid="merge-target"
                  >
                    {defaultTarget}
                  </span>
                ) : (
                  <select
                    className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-[12px] outline-none focus:border-accent"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    data-testid="merge-target"
                  >
                    {defaultTarget !== null &&
                    !options.some((entry) => entry.ref.name === defaultTarget) ? (
                      <option value={defaultTarget}>{defaultTarget}</option>
                    ) : null}
                    {options.map(({ ref, disabled }) => (
                      <option key={ref.name} value={ref.name} disabled={disabled}>
                        {ref.name}
                        {disabled ? ` · ${t('merge.targetInUse')}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <label className="block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('merge.message')}
                <textarea
                  className="mt-1.5 min-h-20 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-[12px] outline-none focus:border-accent"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={t('merge.messagePlaceholder')}
                  data-testid="merge-commit-message"
                />
                <span className="mt-1 block text-[10px] normal-case tracking-normal text-muted-foreground">
                  {t('merge.messageHint')}
                </span>
              </label>
              {error !== null ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-md border border-border px-3 text-[11px] hover:bg-muted"
                  onClick={onClose}
                  disabled={busy}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[11px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
                  onClick={() => void submit()}
                  disabled={busy || target.length === 0 || options.length === 0}
                  data-testid="merge-submit"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : null}
                  {t('merge.submit')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

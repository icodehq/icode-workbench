import { useEffect, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import type { AppError } from '../../../shared/domain/errors'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import { callApi } from '../lib/api'
import { useT } from '../i18n/use-i18n'

type RemotesPayload =
  | { status: 'ok'; remotes: string[] }
  | { status: 'unavailable'; reason: string; detail?: string }

type PushPayload =
  | { status: 'ok'; branch: string; remote: string; remoteBranch: string; upstream: string }
  | { status: 'unavailable'; reason: string; detail?: string }

type Props = {
  session: SessionSummary
  onClose: () => void
  onPushed: (upstream: string) => void
}

export default function PushDialog({
  session,
  onClose,
  onPushed
}: Props): React.JSX.Element {
  const t = useT()
  const [remotes, setRemotes] = useState<string[]>([])
  const [remote, setRemote] = useState('')
  const [branch, setBranch] = useState(session.worktree?.branch ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await callApi<RemotesPayload>(
        window.icode.git.remotes({ sessionId: session.id })
      )
      if (cancelled) return
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (result.value.status !== 'ok') {
        setError(result.value.detail ?? t('push.noRemotes'))
        return
      }
      setRemotes(result.value.remotes)
      setRemote(
        result.value.remotes.includes('origin')
          ? 'origin'
          : (result.value.remotes[0] ?? '')
      )
    })()
    return () => {
      cancelled = true
    }
  }, [session.id, t])

  const submit = async (): Promise<void> => {
    if (busy || remote.length === 0 || branch.trim().length === 0) return
    setBusy(true)
    setError(null)
    const result = await callApi<PushPayload>(
      window.icode.git.pushTo({
        sessionId: session.id,
        remote,
        branch: branch.trim()
      })
    )
    setBusy(false)
    if (!result.ok) {
      setError(errorText(result.error, t('push.error')))
      return
    }
    if (result.value.status !== 'ok') {
      setError(result.value.detail ?? t('push.error'))
      return
    }
    onPushed(result.value.upstream)
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('push.title')}
      data-testid="push-dialog"
    >
      <div className="icode-modal flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-[16px] font-semibold">
              <Upload size={15} />
              {t('push.title')}
            </h2>
            <p className="mt-1 text-[11px] text-muted-foreground">{t('push.subtitle')}</p>
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
          <label className="block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('push.remote')}
            <select
              className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-[12px] outline-none focus:border-accent"
              value={remote}
              onChange={(event) => setRemote(event.target.value)}
              data-testid="push-remote"
            >
              {remotes.length === 0 ? <option value="">{t('push.noRemotes')}</option> : null}
              {remotes.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('push.branch')}
            <input
              className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:border-accent"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              spellCheck={false}
              data-testid="push-branch"
            />
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
              disabled={busy || remote.length === 0 || branch.trim().length === 0}
              data-testid="push-submit"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              {t('push.submit')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function errorText(error: AppError, fallback: string): string {
  return error.message.length > 0 ? error.message : fallback
}

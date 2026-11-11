import { useEffect, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import type { MenuAnchor } from './context-menu-position'
import AnchoredPopover from './AnchoredPopover'
import { useT } from '../i18n/use-i18n'
import { pushDefaults } from '../scm/scm-push'

type Props = {
  anchor: MenuAnchor | null
  opener?: HTMLElement | null
  remotes: string[] | null
  remotesLoading: boolean
  upstream: string | null
  localBranch: string | null
  headOid: string | null
  onClose: () => void
  onSubmit: (remote: string, branch: string) => Promise<{ ok: boolean; message?: string }>
  onAddRemote: () => void
  onManageRemotes: () => void
}

export default function ScmPushPopover({
  anchor,
  opener,
  remotes,
  remotesLoading,
  upstream,
  localBranch,
  headOid,
  onClose,
  onSubmit,
  onAddRemote,
  onManageRemotes
}: Props): React.JSX.Element {
  const t = useT()
  const defaults = pushDefaults({ upstream, localBranch, headOid, remotes })
  const [remote, setRemote] = useState(() => (remotes === null ? '' : defaults.remote))
  const [branch, setBranch] = useState(() => (remotes === null ? '' : defaults.branch))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Start from the upstream/default remote once the remote list arrives.
  useEffect(() => {
    if (remotes === null || remotes.length === 0) return
    setRemote((current) =>
      current.length === 0 || !remotes.includes(current) ? defaults.remote : current
    )
    setBranch((current) => (current.length === 0 ? defaults.branch : current))
  }, [defaults.branch, defaults.remote, remotes])

  const blockedReason =
    remotes === null
      ? t('scm.push.loadingRemotes')
      : remotesLoading
        ? t('scm.push.loadingRemotes')
        : remotes.length === 0
          ? t('push.noRemotes')
          : headOid === null
            ? t('scm.push.unborn')
            : localBranch === null
              ? t('scm.push.detached')
              : remote.length === 0 || branch.trim().length === 0
                ? t('push.error')
                : null

  const submit = async (): Promise<void> => {
    if (busy || blockedReason !== null) return
    setBusy(true)
    setError(null)
    const result = await onSubmit(remote, branch.trim())
    setBusy(false)
    if (!result.ok) {
      setError(result.message ?? t('push.error'))
      return
    }
    onClose()
  }

  return (
    <AnchoredPopover
      anchor={anchor}
      opener={opener}
      ariaLabel={t('push.title')}
      testId="scm-push-popover"
      onClose={onClose}
    >
      <div className="px-1 pb-1">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <Upload size={14} />
          {t('push.title')}
        </h2>
        <p className="mt-1 text-[10.5px] text-muted-foreground">{t('push.subtitle')}</p>

        <label className="mt-3 block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('push.remote')}
          <select
            className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[11.5px] outline-none focus:border-accent disabled:opacity-60"
            value={remote}
            onChange={(event) => {
              setRemote(event.target.value)
              setError(null)
            }}
            disabled={blockedReason !== null || busy}
            data-testid="scm-push-remote"
          >
            {remotes === null || remotes.length === 0 ? (
              <option value="">{blockedReason ?? t('push.noRemotes')}</option>
            ) : null}
            {(remotes ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-2.5 block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('push.branch')}
          <input
            className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11.5px] outline-none focus:border-accent disabled:opacity-60"
            value={branch}
            onChange={(event) => {
              setBranch(event.target.value)
              setError(null)
            }}
            spellCheck={false}
            disabled={blockedReason !== null || busy}
            data-testid="scm-push-branch"
          />
        </label>

        {blockedReason === null ? (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            {t('scm.push.hint', {
              branch: localBranch ?? '',
              remote,
              remoteBranch: branch.trim()
            })}
          </p>
        ) : (
          <p
            className="mt-2 rounded border border-signal-line bg-signal-weak px-2 py-1 text-[10px] text-signal"
            data-testid="scm-push-blocked"
          >
            {blockedReason}
          </p>
        )}
        {remotes !== null && !remotesLoading && remotes.length === 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md border border-border px-2 text-[10.5px] hover:bg-muted"
              onClick={onAddRemote}
              data-testid="scm-push-add-remote"
            >
              {t('push.addRemote')}
            </button>
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md border border-border px-2 text-[10.5px] hover:bg-muted"
              onClick={onManageRemotes}
              data-testid="scm-push-manage-remotes"
            >
              {t('push.manageRemotes')}
            </button>
          </div>
        ) : null}
        {error !== null ? (
          <p
            className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10px] text-destructive"
            data-testid="scm-push-error"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-2">
          {remotes !== null && !remotesLoading && remotes.length > 0 ? (
            <button
              type="button"
              className="text-[10px] text-muted-foreground underline hover:text-foreground"
              onClick={onManageRemotes}
              data-testid="scm-push-manage-remotes"
            >
              {t('push.manageRemotes')}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[10.5px] hover:bg-muted disabled:opacity-40"
              onClick={onClose}
              disabled={busy}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[10.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              onClick={() => void submit()}
              disabled={busy || blockedReason !== null}
              data-testid="scm-push-submit"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : null}
              {t('push.submit')}
            </button>
          </div>
        </div>
      </div>
    </AnchoredPopover>
  )
}

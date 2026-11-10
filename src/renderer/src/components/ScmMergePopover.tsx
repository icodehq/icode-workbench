import { useEffect, useMemo, useState } from 'react'
import { GitMerge, Loader2 } from 'lucide-react'
import type { MenuAnchor } from './context-menu-position'
import AnchoredPopover from './AnchoredPopover'
import { useT } from '../i18n/use-i18n'
import type { MergeTargetResolution } from '../scm/scm-merge'

type Props = {
  anchor: MenuAnchor | null
  opener?: HTMLElement | null
  sourceBranch: string | null
  resolution: MergeTargetResolution
  /** A target selected by the request (Accept & merge) or the primary action. */
  initialTarget?: string | null
  lockTarget?: boolean
  clean: boolean
  onClose: () => void
  onSubmit: (target: string) => Promise<{ ok: boolean; message?: string }>
}

export default function ScmMergePopover({
  anchor,
  opener,
  sourceBranch,
  resolution,
  initialTarget = null,
  lockTarget = false,
  clean,
  onClose,
  onSubmit
}: Props): React.JSX.Element {
  const t = useT()
  const locked = lockTarget || resolution.locked
  const preferred = initialTarget ?? resolution.target
  const [target, setTarget] = useState(preferred ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (target.length === 0 && preferred !== null) setTarget(preferred)
  }, [preferred, target])

  const options = useMemo(() => {
    const list = resolution.options.filter((option) => option.name !== sourceBranch)
    if (
      preferred !== null &&
      preferred !== sourceBranch &&
      !list.some((option) => option.name === preferred)
    ) {
      return [
        ...list,
        {
          name: preferred,
          oid: resolution.targetOid ?? '',
          primaryHead: false,
          disabled: false,
          inUse: false,
          upToDate: false
        }
      ]
    }
    return list
  }, [preferred, resolution.options, resolution.targetOid, sourceBranch])

  const blockedReason =
    !clean
      ? t('scm.merge.dirty')
      : resolution.reason === 'loading'
        ? t('scm.merge.loadingTargets')
        : resolution.reason === 'no-target'
          ? t('scm.merge.noTargets')
          : resolution.reason === 'missing-target'
            ? t('scm.merge.targetMissing')
            : target.length === 0 || target === sourceBranch
              ? t('scm.merge.noTargets')
              : null

  const submit = async (): Promise<void> => {
    if (busy || blockedReason !== null || target.length === 0) return
    setBusy(true)
    setError(null)
    const result = await onSubmit(target)
    setBusy(false)
    if (!result.ok) {
      setError(result.message ?? t('merge.error'))
      return
    }
    onClose()
  }

  return (
    <AnchoredPopover
      anchor={anchor}
      opener={opener}
      ariaLabel={t('merge.title')}
      testId="scm-merge-popover"
      onClose={onClose}
    >
      <div className="px-1 pb-1">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <GitMerge size={14} />
          {t('merge.title')}
        </h2>
        <p className="mt-1 text-[10.5px] text-muted-foreground">
          {t('merge.subtitle', {
            source: sourceBranch ?? t('merge.unknownBranch')
          })}
        </p>

        <label className="mt-3 block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('merge.target')}
          {locked ? (
            <span
              className="mt-1.5 flex h-8 items-center rounded-md border border-border bg-muted/40 px-2.5 font-mono text-[11px] font-normal normal-case tracking-normal"
              data-testid="scm-merge-target"
            >
              {target}
            </span>
          ) : (
            <select
              className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[11.5px] outline-none focus:border-accent"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value)
                setError(null)
              }}
              data-testid="scm-merge-target"
            >
              {options.length === 0 ? <option value="">{t('scm.merge.noTargets')}</option> : null}
              {options.map((option) => (
                <option key={option.name} value={option.name} disabled={option.disabled}>
                  {option.name}
                  {option.inUse
                    ? ` · ${t('merge.targetInUse')}`
                    : option.upToDate
                      ? ` · ${t('scm.merge.targetUpToDate')}`
                      : ''}
                </option>
              ))}
            </select>
          )}
        </label>

        {locked ? (
          <p className="mt-1.5 text-[10px] text-signal">{t('scm.merge.lockedHint')}</p>
        ) : null}
        {clean ? (
          <p className="mt-1.5 text-[10px] text-muted-foreground">{t('scm.merge.cleanHint')}</p>
        ) : null}

        {blockedReason !== null ? (
          <p
            className="mt-2 rounded border border-signal-line bg-signal-weak px-2 py-1 text-[10px] text-signal"
            data-testid="scm-merge-blocked"
          >
            {blockedReason}
          </p>
        ) : null}
        {error !== null ? (
          <p
            className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10px] text-destructive"
            data-testid="scm-merge-error"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-3 flex justify-end gap-2">
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
            disabled={busy || blockedReason !== null || target.length === 0}
            data-testid="scm-merge-submit"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : null}
            {t('merge.submit')}
          </button>
        </div>
      </div>
    </AnchoredPopover>
  )
}

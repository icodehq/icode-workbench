import { AlertTriangle, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { localizeAppError } from '../../../shared/i18n'
import type { RepoRemovalJobSummary } from '../../../shared/schemas/repo-removal'
import { useLocale, useT } from '../i18n/use-i18n'
import AnchoredPopover from './AnchoredPopover'
import type { MenuAnchor } from './context-menu-position'

type Props = {
  jobs: RepoRemovalJobSummary[]
  onRetry: (jobId: string) => void
  onDiscard: (jobId: string) => void
}

/**
 * Non-blocking cleanup status. The project row disappears immediately; this
 * control reports what the background worker is still doing and offers the two
 * recovery actions: Retry and Discard snapshots.
 */
export default function CleanupIndicator({
  jobs,
  onRetry,
  onDiscard
}: Props): React.JSX.Element | null {
  const t = useT()
  const locale = useLocale()
  const trigger = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const [open, setOpen] = useState(false)

  if (jobs.length === 0) return null

  const failed = jobs.some(
    (job) => job.status === 'failed' || job.attentionCount > 0
  )
  const active = jobs.some(
    (job) =>
      job.status === 'queued' ||
      job.status === 'running' ||
      job.status === 'waiting_host'
  )
  const snapshots = jobs.some(
    (job) => job.status === 'completed' && job.snapshotCount > 0
  )
  const status = failed ? 'failed' : active ? 'active' : snapshots ? 'snapshots' : 'idle'
  const label = failed
    ? t('removal.indicatorFailed')
    : active
      ? t('removal.indicatorActive')
      : t('removal.indicatorSnapshots')

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={`inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 ${
          failed ? 'text-signal' : ''
        } hover:bg-muted`}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="cleanup-indicator"
        data-status={status}
        onClick={() => {
          setAnchor(trigger.current?.getBoundingClientRect() ?? null)
          setOpen((current) => !current)
        }}
      >
        {failed ? (
          <AlertTriangle size={11} />
        ) : (
          <Loader2 size={11} className={active ? 'animate-spin' : ''} />
        )}
        <span className="hidden sm:inline">{jobs.length}</span>
      </button>
      {open ? (
        <AnchoredPopover
          anchor={anchor}
          opener={trigger.current}
          ariaLabel={t('removal.popoverTitle')}
          testId="cleanup-popover"
          width={360}
          onClose={() => setOpen(false)}
        >
          <div className="p-3">
            <div className="mb-2 text-[12px] font-semibold">{t('removal.popoverTitle')}</div>
            <div className="space-y-2">
              {jobs.map((job) => {
                const localized =
                  job.error === null ? null : localizeAppError(job.error, locale)
                return (
                  <div
                    key={job.id}
                    className="rounded border border-border bg-background px-2.5 py-2"
                    data-testid={`cleanup-job-${job.id}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[12px] font-medium">
                        {job.repoName}
                      </span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t(`removal.status.${job.status}`)}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {t(`removal.stage.${job.stage}`)}
                      {job.worktreeCount > 0
                        ? ` · ${t('removal.worktrees', {
                            done: job.worktreeCount - job.attentionCount,
                            total: job.worktreeCount
                          })}`
                        : ''}
                    </div>
                    {job.snapshotCount > 0 ? (
                      <div className="mt-1 text-[11px] text-info">
                        {t('removal.snapshotsSaved', { count: job.snapshotCount })}
                      </div>
                    ) : null}
                    {localized !== null ? (
                      <div className="mt-1 text-[11px] text-signal" title={localized.detail}>
                        {localized.message}
                      </div>
                    ) : null}
                    <div className="mt-2 flex items-center gap-2">
                      {job.canRetry ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                          data-testid={`cleanup-retry-${job.id}`}
                          onClick={() => {
                            setOpen(false)
                            onRetry(job.id)
                          }}
                        >
                          <RotateCcw size={10} />
                          {t('removal.retry')}
                        </button>
                      ) : null}
                      {job.snapshotCount > 0 &&
                      (job.status === 'completed' || job.status === 'failed') ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-signal hover:bg-muted"
                          data-testid={`cleanup-discard-${job.id}`}
                          onClick={() => {
                            setOpen(false)
                            onDiscard(job.id)
                          }}
                        >
                          <Trash2 size={10} />
                          {t('removal.discardSnapshots')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground">
              {t('removal.branchesRetained')}
            </div>
          </div>
        </AnchoredPopover>
      ) : null}
    </>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { localizeAppError } from '../../../shared/i18n'
import type { RepoRemovalJobSummary } from '../../../shared/schemas/repo-removal'
import { getLocale } from '../i18n/i18n-store'
import { useT, useTp } from '../i18n/use-i18n'
import { callApi, errorNotice } from '../lib/api'
import type { Notice } from './workspace'

type Options = {
  notify: (notice: Notice) => void
  /** Called when the job set's status/stage/attention signature changes. */
  onChanged?: () => void
}

export type RemovalJobsState = {
  jobs: RepoRemovalJobSummary[]
  loading: boolean
  retry: (jobId: string) => Promise<void>
  discard: (jobId: string) => Promise<void>
}

/**
 * Loads durable cleanup jobs and keeps them current from the push-only
 * `removal-changed` event. The payload never carries state; this hook re-reads
 * so a missed event cannot leave a stale indicator.
 */
export function useRemovalJobs({ notify, onChanged }: Options): RemovalJobsState {
  const t = useT()
  const tp = useTp()
  const [jobs, setJobs] = useState<RepoRemovalJobSummary[]>([])
  const [loading, setLoading] = useState(true)
  const notified = useRef(new Set<string>())
  const lastSignature = useRef<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const result = await callApi(window.icode.repos.listRemovalJobs())
    if (!result.ok) {
      setLoading(false)
      return
    }
    const next = result.value.jobs
    setJobs(next)
    setLoading(false)

    const signature = next
      .map(
        (job) =>
          `${job.id}:${job.status}:${job.stage}:${job.snapshotCount}:${job.attentionCount}`
      )
      .join('|')
    if (lastSignature.current !== null && lastSignature.current !== signature) {
      onChanged?.()
    }
    lastSignature.current = signature

    for (const job of next) {
      const localized = job.error === null ? null : localizeAppError(job.error, getLocale())
      if (job.status === 'completed' && job.snapshotCount > 0) {
        const key = `snap:${job.id}`
        if (notified.current.has(key)) continue
        notified.current.add(key)
        notify({
          tone: 'info',
          message: tp('workspace.notice.recoverySnapshots', job.snapshotCount),
          detail: t('removal.snapshotsSavedDetail'),
          action: {
            label: t('removal.discardSnapshots'),
            run: () => {
              void (async () => {
                const discarded = await callApi(
                  window.icode.repos.discardRemovalSnapshots({ jobId: job.id })
                )
                if (!discarded.ok) {
                  notify(errorNotice(discarded.error))
                } else {
                  notify({
                    tone: 'success',
                    message: tp(
                      'workspace.notice.snapshotsDiscarded',
                      discarded.value.discarded
                    )
                  })
                }
                await reload()
              })()
            }
          }
        })
      } else if (job.status === 'failed' || job.attentionCount > 0) {
        const key = `attention:${job.id}`
        if (notified.current.has(key)) continue
        notified.current.add(key)
        notify({
          tone: 'error',
          message: t('removal.needsAttention'),
          ...(localized !== null
            ? { detail: localized.detail ?? localized.message }
            : {}),
          action: {
            label: t('removal.retry'),
            run: () => {
              void (async () => {
                const retried = await callApi(
                  window.icode.repos.retryRemoval({ jobId: job.id })
                )
                if (!retried.ok) notify(errorNotice(retried.error))
                await reload()
              })()
            }
          }
        })
      }
    }
  }, [notify, onChanged, t, tp])

  useEffect(() => {
    void reload()
    return window.icode.repos.onRemovalEvent(() => {
      void reload()
    })
  }, [reload])

  const retry = useCallback(
    async (jobId: string): Promise<void> => {
      const result = await callApi(window.icode.repos.retryRemoval({ jobId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      await reload()
    },
    [notify, reload]
  )

  const discard = useCallback(
    async (jobId: string): Promise<void> => {
      const result = await callApi(window.icode.repos.discardRemovalSnapshots({ jobId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      notify({
        tone: 'success',
        message: tp('workspace.notice.snapshotsDiscarded', result.value.discarded)
      })
      await reload()
    },
    [notify, reload, tp]
  )

  return { jobs, loading, retry, discard }
}

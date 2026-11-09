import { getLocale, translate } from '../i18n/i18n-store'
import { useT, useTp } from '../i18n/use-i18n'
import { useMemo, useState } from 'react'
import { Pause, Pencil, Play, Plus, RotateCcw } from 'lucide-react'
import type { TaskSchedulePayload } from '../../../shared/icode-api'
import { scheduleLabel } from '../../../shared/domain/task-schedule'
import { formatDateTime } from '../../../shared/i18n'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import { callApi, errorNotice } from '../lib/api'
import type { Notice } from '../state/workspace'
import ScheduleEditor from './ScheduleEditor'

type Props = {
  repos: RepositorySummary[]
  schedules: TaskSchedulePayload[]
  notify: (notice: Notice) => void
  onReload: () => Promise<void>
}

type EditorState = { mode: 'create' } | { mode: 'edit'; schedule: TaskSchedulePayload }

function repoName(repos: RepositorySummary[], id: string): string {
  return (
    repos.find((repo) => repo.id === id)?.displayName ?? translate('schedules.unknownProject')
  )
}

function nextRunLabel(schedule: TaskSchedulePayload): string {
  if (!schedule.enabled) return translate('schedules.paused')
  if (schedule.nextRunAt === null) return translate('schedules.noFutureRun')
  return formatDateTime(getLocale(), schedule.nextRunAt, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Schedules are global configuration, not project work.
 *
 * The list is a page; editing is a drawer because the form is long and the list
 * must stay visible behind it. A schedule never has a second execution path:
 * every occurrence is an ordinary task in the selected project.
 */
export default function SchedulesView({
  repos,
  schedules,
  notify,
  onReload
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const [repoFilter, setRepoFilter] = useState('all')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const filtered = useMemo(
    () => (repoFilter === 'all' ? schedules : schedules.filter((schedule) => schedule.repoId === repoFilter)),
    [repoFilter, schedules]
  )

  const toggle = async (schedule: TaskSchedulePayload): Promise<void> => {
    setBusyId(schedule.id)
    try {
      const result = await callApi<TaskSchedulePayload>(
        window.icode.schedules.setEnabled({ scheduleId: schedule.id, enabled: !schedule.enabled })
      )
      if (!result.ok) notify(errorNotice(result.error))
      else {
        notify({
          tone: 'info',
          message: schedule.enabled
            ? t('schedules.notice.paused', { title: schedule.title })
            : t('schedules.notice.resumed', { title: schedule.title })
        })
      }
      await onReload()
    } finally {
      setBusyId(null)
    }
  }

  const runNow = async (schedule: TaskSchedulePayload): Promise<void> => {
    setBusyId(schedule.id)
    try {
      const result = await callApi<{ result: string }>(
        window.icode.schedules.runNow({ scheduleId: schedule.id })
      )
      if (!result.ok) notify(errorNotice(result.error))
      else if (result.value.result === 'created') {
        notify({
          tone: 'success',
          message: t('schedules.notice.queued', { title: schedule.title })
        })
      } else {
        notify({
          tone: 'info',
          message: t('schedules.notice.nothingQueued', { result: result.value.result })
        })
      }
      await onReload()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="schedules-view">
      <div className="w-full px-5 py-5">
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <h1 className="text-[20px] font-semibold tracking-[-0.02em]">{t('schedules.title')}</h1>
            <p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-muted-foreground">
              {t('schedules.subtitle')}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10.5px] text-muted-foreground">
              {tp('schedules.count', filtered.length)}
            </span>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[11px] font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => setEditor({ mode: 'create' })}
              disabled={repos.length === 0}
              title={
                repos.length === 0 ? t('schedules.addRepoFirst') : t('schedules.createTitle')
              }
              data-testid="schedule-new"
            >
              <Plus size={12} />
              {t('schedules.new')}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label htmlFor="schedule-repo-filter" className="sr-only">
            {t('schedules.filterAria')}
          </label>
          <select
            id="schedule-repo-filter"
            value={repoFilter}
            onChange={(event) => setRepoFilter(event.target.value)}
            className="h-8 rounded-md border border-border bg-card px-2 text-[10.5px] text-foreground"
            data-testid="schedule-repo-filter"
          >
            <option value="all">{t('schedules.allRepos')}</option>
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.displayName}
              </option>
            ))}
          </select>
          {repoFilter !== 'all' ? (
            <button
              type="button"
              className="text-[10px] text-accent hover:underline"
              onClick={() => setRepoFilter('all')}
            >
              {t('schedules.showAll')}
            </button>
          ) : null}
        </div>

        {schedules.length === 0 ? (
          <div
            className="mt-5 rounded-lg border border-dashed border-border bg-card/50 px-5 py-8 text-center"
            data-testid="schedules-empty"
          >
            <p className="text-[12px] text-muted-foreground">
              {t('schedules.empty')}
            </p>
            <button
              type="button"
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[10.5px] hover:bg-muted disabled:opacity-40"
              onClick={() => setEditor({ mode: 'create' })}
              disabled={repos.length === 0}
            >
              <Plus size={11} />
              {t('schedules.new')}
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="mt-5 rounded-lg border border-dashed border-border bg-card/50 px-4 py-6 text-[11.5px] text-muted-foreground">
            {t('schedules.emptyRepo')}
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {filtered.map((schedule) => (
              <li
                key={schedule.id}
                className="rounded-lg border border-border bg-card px-4 py-3"
                data-testid={`schedule-row-${schedule.id}`}
              >
                <div className="grid items-center gap-3 min-[900px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] font-semibold text-foreground">
                      {schedule.title}
                    </p>
                    <p className="mt-1 truncate text-[10.5px] text-muted-foreground">
                      {repoName(repos, schedule.repoId)} · {schedule.harness} ·{' '}
                      {schedule.lastNote ?? t('schedules.noRuns')}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[11px] text-foreground">{scheduleLabel(schedule.shape, getLocale())}</p>
                    <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                      {schedule.enabled
                        ? t('schedules.next', { time: nextRunLabel(schedule) })
                        : nextRunLabel(schedule)}{' '}
                      ·{' '}
                      {schedule.overlap === 'queue'
                        ? t('schedules.queuesIfBusy')
                        : t('schedules.skipsIfBusy')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[9.5px] ${
                        schedule.enabled
                          ? 'border-add/50 bg-add-weak text-add'
                          : 'border-border bg-muted text-muted-foreground'
                      }`}
                      data-testid={`schedule-state-${schedule.id}`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      {schedule.enabled ? t('schedules.enabled') : t('schedules.paused')}
                    </span>
                    <button
                      type="button"
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[10.5px] text-foreground hover:bg-muted disabled:opacity-40"
                      title={t('schedules.runNow')}
                      onClick={() => void runNow(schedule)}
                      disabled={busyId === schedule.id}
                      data-testid={`schedule-run-${schedule.id}`}
                    >
                      <RotateCcw size={11} />
                      {t('schedules.runNow')}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                      title={schedule.enabled ? t('schedules.pause') : t('schedules.resume')}
                      onClick={() => void toggle(schedule)}
                      disabled={busyId === schedule.id}
                      data-testid={`schedule-toggle-${schedule.id}`}
                    >
                      {schedule.enabled ? <Pause size={12} /> : <Play size={12} />}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                      title={t('schedules.edit')}
                      aria-label={t('schedules.editAria', { title: schedule.title })}
                      onClick={() => setEditor({ mode: 'edit', schedule })}
                      data-testid={`schedule-edit-${schedule.id}`}
                    >
                      <Pencil size={12} />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editor !== null ? (
        <ScheduleEditor
          mode={editor.mode}
          schedule={editor.mode === 'edit' ? editor.schedule : null}
          repos={repos}
          notify={notify}
          onClose={() => setEditor(null)}
          onSaved={onReload}
        />
      ) : null}
    </div>
  )
}

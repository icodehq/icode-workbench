import { getLocale, translate } from '../i18n/i18n-store'
import { useT } from '../i18n/use-i18n'
import { formatDateTime } from '../../../shared/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Trash2, X } from 'lucide-react'
import type { TaskSchedulePayload } from '../../../shared/icode-api'
import type { HarnessDetection, HarnessId } from '../../../shared/domain/harness'
import {
  nextOccurrence,
  scheduleLabel,
  type ScheduleOverlapPolicy,
  type ScheduleType,
  type TaskScheduleShape
} from '../../../shared/domain/task-schedule'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import { callApi, errorNotice } from '../lib/api'
import type { Notice } from '../state/workspace'

type ShapeKind = ScheduleType
type Every = 1 | 2 | 3 | 4 | 6 | 8 | 12

type Props = {
  mode: 'create' | 'edit'
  schedule: TaskSchedulePayload | null
  repos: RepositorySummary[]
  notify: (notice: Notice) => void
  onClose: () => void
  onSaved: () => Promise<void>
}

function toLocalInput(instant: number | undefined): string {
  if (instant === undefined) return ''
  const date = new Date(instant)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatInstant(instant: number | null): string {
  if (instant === null) return translate('schedules.noFutureRun')
  return formatDateTime(getLocale(), instant, {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function FieldLabel({
  htmlFor,
  children,
  hint
}: {
  htmlFor: string
  children: React.ReactNode
  hint?: string
}): React.JSX.Element {
  return (
    <label htmlFor={htmlFor} className="block text-[11px] font-medium text-foreground">
      {children}
      {hint ? <span className="ml-1 font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  )
}

/**
 * Create/edit drawer for a schedule.
 *
 * Editing uses the same fields and pure scheduler math as creation, so the next
 * run preview cannot drift from what the timer will do. Occurrences already
 * created are never removed here; deleting a schedule leaves its tasks.
 */
export default function ScheduleEditor({
  mode,
  schedule,
  repos,
  notify,
  onClose,
  onSaved
}: Props): React.JSX.Element {
  const t = useT()
  const [repoId, setRepoId] = useState(schedule?.repoId ?? repos[0]?.id ?? '')
  const [title, setTitle] = useState(schedule?.title ?? '')
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '')
  const [harness, setHarness] = useState<HarnessId>((schedule?.harness as HarnessId | undefined) ?? 'claude')
  const [shapeKind, setShapeKind] = useState<ShapeKind>(schedule?.shape.type ?? 'daily')
  const [hour, setHour] = useState(schedule?.shape.hour ?? 4)
  const [minute, setMinute] = useState(schedule?.shape.minute ?? 0)
  const [day, setDay] = useState(schedule?.shape.day ?? 1)
  const [every, setEvery] = useState<Every>((schedule?.shape.every as Every | undefined) ?? 6)
  const [runAt, setRunAt] = useState(toLocalInput(schedule?.shape.runAt))
  const [overlap, setOverlap] = useState<ScheduleOverlapPolicy>(schedule?.overlap ?? 'queue')
  const [harnesses, setHarnesses] = useState<HarnessDetection[]>([])
  const [harnessLoading, setHarnessLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  useEffect(() => {
    if (repoId === '') {
      setHarnesses([])
      return
    }
    let cancelled = false
    setHarnessLoading(true)
    void callApi<HarnessDetection[]>(window.icode.harness.list({ repoId })).then((result) => {
      if (cancelled) return
      setHarnessLoading(false)
      if (!result.ok) {
        notify(errorNotice(result.error))
        setHarnesses([])
        return
      }
      setHarnesses(result.value)
      const available = result.value.filter((entry) => entry.state === 'available')
      setHarness((current) =>
        available.some((entry) => entry.harness === current)
          ? current
          : ((available[0]?.harness as HarnessId | undefined) ?? current)
      )
    })
    return () => {
      cancelled = true
    }
  }, [notify, repoId])

  const shape = useMemo<TaskScheduleShape>(() => {
    if (shapeKind === 'once') {
      const instant = runAt.trim().length > 0 ? new Date(runAt).getTime() : NaN
      return Number.isFinite(instant) ? { type: 'once', runAt: instant } : { type: 'once' }
    }
    if (shapeKind === 'hours') return { type: 'hours', every }
    if (shapeKind === 'weekly') return { type: 'weekly', day, hour, minute }
    return { type: shapeKind, hour, minute }
  }, [day, every, hour, minute, runAt, shapeKind])

  const availableHarnesses = harnesses.filter((entry) => entry.state === 'available')
  const nextRun = shapeKind === 'once' ? (shape.runAt ?? null) : nextOccurrence(shape, Date.now())
  const promptProblem =
    prompt.trim().length === 0 ? t('schedules.editor.promptRequired') : null
  const runAtProblem =
    shapeKind === 'once' && (runAt.trim().length === 0 || !Number.isFinite(shape.runAt))
      ? t('schedules.editor.timeRequired')
      : null
  const repoProblem =
    repoId.length === 0 ? t('schedules.editor.repoRequired') : null
  const harnessProblem =
    harnessLoading || availableHarnesses.length === 0
      ? t('schedules.editor.harnessRequired')
      : null
  const canSave =
    !busy && promptProblem === null && runAtProblem === null && repoProblem === null && harnessProblem === null

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    const input = {
      repoId,
      prompt: prompt.trim(),
      ...(title.trim().length > 0 ? { title: title.trim() } : {}),
      harness,
      shape,
      overlap
    }
    try {
      const result =
        mode === 'edit' && schedule !== null
          ? await callApi<TaskSchedulePayload>(
              window.icode.schedules.update({ scheduleId: schedule.id, ...input })
            )
          : await callApi<TaskSchedulePayload>(window.icode.schedules.create(input))
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      notify({
        tone: 'success',
        message:
          mode === 'edit'
            ? t('schedules.editor.saved', { title: result.value.title })
            : t('schedules.editor.created', { title: result.value.title })
      })
      await onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (mode !== 'edit' || schedule === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await callApi<null>(window.icode.schedules.remove({ scheduleId: schedule.id }))
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      notify({
        tone: 'success',
        message: t('schedules.editor.deleted', { title: schedule.title })
      })
      await onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[65] bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label={
        mode === 'edit' ? t('schedules.editor.editTitle') : t('schedules.editor.newTitle')
      }
      data-testid="schedule-editor"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <aside className="icode-drawer absolute bottom-3 right-3 top-3 flex w-[min(480px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-[var(--icode-shadow-overlay)]">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">
              {mode === 'edit' ? t('schedules.editor.editTitle') : t('schedules.editor.newTitle')}
            </h2>
            <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
              {t('schedules.editor.subtitle')}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            disabled={busy}
            aria-label={t('schedules.editor.close')}
          >
            <X size={14} />
          </button>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-4">
            <div>
              <FieldLabel htmlFor="schedule-title" hint={t('schedules.editor.optional')}>
                {t('schedules.editor.name')}
              </FieldLabel>
              <input
                ref={titleRef}
                id="schedule-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t('schedules.editor.namePlaceholder')}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground"
                data-testid="schedule-title"
              />
            </div>

            <div>
              <FieldLabel htmlFor="schedule-prompt">{t('schedules.editor.instruction')}</FieldLabel>
              <textarea
                id="schedule-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={t('schedules.editor.instructionPlaceholder')}
                className="mt-1 h-24 w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-[11.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
                data-testid="schedule-prompt"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <FieldLabel htmlFor="schedule-repo">{t('schedules.editor.repository')}</FieldLabel>
                <select
                  id="schedule-repo"
                  value={repoId}
                  onChange={(event) => setRepoId(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
                  data-testid="schedule-repo"
                >
                  {repos.length === 0 ? <option value="">{t('schedules.editor.noProject')}</option> : null}
                  {repos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel htmlFor="schedule-harness">{t('schedules.editor.harness')}</FieldLabel>
                <select
                  id="schedule-harness"
                  value={harness}
                  onChange={(event) => setHarness(event.target.value as HarnessId)}
                  disabled={harnessLoading}
                  className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground disabled:opacity-50"
                  data-testid="schedule-harness"
                >
                  {harnessLoading ? <option>{t('schedules.editor.detecting')}</option> : null}
                  {!harnessLoading && harnesses.length === 0 ? (
                    <option value="">{t('schedules.editor.noHarness')}</option>
                  ) : null}
                  {harnesses.map((entry) => (
                    <option key={entry.harness} value={entry.harness} disabled={entry.state !== 'available'}>
                      {entry.harness}
                      {entry.state === 'available' ? '' : t('schedules.editor.unavailable')}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <FieldLabel htmlFor="schedule-cadence">{t('schedules.editor.cadence')}</FieldLabel>
              <select
                id="schedule-cadence"
                value={shapeKind}
                onChange={(event) => setShapeKind(event.target.value as ShapeKind)}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
                data-testid="schedule-shape"
              >
                <option value="once">{t('schedules.editor.once')}</option>
                <option value="daily">{t('schedules.editor.daily')}</option>
                <option value="weekdays">{t('schedules.editor.weekdays')}</option>
                <option value="weekly">{t('schedules.editor.weekly')}</option>
                <option value="hours">{t('schedules.editor.hours')}</option>
              </select>
            </div>

            {shapeKind === 'once' ? (
              <div>
                <FieldLabel htmlFor="schedule-once">{t('schedules.editor.dateTime')}</FieldLabel>
                <input
                  id="schedule-once"
                  type="datetime-local"
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
                  data-testid="schedule-run-at"
                />
              </div>
            ) : shapeKind === 'hours' ? (
              <div>
                <FieldLabel htmlFor="schedule-every">{t('schedules.editor.every')}</FieldLabel>
                <select
                  id="schedule-every"
                  value={every}
                  onChange={(event) => setEvery(Number(event.target.value) as Every)}
                  className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
                  data-testid="schedule-every"
                >
                  {[1, 2, 3, 4, 6, 8, 12].map((value) => (
                    <option key={value} value={value}>
                      {t('schedules.editor.hoursCount', { count: value })}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <FieldLabel htmlFor="schedule-hour">{t('schedules.editor.hour')}</FieldLabel>
                  <input
                    id="schedule-hour"
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(event) => setHour(Number(event.target.value))}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
                    data-testid="schedule-hour"
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="schedule-minute">{t('schedules.editor.minute')}</FieldLabel>
                  <input
                    id="schedule-minute"
                    type="number"
                    min={0}
                    max={59}
                    value={minute}
                    onChange={(event) => setMinute(Number(event.target.value))}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
                    data-testid="schedule-minute"
                  />
                </div>
                {shapeKind === 'weekly' ? (
                  <div>
                    <FieldLabel htmlFor="schedule-day">{t('schedules.editor.day')}</FieldLabel>
                    <select
                      id="schedule-day"
                      value={day}
                      onChange={(event) => setDay(Number(event.target.value))}
                      className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
                      data-testid="schedule-day"
                    >
                      {Array.from({ length: 7 }, (_, index) =>
                        new Intl.DateTimeFormat(getLocale(), { weekday: 'short' }).format(
                          new Date(2024, 0, index + 1)
                        )
                      ).map((name, index) => (
                        <option key={name} value={index + 1}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="col-span-1" />
                )}
              </div>
            )}

            <div>
              <FieldLabel htmlFor="schedule-overlap">{t('schedules.editor.overlap')}</FieldLabel>
              <select
                id="schedule-overlap"
                value={overlap}
                onChange={(event) => setOverlap(event.target.value as ScheduleOverlapPolicy)}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
                data-testid="schedule-overlap"
              >
                <option value="queue">{t('schedules.editor.queue')}</option>
                <option value="skip">{t('schedules.editor.skip')}</option>
              </select>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                {t('schedules.editor.overlapHelp')}
              </p>
            </div>

            <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('schedules.editor.schedule')}
              </p>
              <p className="mt-1 text-[11.5px] text-foreground">{scheduleLabel(shape, getLocale())}</p>
              <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                {schedule?.enabled === false
                  ? t('schedules.editor.pausedHelp')
                  : t('schedules.editor.nextRun', { time: formatInstant(nextRun) })}
              </p>
            </div>

            {promptProblem || runAtProblem || repoProblem || harnessProblem ? (
              <p className="text-[10.5px] text-signal" data-testid="schedule-form-hint">
                {promptProblem ?? runAtProblem ?? repoProblem ?? harnessProblem}
              </p>
            ) : null}
            {error ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[10.5px] text-destructive" data-testid="schedule-form-error">
                {error}
              </p>
            ) : null}

            {mode === 'edit' && schedule !== null ? (
              <div className="border-t border-border pt-3">
                {confirmDelete ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2" data-testid="schedule-delete-confirm">
                    <p className="text-[10.5px] leading-relaxed text-destructive">
                      {t('schedules.editor.deleteConfirm', { title: schedule.title })}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-md border border-destructive/60 px-2.5 py-1 text-[10.5px] text-destructive hover:bg-destructive/15 disabled:opacity-40"
                        onClick={() => void remove()}
                        disabled={busy}
                        data-testid="schedule-delete"
                      >
                        {busy ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                        {t('schedules.editor.delete')}
                      </button>
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-[10.5px] text-muted-foreground hover:text-foreground"
                        onClick={() => setConfirmDelete(false)}
                        disabled={busy}
                      >
                        {t('schedules.editor.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] text-destructive hover:bg-destructive/10"
                    onClick={() => setConfirmDelete(true)}
                    disabled={busy}
                    data-testid="schedule-delete-ask"
                  >
                    <Trash2 size={10} />
                    {t('schedules.editor.delete')}
                  </button>
                )}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2 border-t border-border bg-card px-4 py-2.5">
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted"
              onClick={onClose}
              disabled={busy}
            >
              {t('schedules.editor.cancel')}
            </button>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {mode === 'edit'
                ? t('schedules.editor.keepTasks')
                : t('schedules.editor.createsTask')}
            </span>
            <button
              type="submit"
              className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!canSave}
              data-testid="schedule-save"
            >
              {busy
                ? t('schedules.editor.saving')
                : mode === 'edit'
                  ? t('schedules.editor.save')
                  : t('schedules.editor.add')}
            </button>
          </div>
        </form>
      </aside>
    </div>
  )
}

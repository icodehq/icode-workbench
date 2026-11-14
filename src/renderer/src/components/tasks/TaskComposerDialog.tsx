import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, Loader2, Plus, X } from 'lucide-react'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { HarnessDetection } from '../../../../shared/domain/harness'
import type { RepositorySummary } from '../../../../shared/schemas/ipc'
import type { Notice } from '../../state/workspace'
import { callApi, errorNotice } from '../../lib/api'
import { repositoryPreparationView } from '../../lib/repository-preparation'
import { useBranchRefs } from '../../state/use-branch-refs'
import { useT } from '../../i18n/use-i18n'

type Props = {
  repo: RepositorySummary
  /** Active tasks in this repository, used for blockers. */
  tasks: TaskRecordPayload[]
  notify: (notice: Notice) => void
  initialAfterTaskId?: string | null
  onClose: () => void
  onCreated: (task: TaskRecordPayload) => void
}

/**
 * One task-composer dialog for the whole shell. The fields and payload are the
 * ones the inline composer used: harness, prompt, blockers, hold-dependents,
 * base ref and chain branch. Nothing about dispatch moves here.
 */
export default function TaskComposerDialog({
  repo,
  tasks,
  notify,
  initialAfterTaskId = null,
  onClose,
  onCreated
}: Props): React.JSX.Element {
  const t = useT()
  const [prompt, setPrompt] = useState('')
  const [harness, setHarness] = useState('claude')
  const [after, setAfter] = useState<string[]>(() =>
    initialAfterTaskId ? [initialAfterTaskId] : []
  )
  const [holdDependents, setHoldDependents] = useState(false)
  const [startFrom, setStartFrom] = useState('')
  const [chainBranchName, setChainBranchName] = useState('')
  const [harnesses, setHarnesses] = useState<HarnessDetection[]>([])
  const [harnessLoading, setHarnessLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const afterSelectRef = useRef<HTMLSelectElement | null>(null)
  const branchRefs = useBranchRefs(repo.id)
  const preparation = repositoryPreparationView(repo)

  const projectTasks = useMemo(
    () => tasks.filter((task) => task.repoId === repo.id),
    [repo.id, tasks]
  )
  const afterCandidates = useMemo(
    () => projectTasks.filter((task) => !after.includes(task.id)),
    [after, projectTasks]
  )
  const afterTasks = after
    .map((id) => projectTasks.find((task) => task.id === id))
    .filter((task): task is TaskRecordPayload => task !== undefined)
  const inheritedChains = useMemo(
    () => [
      ...new Set(
        afterTasks
          .map((task) => task.chainBranch)
          .filter((branch): branch is string => typeof branch === 'string' && branch.length > 0)
      )
    ],
    [afterTasks]
  )
  const inheritedChain = inheritedChains.length === 1 ? inheritedChains[0]! : null
  const chainConflict = inheritedChains.length > 1

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => promptRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  useEffect(() => {
    let cancelled = false
    setHarnessLoading(true)
    void callApi<HarnessDetection[]>(window.icode.harness.list({ repoId: repo.id })).then((result) => {
      if (cancelled) return
      setHarnessLoading(false)
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      setHarnesses(result.value)
      const available = result.value.filter((entry) => entry.state === 'available')
      setHarness((current) =>
        available.some((entry) => entry.harness === current)
          ? current
          : (available[0]?.harness ?? current)
      )
    })
    return () => {
      cancelled = true
    }
  }, [notify, repo.id])

  const submit = useCallback(async (): Promise<void> => {
    if (prompt.trim().length === 0 || chainConflict || busy || preparation !== null) return
    setBusy(true)
    try {
      const result = await callApi<TaskRecordPayload>(
        window.icode.tasks.create({
          repoId: repo.id,
          prompt: prompt.trim(),
          harness: harness as never,
          ...(after.length > 0 ? { dependsOn: after } : {}),
          ...(holdDependents ? { holdDependents: true } : {}),
          ...(startFrom.length > 0 ? { startFrom } : {}),
          ...(!inheritedChain && chainBranchName.trim().length > 0
            ? { branchName: chainBranchName.trim() }
            : {})
        })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      notify({
        tone: 'success',
        message: t('tasks.notice.queued', { title: result.value.title })
      })
      onCreated(result.value)
    } finally {
      setBusy(false)
    }
  }, [
    after,
    busy,
    chainBranchName,
    chainConflict,
    harness,
    holdDependents,
    inheritedChain,
    notify,
    onCreated,
    preparation,
    prompt,
    repo.id,
    startFrom,
    t
  ])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('tasks.queue')}
      data-testid="task-composer-dialog"
    >
      <form
        className="icode-modal flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        data-testid="task-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
              {repo.displayName} · {repo.currentBranch ?? 'HEAD'}
            </p>
            <h2 className="mt-1 text-[16px] font-semibold">{t('tasks.queue')}</h2>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid="task-composer-close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              className="h-8 rounded border border-border bg-background px-2 text-[11px]"
              value={harness}
              onChange={(event) => setHarness(event.target.value)}
              disabled={harnessLoading}
              aria-label={t('tasks.composer.harness')}
              data-testid="task-harness"
            >
              {harnesses.length === 0 ? (
                <option value="">{t('tasks.composer.noHarness')}</option>
              ) : null}
              {harnesses.map((entry) => (
                <option key={entry.harness} value={entry.harness} disabled={entry.state !== 'available'}>
                  {entry.harness}
                  {entry.state === 'available' ? '' : t('tasks.composer.unavailable')}
                </option>
              ))}
            </select>
            <span className="text-[9px] text-muted-foreground">
              {harnessLoading ? t('tasks.composer.detecting') : t('tasks.composer.runsOwn')}
            </span>
          </div>

          <textarea
            ref={promptRef}
            className="mt-2 h-28 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-accent"
            placeholder={t('tasks.composer.placeholder')}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
            data-testid="task-prompt"
          />

          <div className="mt-2 rounded-md border border-border bg-background px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('tasks.composer.after')}
              </span>
              {afterTasks.length === 0 ? (
                <span className="text-[9.5px] text-muted-foreground">
                  {t('tasks.composer.afterNone')}
                </span>
              ) : (
                afterTasks.map((task) => (
                  <span
                    key={task.id}
                    className="inline-flex max-w-[180px] items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[9.5px]"
                  >
                    <span className="truncate">{task.title}</span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t('tasks.composer.removeBlocker', { title: task.title })}
                      onClick={() => setAfter((current) => current.filter((id) => id !== task.id))}
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
            {afterCandidates.length > 0 ? (
              <div className="mt-1.5 flex items-center gap-1.5">
                <select
                  ref={afterSelectRef}
                  className="h-8 min-w-0 flex-1 rounded border border-border bg-card px-2 text-[10.5px]"
                  aria-label={t('tasks.composer.blocker')}
                  data-testid="task-after"
                >
                  {afterCandidates.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="h-8 shrink-0 rounded border border-border px-2 text-[10px] hover:bg-muted"
                  onClick={() => {
                    const id = afterSelectRef.current?.value
                    if (!id) return
                    setAfter((current) => (current.includes(id) ? current : [...current, id]))
                  }}
                  data-testid="task-after-add"
                >
                  {t('tasks.composer.addBlocker')}
                </button>
              </div>
            ) : null}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('tasks.composer.startFrom')}
              <select
                className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-[10.5px] font-normal normal-case tracking-normal"
                value={startFrom}
                onChange={(event) => setStartFrom(event.target.value)}
                disabled={branchRefs.loading}
                data-testid="task-start-from"
              >
                <option value="">
                  {t('tasks.composer.startFromCurrent', { branch: repo.currentBranch ?? 'HEAD' })}
                </option>
                {branchRefs.refs.map((ref) => (
                  <option key={ref.name} value={ref.name} disabled={ref.worktreePath !== null}>
                    {ref.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('tasks.composer.chainBranch')}
              {inheritedChain !== null ? (
                <span
                  className="mt-1 flex h-8 items-center gap-1 rounded border border-border bg-muted/40 px-2 font-mono text-[9.5px] font-normal normal-case tracking-normal"
                  title={inheritedChain}
                  data-testid="task-chain-inherited"
                >
                  <GitBranch size={9} />
                  <span className="truncate">{inheritedChain}</span>
                </span>
              ) : (
                <input
                  className="mt-1 h-8 w-full rounded border border-border bg-background px-2 font-mono text-[9.5px] font-normal normal-case tracking-normal outline-none focus:border-accent"
                  value={chainBranchName}
                  onChange={(event) => setChainBranchName(event.target.value)}
                  placeholder={t('tasks.composer.chainPlaceholder')}
                  spellCheck={false}
                  data-testid="task-chain-branch"
                />
              )}
            </label>
          </div>
          {chainConflict ? (
            <p className="mt-1 text-[9.5px] text-destructive" data-testid="task-chain-conflict">
              {t('tasks.composer.chainConflict')}
            </p>
          ) : null}
          <label className="mt-2 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <input
              type="checkbox"
              className="accent-accent"
              checked={holdDependents}
              onChange={(event) => setHoldDependents(event.target.checked)}
              data-testid="task-hold-dependents"
            />
            {t('tasks.composer.holdDependents')}
          </label>
          {preparation !== null ? (
            <p className="mt-2 rounded border border-signal-line bg-signal-weak px-2 py-1.5 text-[10px] text-signal">
              {preparation.kind === 'failed'
                ? t('tasks.composer.retryFirstCommit')
                : t('tasks.composer.unlock')}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
          <button
            type="submit"
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[11.5px] font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={
              busy ||
              prompt.trim().length === 0 ||
              harnesses.length === 0 ||
              chainConflict ||
              preparation !== null
            }
            data-testid="task-create"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
            {t('tasks.composer.add')}
          </button>
          <button
            type="button"
            className="ml-auto h-9 rounded-md border border-border px-3 text-[11px] hover:bg-muted"
            onClick={onClose}
            disabled={busy}
          >
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </div>
  )
}

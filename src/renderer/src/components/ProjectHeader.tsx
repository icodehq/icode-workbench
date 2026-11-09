import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ListTodo, Loader2, RotateCcw, TerminalSquare } from 'lucide-react'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import type { ProjectMode } from '../router/routes'
import { repositoryPreparationView } from '../lib/repository-preparation'
import TargetBadge from './TargetBadge'
import AssistantAvatar from './AssistantAvatar'
import type { AssistantStatus } from '../../../shared/domain/assistant'
import { useT, useTp } from '../i18n/use-i18n'

export type ProjectStat = {
  sessions: number
  live: number
  tasks: number
  needs: number
}

type Props = {
  repos: RepositorySummary[]
  repo: RepositorySummary
  mode: ProjectMode
  stats: Record<string, ProjectStat>
  onBack: () => void
  onSwitch: (repoId: string) => void
  onMode: (mode: ProjectMode) => void
  onRetryPreparation: (repoId: string) => void
  assistantName: string
  assistantUnread: number
  assistantStatus: AssistantStatus
  pendingProposals: number
  onOpenAssistant: () => void
}

function ProjectSwitcher({
  repos,
  repo,
  stats,
  onSwitch
}: {
  repos: RepositorySummary[]
  repo: RepositorySummary
  stats: Record<string, ProjectStat>
  onSwitch: (repoId: string) => void
}): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (wrap.current?.contains(event.target) !== true) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 text-[12px] font-medium text-foreground hover:bg-muted"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={t('projectHeader.switch')}
        data-testid="project-switcher"
      >
        <span className="min-w-0 truncate">{repo.displayName}</span>
        <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+5px)] z-30 w-72 rounded-md border border-border bg-card p-1 shadow-2xl"
          role="dialog"
          aria-label={t('projectHeader.switch')}
          data-testid="project-switcher-menu"
        >
          <p className="px-2 py-1 text-[9px] uppercase tracking-wide text-muted-foreground">
            {t('projectHeader.switch')}
          </p>
          {repos.map((entry) => {
            const stat = stats[entry.id]
            return (
              <button
                key={entry.id}
                type="button"
                className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left ${
                  entry.id === repo.id ? 'bg-muted text-foreground' : 'hover:bg-muted/60'
                }`}
                onClick={() => {
                  setOpen(false)
                  onSwitch(entry.id)
                }}
                data-testid={`project-option-${entry.id}`}
              >
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px]">{entry.displayName}</span>
                  <span className="block truncate text-[9px] text-muted-foreground">
                    {t('projectHeader.switcher.summary', {
                      target:
                        entry.target.kind === 'wsl'
                          ? `WSL ${entry.target.distro}`
                          : t('projects.target.local'),
                      branch: entry.currentBranch ?? t('projectHeader.noBranch'),
                      stats: stat
                        ? ` · ${t('projectHeader.switcher.live', { count: stat.live })} · ${tp('projectHeader.switcher.tasks', stat.tasks)}`
                        : ''
                    })}
                  </span>
                </span>
                {stat && stat.needs > 0 ? (
                  <span className="mt-0.5 shrink-0 rounded-full bg-signal-weak px-1.5 py-0.5 text-[8px] text-signal">
                    {t('projectHeader.switcher.needs', { count: stat.needs })}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The only project-scoped navigation surface.
 *
 * It has a back link to the wall, a project switcher that never offers
 * "All projects", and the two modes. The command bar above it stays global.
 */
export default function ProjectHeader({
  repos,
  repo,
  mode,
  stats,
  onBack,
  onSwitch,
  onMode,
  onRetryPreparation,
  assistantName,
  assistantUnread,
  assistantStatus,
  pendingProposals,
  onOpenAssistant
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const current = stats[repo.id] ?? { sessions: 0, live: 0, tasks: 0, needs: 0 }
  const preparation = repositoryPreparationView(repo)
  return (
    <header
      className="relative z-20 flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border bg-card px-4 py-2"
      data-testid="project-header"
      data-project-id={repo.id}
      data-project-mode={mode}
    >
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onBack}
        data-testid="project-back"
      >
        <ArrowLeft size={11} />
        {t('projectHeader.back')}
      </button>

      <ProjectSwitcher repos={repos} repo={repo} stats={stats} onSwitch={onSwitch} />

      <span className="hidden items-center gap-1.5 text-[10.5px] text-muted-foreground sm:inline-flex">
        <TargetBadge repo={repo} compact />
        <span className="font-mono">
          {preparation?.kind === 'preparing'
            ? t('projects.preparation.preparing')
            : repo.currentBranch ?? t('projectHeader.noBranch')}
        </span>
      </span>

      {preparation !== null ? (
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9.5px] ${
            preparation.kind === 'failed'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-signal-line bg-signal-weak text-signal'
          }`}
          data-testid="project-preparation-status"
        >
          {preparation.kind === 'preparing' ? (
            <Loader2 size={9} className="animate-spin" />
          ) : null}
          {preparation.label}
          {preparation.kind === 'failed' ? (
            <button
              type="button"
              className="ml-1 inline-flex items-center gap-0.5 underline underline-offset-2"
              onClick={() => onRetryPreparation(repo.id)}
              data-testid="project-preparation-retry"
            >
              <RotateCcw size={9} />
              {t('common.retry')}
            </button>
          ) : null}
        </span>
      ) : null}

      <div
        className="inline-flex items-center rounded-md border border-border p-0.5"
        role="tablist"
        aria-label={t('projectHeader.mode')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'sessions'}
          className={`inline-flex h-7 items-center gap-1 rounded px-2.5 text-[11px] ${
            mode === 'sessions'
              ? 'bg-accent/15 text-accent'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => onMode('sessions')}
          data-testid="project-mode-sessions"
        >
          <TerminalSquare size={10} />
          {t('projectHeader.sessions')}
          <span className="text-[9px] text-muted-foreground">{current.sessions}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'tasks'}
          className={`inline-flex h-7 items-center gap-1 rounded px-2.5 text-[11px] ${
            mode === 'tasks'
              ? 'bg-accent/15 text-accent'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => onMode('tasks')}
          data-testid="project-mode-tasks"
        >
          <ListTodo size={10} />
          {t('projectHeader.tasks')}
          <span className="text-[9px] text-muted-foreground">{current.tasks}</span>
          {current.needs > 0 ? (
            <span
              className="rounded-full bg-signal-weak px-1 text-[8px] font-medium text-signal"
              title={t('projectHeader.needsCount', { count: current.needs })}
              data-testid="project-tasks-needs"
            >
              {current.needs}
            </span>
          ) : null}
        </button>
      </div>
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onOpenAssistant}
        disabled={preparation !== null}
        title={
          preparation === null
            ? t('projectHeader.assistantOpen', { name: assistantName })
            : t('projectHeader.assistantLocked', { name: assistantName })
        }
        data-testid="project-mira"
      >
        <AssistantAvatar name={assistantName} status={assistantStatus} size="sm" />
        {assistantName}
        {assistantUnread > 0 ? (
          <span
            className="rounded-full bg-signal-weak px-1 text-[8px] font-medium text-signal"
            title={tp('projectHeader.unread', assistantUnread)}
            data-testid="project-mira-unread"
          >
            {assistantUnread > 9 ? '9+' : assistantUnread}
          </span>
        ) : null}
        {pendingProposals > 0 ? (
          <span
            className="rounded-full bg-signal-weak px-1 text-[8px] font-medium text-signal"
            title={tp('projectHeader.proposals', pendingProposals)}
            data-testid="project-supervisor-proposals"
          >
            {pendingProposals}
          </span>
        ) : null}
      </button>
      <span className="hidden text-[10.5px] text-muted-foreground lg:inline">
        {t('projectHeader.stats', {
          sessions: tp('projectHeader.stats.sessions', current.sessions),
          tasks: tp('projectHeader.stats.tasks', current.tasks)
        })}
      </span>
    </header>
  )
}

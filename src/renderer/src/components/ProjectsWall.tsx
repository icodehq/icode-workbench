import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  LayoutGrid,
  Pin,
  RotateCcw,
  Search,
  Settings
} from 'lucide-react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import type { ProjectMode } from '../router/routes'
import { repositoryPreparationView } from '../lib/repository-preparation'
import {
  attentionEntries,
  attentionLabel,
  filterAndSortProjects,
  projectStats,
  readPinnedProjectIds,
  relativeTimeLabel,
  togglePinnedProject,
  writePinnedProjectIds,
  type NeedEntry,
  type ProjectDirectoryFilter,
  type ProjectStats
} from './projects-wall-model'
import { taskAttentionCounts, taskIsActive } from './task-status'
import TargetBadge from './TargetBadge'

type Props = {
  repos: RepositorySummary[]
  sessions: SessionSummary[]
  tasks: TaskRecordPayload[]
  maxConcurrent: number
  onOpenProject: (repoId: string, mode?: ProjectMode) => void
  onOpenTask: (task: TaskRecordPayload) => void
  onManageRepositories: () => void
  onRetryPreparation: (repoId: string) => void
}

const DIRECTORY_FILTERS: Array<{ id: ProjectDirectoryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'needs', label: 'Needs you' },
  { id: 'live', label: 'Live' },
  { id: 'idle', label: 'Idle' }
]

function reasonPillClass(kind: NeedEntry['kind']): string {
  switch (kind) {
    case 'Answer':
      return 'border-signal-line bg-signal-weak text-signal'
    case 'Review':
      return 'border-info/50 bg-info-weak text-info'
    case 'Retry':
    case 'Setup':
      return 'border-destructive/50 bg-destructive/10 text-destructive'
  }
}

function reasonTextClass(kind: NeedEntry['kind']): string {
  switch (kind) {
    case 'Answer':
      return 'text-signal'
    case 'Review':
      return 'text-info'
    case 'Retry':
    case 'Setup':
      return 'text-destructive'
  }
}

function AttentionRow({
  entry,
  now,
  onOpen
}: {
  entry: NeedEntry
  now: number
  onOpen: () => void
}): React.JSX.Element {
  const title = entry.source === 'task' ? entry.task.title : 'First commit needs attention'
  const detail = entry.source === 'setup' ? entry.detail : entry.task.error ?? entry.task.resultSummary
  return (
    <button
      type="button"
      className="icode-need-row w-full border-t border-border px-2.5 py-1.5 text-left first:border-t-0 hover:bg-muted/40"
      onClick={onOpen}
      title={detail ?? title}
      data-testid={entry.source === 'task' ? `needs-${entry.task.id}` : `needs-setup-${entry.repo.id}`}
    >
      <span
        className={`icode-need-reason inline-flex h-[18px] items-center rounded-full border px-1.5 text-[8.5px] font-semibold uppercase tracking-[0.06em] ${reasonPillClass(entry.kind)}`}
      >
        {entry.kind}
      </span>
      <span className="icode-need-project truncate font-mono text-[9px] text-muted-foreground">
        {entry.repo.displayName}
      </span>
      <span className="icode-need-title truncate text-[11px] font-medium text-foreground">
        {title}
      </span>
      <span className="icode-need-age text-right font-mono text-[9px] text-muted-foreground">
        {relativeTimeLabel(entry.since, now)}
      </span>
      <ChevronRight size={11} className={`icode-need-arrow ${reasonTextClass(entry.kind)}`} />
    </button>
  )
}

function projectDotClass(stats: ProjectStats): string {
  const preparation = repositoryPreparationView(stats.repo)
  if (preparation?.kind === 'failed') return 'bg-destructive'
  if (preparation?.kind === 'preparing') return 'bg-signal'
  if (stats.liveSessions > 0) return 'bg-add'
  if (stats.attention.total > 0) return 'bg-signal'
  return 'bg-muted-foreground/40'
}

function projectWork(stats: ProjectStats): { text: string; tone: string; title: string } {
  const preparation = repositoryPreparationView(stats.repo)
  if (preparation?.kind === 'preparing') {
    return { text: 'Preparing first commit…', tone: 'text-signal', title: preparation.label }
  }
  if (preparation?.kind === 'failed') {
    return {
      text: 'Setup failed',
      tone: 'text-destructive',
      title: preparation.detail ?? preparation.label
    }
  }
  const parts: string[] = []
  if (stats.liveSessions > 0) {
    parts.push(`${String(stats.liveSessions)} live`)
  }
  if (stats.tasks.length > 0) {
    parts.push(`${String(stats.tasks.length)} task${stats.tasks.length === 1 ? '' : 's'}`)
  }
  const text = parts.join(' · ') || 'Idle'
  return { text, tone: stats.liveSessions > 0 ? 'text-add' : 'text-muted-foreground', title: text }
}

function ProjectRow({
  stats,
  pinned,
  now,
  onOpenProject,
  onTogglePin,
  onRetryPreparation
}: {
  stats: ProjectStats
  pinned: boolean
  now: number
  onOpenProject: (repoId: string, mode?: ProjectMode) => void
  onTogglePin: (repoId: string) => void
  onRetryPreparation: (repoId: string) => void
}): React.JSX.Element {
  const repo = stats.repo
  const preparation = repositoryPreparationView(repo)
  const work = projectWork(stats)
  const needs = attentionLabel(stats.attention) || '—'
  const branch = repo.currentBranch ?? '—'
  const updated = relativeTimeLabel(stats.lastActivityAt, now)
  const open = (): void => onOpenProject(repo.id, stats.openMode)
  const rowClass = [
    stats.attention.total > 0 ? 'needs' : '',
    stats.setupFailed ? 'setup-failed' : ''
  ].filter(Boolean).join(' ')
  return (
    <div
      className={`icode-project-row ${rowClass}`}
      data-testid={`project-row-${repo.id}`}
      onClick={open}
    >
      <div className="icode-project-project flex min-w-0 items-center gap-1.5">
        <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${projectDotClass(stats)}`} />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={(event) => {
            event.stopPropagation()
            open()
          }}
          data-testid={`open-project-${repo.id}`}
        >
          <span className="block truncate text-[11px] font-medium text-foreground">
            {repo.displayName}
          </span>
          <span className="block truncate font-mono text-[8.5px] text-muted-foreground">
            {repo.path}
          </span>
        </button>
        <TargetBadge repo={repo} compact />
      </div>
      <div className="icode-project-branch truncate font-mono text-[9.5px] text-muted-foreground" title={branch}>
        {branch}
      </div>
      <div className={`icode-project-work truncate text-[9.5px] ${work.tone}`} title={work.title}>
        {work.text}
      </div>
      <div
        className={`icode-project-needs truncate text-[9.5px] ${
          stats.attention.total > 0 ? 'font-medium text-signal' : 'text-muted-foreground'
        }`}
        title={needs === '—' ? undefined : needs}
      >
        {needs}
      </div>
      <div className="icode-project-updated font-mono text-[9.5px] text-muted-foreground">
        {updated}
      </div>
      <div className="icode-project-actions flex items-center justify-end gap-0.5">
        {preparation?.kind === 'failed' ? (
          <button
            type="button"
            className="grid h-[23px] w-[23px] place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation()
              onRetryPreparation(repo.id)
            }}
            title={preparation.detail ?? 'Retry first-commit preparation'}
            aria-label={`Retry preparation for ${repo.displayName}`}
            data-testid={`retry-preparation-${repo.id}`}
          >
            <RotateCcw size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className={`grid h-[23px] w-[23px] place-items-center rounded hover:bg-muted ${
            pinned ? 'text-accent' : 'text-muted-foreground opacity-40 hover:text-foreground hover:opacity-100'
          }`}
          onClick={(event) => {
            event.stopPropagation()
            onTogglePin(repo.id)
          }}
          title={pinned ? 'Unpin from top' : 'Pin to top'}
          aria-label={`${pinned ? 'Unpin' : 'Pin'} ${repo.displayName}`}
          aria-pressed={pinned}
          data-testid={`pin-project-${repo.id}`}
        >
          <Pin size={12} fill={pinned ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          className="grid h-[23px] w-[23px] place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation()
            open()
          }}
          title={`Open ${repo.displayName}`}
          aria-label={`Open ${repo.displayName}`}
          data-testid={`open-project-row-${repo.id}`}
        >
          <ArrowUpRight size={12} />
        </button>
      </div>
      <span className="icode-project-mobile">
        {branch} · {work.text}
        {needs === '—' ? '' : ` · ${needs}`} · {updated}
      </span>
    </div>
  )
}

export default function ProjectsWall({
  repos,
  sessions,
  tasks,
  maxConcurrent,
  onOpenProject,
  onOpenTask,
  onManageRepositories,
  onRetryPreparation
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ProjectDirectoryFilter>('all')
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinnedProjectIds())
  const [now, setNow] = useState(() => Date.now())
  const directoryRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    writePinnedProjectIds(pinnedIds)
  }, [pinnedIds])

  useEffect(() => {
    setPinnedIds((current) => {
      const valid = current.filter((id) => repos.some((repo) => repo.id === id))
      return valid.length === current.length ? current : valid
    })
  }, [repos])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const projects = useMemo(
    () => repos.map((repo) => projectStats(repo, sessions, tasks)),
    [repos, sessions, tasks]
  )
  const attention = useMemo(() => attentionEntries(tasks, repos), [tasks, repos])
  const filtered = useMemo(
    () => filterAndSortProjects(projects, pinnedIds, filter, query),
    [projects, pinnedIds, filter, query]
  )
  const counts = useMemo(() => taskAttentionCounts(tasks), [tasks])
  const liveCount = sessions.filter(
    (session) => session.state === 'live' || session.state === 'starting'
  ).length
  const activeSlots = tasks.filter(taskIsActive).length
  const setupCount = attention.filter((entry) => entry.source === 'setup').length
  const shownAttention = attention.slice(0, 6)

  const summaryParts: string[] = []
  if (setupCount > 0) summaryParts.push(`${String(setupCount)} setup`)
  if (counts.answer > 0) summaryParts.push(`${String(counts.answer)} answer`)
  if (counts.retry > 0) summaryParts.push(`${String(counts.retry)} retry`)
  if (counts.review > 0) summaryParts.push(`${String(counts.review)} review`)
  if (summaryParts.length === 0) summaryParts.push('Nothing waiting')
  summaryParts.push(`across ${String(repos.length)} project${repos.length === 1 ? '' : 's'}`)

  const showAllNeeds = (): void => {
    setQuery('')
    setFilter('needs')
    window.requestAnimationFrame(() => {
      directoryRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="projects-wall">
      <div className="flex shrink-0 flex-wrap items-start gap-3 px-4 pb-3 pt-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]">All projects</h1>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {repos.length} project{repos.length === 1 ? '' : 's'} · {liveCount} live session
            {liveCount === 1 ? '' : 's'} · Task slots {activeSlots}/{maxConcurrent}
            {attention.length > 0 ? ` · ${String(attention.length)} need you` : ''}
          </p>
        </div>
        <div className="ml-auto flex w-full flex-wrap items-center gap-2.5 min-[760px]:w-auto">
          <label className="flex h-8 w-full min-w-[200px] items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 text-muted-foreground focus-within:border-accent/50 min-[760px]:w-[290px]">
            <Search size={13} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${String(repos.length)} projects`}
              aria-label="Search projects"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
              data-testid="project-search"
            />
          </label>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onManageRepositories}
            data-testid="manage-repositories"
          >
            <Settings size={11} />
            Manage repositories
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        <section className="flex flex-col gap-2" aria-label="Needs you">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md border border-signal-line bg-signal-weak text-signal">
                <AlertTriangle size={11} />
              </span>
              Needs you
              <span className="inline-flex h-[17px] items-center rounded-full border border-border bg-muted px-1.5 font-mono text-[9px] font-medium tracking-normal text-muted-foreground">
                {attention.length}
              </span>
            </div>
            <span className="text-[9.5px] text-muted-foreground">
              {summaryParts.join(' · ')}
            </span>
            <span className="flex-1" />
            {attention.length > 6 ? (
              <button
                type="button"
                className="rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={showAllNeeds}
                data-testid="needs-view-all"
              >
                View all {attention.length}
              </button>
            ) : null}
          </div>
          {attention.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-[10.5px] text-muted-foreground">
              <CheckCircle2 size={14} className="text-add" />
              Nothing needs you. {liveCount} live session{liveCount === 1 ? '' : 's'} across{' '}
              {repos.length} project{repos.length === 1 ? '' : 's'}.
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-border bg-card" data-testid="needs-you">
              {shownAttention.map((entry) => (
                <AttentionRow
                  key={entry.source === 'task' ? `task:${entry.task.id}` : `setup:${entry.repo.id}`}
                  entry={entry}
                  now={now}
                  onOpen={() => {
                    if (entry.source === 'task') onOpenTask(entry.task)
                    else onOpenProject(entry.repo.id)
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <section className="flex min-h-0 flex-col gap-2" aria-label="All projects">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              <LayoutGrid size={13} className="text-muted-foreground" />
              All projects
              <span className="inline-flex h-[17px] items-center rounded-full border border-border bg-muted px-1.5 font-mono text-[9px] font-medium tracking-normal text-muted-foreground">
                {filtered.length}
              </span>
              <span className="text-[9.5px] font-normal normal-case tracking-normal text-muted-foreground">
                of {repos.length}
              </span>
            </div>
            <span className="flex-1" />
            <div className="flex flex-wrap items-center gap-1 max-[760px]:w-full">
              {DIRECTORY_FILTERS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`inline-flex h-[22px] items-center rounded-full border px-2 text-[9.5px] ${
                    filter === entry.id
                      ? 'border-accent bg-accent-weak text-accent'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setFilter(entry.id)}
                  aria-pressed={filter === entry.id}
                  data-testid={`project-filter-${entry.id}`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <div ref={directoryRef} className="icode-project-table">
            <div className="icode-project-head" aria-hidden="true">
              <span>Project</span>
              <span>Branch</span>
              <span>Work</span>
              <span>Needs</span>
              <span>Updated</span>
              <span />
            </div>
            <div className="icode-project-body" data-testid="project-directory">
              {filtered.length === 0 ? (
                <div
                  className="flex flex-wrap items-center gap-2 px-3 py-4 text-[10.5px] text-muted-foreground"
                  data-testid="project-directory-empty"
                >
                  {filter === 'pinned'
                    ? 'No pinned projects yet. Pin a project from any row.'
                    : 'No projects match this view.'}
                  <button
                    type="button"
                    className="rounded px-1.5 py-1 text-[10px] text-accent hover:bg-muted"
                    onClick={() => {
                      setQuery('')
                      setFilter('all')
                    }}
                  >
                    Clear search and filters
                  </button>
                </div>
              ) : (
                filtered.map((stats) => (
                  <ProjectRow
                    key={stats.repo.id}
                    stats={stats}
                    pinned={pinnedIds.includes(stats.repo.id)}
                    now={now}
                    onOpenProject={onOpenProject}
                    onTogglePin={(repoId) =>
                      setPinnedIds((current) => togglePinnedProject(current, repoId))
                    }
                    onRetryPreparation={onRetryPreparation}
                  />
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

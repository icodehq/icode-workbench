import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Copy,
  FolderGit2,
  LayoutGrid,
  MoreHorizontal,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Trash2
} from 'lucide-react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import type { Notice } from '../state/workspace'
import type { ProjectMode } from '../router/routes'
import { repositoryPreparationView } from '../lib/repository-preparation'
import ContextMenu, { type ContextMenuItem, type MenuAnchor } from './ContextMenu'
import {
  attentionEntries,
  filterAndSortProjects,
  inFlightView,
  needCounts,
  needEntryTitle,
  needsLabel,
  needYouLabel,
  projectStats,
  readPinnedProjectIds,
  relativeTimeLabel,
  togglePinnedProject,
  writePinnedProjectIds,
  type NeedEntry,
  type ProjectDirectoryFilter,
  type ProjectStats
} from './projects-wall-model'
import { activityDotClass, activityLabel } from './status'
import { taskIsActive } from './task-status'
import TargetBadge from './TargetBadge'
import { formatDateTime } from '../../../shared/i18n'
import { useLocale, useT, useTp } from '../i18n/use-i18n'
import type { Translator } from '../i18n/i18n-store'

type Props = {
  repos: RepositorySummary[]
  sessions: SessionSummary[]
  tasks: TaskRecordPayload[]
  maxConcurrent: number
  onOpenProject: (repoId: string, mode?: ProjectMode) => void
  onOpenTask: (task: TaskRecordPayload) => void
  onOpenSession: (sessionId: string) => void
  onAddRepository: () => void
  onRemoveRepository: (repoId: string) => void
  onRetryPreparation: (repoId: string) => void
  notify: (notice: Notice) => void
}

type ProjectMenuRequest = {
  repoId: string
  x?: number
  y?: number
  anchor?: MenuAnchor
  returnFocus: HTMLElement | null
  opener?: HTMLElement | null
}

const PROJECT_MENU_WIDTH = 192

function rectOf(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
}

const DIRECTORY_FILTERS: ProjectDirectoryFilter[] = ['all', 'pinned', 'needs', 'live', 'idle']

function reasonPillClass(kind: NeedEntry['kind']): string {
  switch (kind) {
    case 'Approval':
    case 'Answer':
    case 'Waiting':
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
    case 'Approval':
    case 'Answer':
    case 'Waiting':
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
  const t = useT()
  const title = needEntryTitle(entry)
  const detail =
    entry.source === 'setup'
      ? entry.detail
      : entry.source === 'session'
        ? entry.session.activity?.toolName
          ? t('projects.row.waitingTool', { tool: entry.session.activity.toolName })
          : t('projects.row.waitingInput')
        : entry.kind === 'Approval'
          ? `${
              entry.task.createdByActor === 'mira'
                ? t('projects.row.proposedByMira')
                : t('projects.row.proposedBySupervisor')
            } · ${t('projects.row.needsApproval')}`
          : entry.task.error ?? entry.task.resultSummary
  const kindLabel: Record<NeedEntry['kind'], string> = {
    Approval: t('projects.needKind.approval'),
    Answer: t('projects.needKind.answer'),
    Retry: t('projects.needKind.retry'),
    Review: t('projects.needKind.review'),
    Setup: t('projects.needKind.setup'),
    Waiting: t('projects.needKind.waiting')
  }
  const testId =
    entry.source === 'task'
      ? `needs-${entry.task.id}`
      : entry.source === 'session'
        ? `needs-session-${entry.session.id}`
        : `needs-setup-${entry.repo.id}`
  return (
    <button
      type="button"
      className="icode-need-row w-full border-t border-border px-2.5 py-1.5 text-left first:border-t-0 hover:bg-muted/40"
      onClick={onOpen}
      title={detail ?? title}
      data-testid={testId}
    >
      <span
        className={`icode-need-reason inline-flex h-[18px] items-center rounded-full border px-1.5 text-[8.5px] font-semibold uppercase tracking-[0.06em] ${reasonPillClass(entry.kind)}`}
      >
        {kindLabel[entry.kind]}
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

function ProjectRow({
  stats,
  pinned,
  now,
  menuOpen,
  onOpenProject,
  onTogglePin,
  onRetryPreparation,
  onRequestMenu,
  onCloseMenu
}: {
  stats: ProjectStats
  pinned: boolean
  now: number
  menuOpen: boolean
  onOpenProject: (repoId: string, mode?: ProjectMode) => void
  onTogglePin: (repoId: string) => void
  onRetryPreparation: (repoId: string) => void
  onRequestMenu: (request: ProjectMenuRequest) => void
  onCloseMenu: () => void
}): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const repo = stats.repo
  const activity = stats.activity
  const preparation = repositoryPreparationView(repo)
  const work = inFlightView(stats)
  const needsText = needYouLabel(stats.needs.total)
  const needsTitle = stats.needs.total > 0 ? needsLabel(stats.needs) : undefined
  const branch = repo.currentBranch ?? '—'
  const updated = relativeTimeLabel(stats.lastActivityAt, now)
  const open = (): void => onOpenProject(repo.id, stats.openMode)
  const rowClass = [
    stats.needs.total > 0 ? 'needs' : '',
    stats.setupFailed ? 'setup-failed' : ''
  ].filter(Boolean).join(' ')
  return (
    <div
      className={`icode-project-row ${rowClass}`}
      data-testid={`project-row-${repo.id}`}
      tabIndex={-1}
      onClick={open}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onRequestMenu({
          repoId: repo.id,
          x: event.clientX,
          y: event.clientY,
          returnFocus: event.currentTarget
        })
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault()
        event.stopPropagation()
        const trigger = event.currentTarget.querySelector<HTMLElement>(
          `[data-testid="project-menu-${repo.id}"]`
        )
        onRequestMenu({
          repoId: repo.id,
          anchor: rectOf(trigger ?? event.currentTarget),
          returnFocus:
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : event.currentTarget
        })
      }}
    >
      <div className="icode-project-project flex min-w-0 items-center gap-1.5">
        <span className="inline-flex w-[7px] shrink-0 items-center justify-center">
          {activity !== null ? (
            <span
              className={`h-[7px] w-[7px] rounded-full ${activityDotClass(activity)}`}
              role="img"
              aria-label={t('projects.row.activityAria', { label: activityLabel(activity) })}
              title={activityLabel(activity)}
              data-testid={`project-activity-${repo.id}`}
              data-activity={activity.state}
            />
          ) : null}
        </span>
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
          {repo.availability === 'missing' ? (
            <span className="block text-[8.5px] text-signal">{t('projects.row.pathMissing')}</span>
          ) : null}
        </button>
        <TargetBadge repo={repo} compact />
      </div>
      <div className="icode-project-branch truncate font-mono text-[9.5px] text-muted-foreground" title={branch}>
        {branch}
      </div>
      <div
        className={`icode-project-inflight truncate text-[9.5px] ${
          work.preparing ? 'text-signal' : 'text-muted-foreground'
        }`}
        title={work.title}
      >
        {work.text}
      </div>
      <div
        className={`icode-project-needs truncate text-[9.5px] ${
          stats.needs.total > 0 ? 'font-medium text-signal' : 'text-muted-foreground'
        }`}
        title={needsTitle}
      >
        {needsText}
      </div>
      <div
        className="icode-project-last-active truncate font-mono text-[9.5px] text-muted-foreground"
        title={
          stats.lastActivityAt === null
            ? undefined
            : formatDateTime(locale, stats.lastActivityAt)
        }
      >
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
            title={preparation.detail ?? t('projects.row.retryTitle')}
            aria-label={t('projects.row.retryAria', { name: repo.displayName })}
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
          title={pinned ? t('projects.row.unpin') : t('projects.row.pin')}
          aria-label={
            pinned
              ? t('projects.row.unpinAria', { name: repo.displayName })
              : t('projects.row.pinAria', { name: repo.displayName })
          }
          aria-pressed={pinned}
          data-testid={`pin-project-${repo.id}`}
        >
          <Pin size={12} fill={pinned ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          className="grid h-[23px] w-[23px] place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t('projects.row.actionsAria', { name: repo.displayName })}
          title={t('projects.row.actions')}
          onClick={(event) => {
            event.stopPropagation()
            if (menuOpen) {
              onCloseMenu()
              return
            }
            onRequestMenu({
              repoId: repo.id,
              anchor: rectOf(event.currentTarget),
              returnFocus: event.currentTarget,
              opener: event.currentTarget
            })
          }}
          data-testid={`project-menu-${repo.id}`}
        >
          <MoreHorizontal size={12} />
        </button>
      </div>
      <span className="icode-project-mobile">
        {branch} · {work.text}
        {needsText === t('projects.inFlight.none') ? '' : ` · ${needsText}`} · {updated}
      </span>
    </div>
  )
}

function projectMenuItems(
  stats: ProjectStats,
  pinned: boolean,
  handlers: {
    onOpen: () => void
    onTogglePin: () => void
    onCopyPath: () => void
    onRetry: () => void
    onRemove: () => void
  },
  t: Translator
): ContextMenuItem[] {
  const preparation = repositoryPreparationView(stats.repo)
  const items: ContextMenuItem[] = [
    {
      id: 'open',
      label: t('projects.menu.open'),
      icon: <FolderGit2 size={12} />,
      onSelect: handlers.onOpen
    },
    {
      id: 'pin',
      label: pinned ? t('projects.row.unpin') : t('projects.row.pin'),
      icon: <Pin size={12} fill={pinned ? 'currentColor' : 'none'} />,
      onSelect: handlers.onTogglePin
    },
    {
      id: 'copy-path',
      label: t('projects.menu.copyPath'),
      icon: <Copy size={12} />,
      onSelect: handlers.onCopyPath
    }
  ]
  if (preparation?.kind === 'failed') {
    items.push({
      id: 'retry-preparation',
      label: t('projects.menu.retry'),
      icon: <RotateCcw size={12} />,
      onSelect: handlers.onRetry
    })
  }
  items.push({
    id: 'remove',
    label: t('projects.menu.remove'),
    icon: <Trash2 size={12} />,
    danger: true,
    separatorBefore: true,
    testId: `repository-remove-${stats.repo.id}`,
    onSelect: handlers.onRemove
  })
  return items
}

export default function ProjectsWall({
  repos,
  sessions,
  tasks,
  maxConcurrent,
  onOpenProject,
  onOpenTask,
  onOpenSession,
  onAddRepository,
  onRemoveRepository,
  onRetryPreparation,
  notify
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ProjectDirectoryFilter>('all')
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinnedProjectIds())
  const [now, setNow] = useState(() => Date.now())
  const [menu, setMenu] = useState<ProjectMenuRequest | null>(null)
  const directoryRef = useRef<HTMLDivElement | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

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
  const menuStats =
    menu === null ? null : projects.find((entry) => entry.repo.id === menu.repoId) ?? null
  const copyProjectPath = useCallback(
    async (path: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(path)
        notify({ tone: 'success', message: t('projects.notice.pathCopied') })
      } catch {
        notify({ tone: 'error', message: t('projects.notice.clipboardUnavailable') })
      }
    },
    [notify, t]
  )
  const attention = useMemo(
    () => attentionEntries(tasks, repos, sessions),
    [tasks, repos, sessions]
  )
  const filtered = useMemo(
    () => filterAndSortProjects(projects, pinnedIds, filter, query),
    [projects, pinnedIds, filter, query]
  )
  const counts = useMemo(() => needCounts(attention), [attention])
  const liveCount = sessions.filter(
    (session) => session.state === 'live' || session.state === 'starting'
  ).length
  const activeSlots = tasks.filter(taskIsActive).length
  const shownAttention = attention.slice(0, 6)

  const summaryParts: string[] = []
  if (counts.setup > 0) {
    summaryParts.push(t('projects.summary.setup', { count: counts.setup }))
  }
  if (counts.answer > 0) {
    summaryParts.push(t('projects.summary.answer', { count: counts.answer }))
  }
  if (counts.retry > 0) {
    summaryParts.push(t('projects.summary.retry', { count: counts.retry }))
  }
  if (counts.review > 0) {
    summaryParts.push(t('projects.summary.review', { count: counts.review }))
  }
  if (counts.waiting > 0) {
    summaryParts.push(t('projects.summary.waiting', { count: counts.waiting }))
  }
  if (summaryParts.length === 0) summaryParts.push(t('projects.nothingWaiting'))
  summaryParts.push(t('projects.acrossProjects', { count: repos.length }))
  let subtitle = t('projects.subtitle', {
    projects: tp('projects.count.projects', repos.length),
    sessions: tp('projects.count.live', liveCount),
    active: activeSlots,
    max: maxConcurrent
  })
  if (attention.length > 0) {
    subtitle = t('projects.subtitleNeeds', { base: subtitle, count: attention.length })
  }

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
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]">{t('projects.allProjects')}</h1>
          <p className="mt-1 text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="ml-auto flex w-full flex-wrap items-center gap-2.5 min-[760px]:w-auto">
          <label className="flex h-8 w-full min-w-[200px] items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 text-muted-foreground focus-within:border-accent/50 min-[760px]:w-[290px]">
            <Search size={13} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('projects.searchCount', { count: repos.length })}
              aria-label={t('projects.searchProjects')}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
              data-testid="project-search"
            />
          </label>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[11px] font-medium text-accent-ink hover:opacity-90"
            onClick={onAddRepository}
            data-testid="add-project"
          >
            <Plus size={11} />
            {t('projects.addProject')}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        <section className="flex flex-col gap-2" aria-label={t('projects.needsTitle')}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md border border-signal-line bg-signal-weak text-signal">
                <AlertTriangle size={11} />
              </span>
              {t('projects.needsTitle')}
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
                {t('projects.viewAll', { count: attention.length })}
              </button>
            ) : null}
          </div>
          {attention.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-[10.5px] text-muted-foreground">
              <CheckCircle2 size={14} className="text-add" />
              {t('projects.nothingNeedsYou', {
                sessions: tp('projects.count.live', liveCount),
                projects: tp('projects.count.projects', repos.length)
              })}
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-border bg-card" data-testid="needs-you">
              {shownAttention.map((entry) => (
                <AttentionRow
                  key={
                    entry.source === 'task'
                      ? `task:${entry.task.id}`
                      : entry.source === 'session'
                        ? `session:${entry.session.id}`
                        : `setup:${entry.repo.id}`
                  }
                  entry={entry}
                  now={now}
                  onOpen={() => {
                    if (entry.source === 'task') onOpenTask(entry.task)
                    else if (entry.source === 'session') onOpenSession(entry.session.id)
                    else onOpenProject(entry.repo.id)
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <section className="flex min-h-0 flex-col gap-2" aria-label={t('projects.allProjects')}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              <LayoutGrid size={13} className="text-muted-foreground" />
              {t('projects.allProjects')}
              <span className="inline-flex h-[17px] items-center rounded-full border border-border bg-muted px-1.5 font-mono text-[9px] font-medium tracking-normal text-muted-foreground">
                {filtered.length}
              </span>
              <span className="text-[9.5px] font-normal normal-case tracking-normal text-muted-foreground">
                {t('projects.count.of', { count: repos.length })}
              </span>
            </div>
            <span className="flex-1" />
            <div className="flex flex-wrap items-center gap-1 max-[760px]:w-full">
              {DIRECTORY_FILTERS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`inline-flex h-[22px] items-center rounded-full border px-2 text-[9.5px] ${
                    filter === id
                      ? 'border-accent bg-accent-weak text-accent'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setFilter(id)}
                  aria-pressed={filter === id}
                  data-testid={`project-filter-${id}`}
                >
                  {t(`projects.filter.${id}`)}
                </button>
              ))}
            </div>
          </div>

          <div ref={directoryRef} className="icode-project-table">
            <div className="icode-project-head" aria-hidden="true">
              <span>{t('projects.table.project')}</span>
              <span>{t('projects.table.branch')}</span>
              <span>{t('projects.table.inFlight')}</span>
              <span>{t('projects.table.needs')}</span>
              <span>{t('projects.table.lastActive')}</span>
              <span />
            </div>
            <div className="icode-project-body" data-testid="project-directory">
              {filtered.length === 0 ? (
                <div
                  className="flex flex-wrap items-center gap-2 px-3 py-4 text-[10.5px] text-muted-foreground"
                  data-testid="project-directory-empty"
                >
                  {filter === 'pinned'
                    ? t('projects.empty.pinned')
                    : t('projects.empty.filtered')}
                  <button
                    type="button"
                    className="rounded px-1.5 py-1 text-[10px] text-accent hover:bg-muted"
                    onClick={() => {
                      setQuery('')
                      setFilter('all')
                    }}
                  >
                    {t('projects.clearFilters')}
                  </button>
                </div>
              ) : (
                filtered.map((stats) => (
                  <ProjectRow
                    key={stats.repo.id}
                    stats={stats}
                    pinned={pinnedIds.includes(stats.repo.id)}
                    now={now}
                    menuOpen={menu?.repoId === stats.repo.id}
                    onOpenProject={onOpenProject}
                    onTogglePin={(repoId) =>
                      setPinnedIds((current) => togglePinnedProject(current, repoId))
                    }
                    onRetryPreparation={onRetryPreparation}
                    onRequestMenu={setMenu}
                    onCloseMenu={closeMenu}
                  />
                ))
              )}
            </div>
          </div>
        </section>
      </div>
      {menu !== null && menuStats !== null ? (
        <ContextMenu
          key={menu.repoId}
          items={projectMenuItems(menuStats, pinnedIds.includes(menuStats.repo.id), {
            onOpen: () => onOpenProject(menuStats.repo.id, menuStats.openMode),
            onTogglePin: () =>
              setPinnedIds((current) => togglePinnedProject(current, menuStats.repo.id)),
            onCopyPath: () => void copyProjectPath(menuStats.repo.path),
            onRetry: () => onRetryPreparation(menuStats.repo.id),
            onRemove: () => onRemoveRepository(menuStats.repo.id)
          }, t)}
          ariaLabel={t('projects.row.actionsAria', { name: menuStats.repo.displayName })}
          testId={`project-menu-popover-${menu.repoId}`}
          width={PROJECT_MENU_WIDTH}
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          align="end"
          returnFocus={menu.returnFocus}
          opener={menu.opener}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  )
}

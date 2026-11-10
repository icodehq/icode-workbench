import type { TaskRecordPayload } from '../../../shared/icode-api'
import {
  toActivitySummary,
  unknownActivity,
  type ActivitySummary
} from '../../../shared/domain/activity'
import { isActiveSessionState } from '../../../shared/domain/session'
import { isTerminalTaskStatus } from '../../../shared/domain/task'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import { repositoryPreparationView } from '../lib/repository-preparation'
import { translate, translatePlural } from '../i18n/i18n-store'
import {
  taskAttention,
  taskAttentionCounts,
  type TaskAttentionKind
} from './task-status'

export type ProjectDirectoryFilter = 'all' | 'pinned' | 'needs' | 'live' | 'idle'

export type ProjectLoad = {
  /** Direct sessions in starting/live. Task-owned sessions are represented by their task. */
  live: number
  /** Tasks dispatching or running. */
  running: number
  queued: number
  /** live + running + queued; excludes waiting and terminal tasks. */
  total: number
}

export type ProjectNeeds = {
  /** Queued supervisor proposals waiting for a person. */
  approval?: number
  answer: number
  retry: number
  review: number
  /** Queued tasks whose blocker can never satisfy the gate without a person. */
  blocked: number
  /** Active direct sessions whose agent is waiting for input. */
  waiting: number
  /** Failed first-commit preparation; at most one per project. */
  setup: number
  total: number
}

export type ProjectStats = {
  repo: RepositorySummary
  sessions: SessionSummary[]
  /** Supervisor/control sessions; excluded from work metrics. */
  controlSessions: SessionSummary[]
  directSessions: SessionSummary[]
  liveSessions: number
  /** The most actionable agent activity among live sessions; null when none are live. */
  activity: ActivitySummary | null
  tasks: TaskRecordPayload[]
  load: ProjectLoad
  needs: ProjectNeeds
  /** A failed background first commit; the project header owns the retry. */
  setupFailed: boolean
  lastActivityAt: number | null
  openMode: 'sessions' | 'tasks'
}

type TaskNeedEntry = {
  source: 'task'
  task: TaskRecordPayload
  repo: RepositorySummary
  kind: TaskAttentionKind
  /** When the task entered the state that needs a person. */
  since: number
}

type SetupNeedEntry = {
  source: 'setup'
  repo: RepositorySummary
  kind: 'Setup'
  detail: string | null
  /** When the background preparation failed. */
  since: number
}

type SessionNeedEntry = {
  source: 'session'
  session: SessionSummary
  repo: RepositorySummary
  kind: 'Waiting'
  /** When the agent entered the waiting state. */
  since: number
}

export type NeedEntry = TaskNeedEntry | SetupNeedEntry | SessionNeedEntry

export type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export const PINNED_PROJECTS_KEY = 'icode.pinnedProjectIds'

function activityRank(activity: ActivitySummary): number {
  switch (activity.state) {
    case 'waiting':
      return 0
    case 'working':
      return 1
    case 'idle':
      return activity.outcome === 'failed' ? 2 : 3
    case 'unknown':
      return 4
  }
}

/**
 * The project's leading status is agent activity only. Waiting outranks working,
 * then a failed turn, then a completed turn; unknown stays last so a harness
 * that reports nothing never hides real evidence from another session.
 */
export function projectActivity(
  sessions: readonly SessionSummary[]
): ActivitySummary | null {
  let best: ActivitySummary | null = null
  for (const session of sessions) {
    if (!isActiveSessionState(session.state)) continue
    const candidate =
      session.activity ?? toActivitySummary(unknownActivity(session.updatedAt))
    if (best === null) {
      best = candidate
      continue
    }
    const rank = activityRank(candidate) - activityRank(best)
    if (rank < 0 || (rank === 0 && candidate.since > best.since)) best = candidate
  }
  return best
}

function storageOrNull(storage?: StorageLike): StorageLike | null {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Project-level state. Activity is the actionable agent state; load is what is
 * running or queued right now; needs is everything that requires a person.
 */
export function projectStats(
  repo: RepositorySummary,
  sessions: readonly SessionSummary[],
  tasks: readonly TaskRecordPayload[]
): ProjectStats {
  const repoSessions = sessions.filter((session) => session.repoId === repo.id)
  const controlSessions = repoSessions.filter((session) => session.role === 'supervisor')
  const workSessions = repoSessions.filter((session) => session.role !== 'supervisor')
  const repoTasks = tasks.filter((task) => task.repoId === repo.id)
  const taskSessionIds = new Set(
    repoTasks.map((task) => task.sessionId).filter((id): id is string => id !== null)
  )
  const directSessions = workSessions.filter((session) => !taskSessionIds.has(session.id))
  const directLive = directSessions.filter((session) =>
    isActiveSessionState(session.state)
  ).length
  const liveSessions = workSessions.filter((session) =>
    isActiveSessionState(session.state)
  ).length
  const running = repoTasks.filter(
    (task) => task.status === 'dispatching' || task.status === 'running'
  ).length
  const queued = repoTasks.filter(
    (task) => task.status === 'queued' && task.approval !== 'pending'
  ).length
  const taskNeeds = taskAttentionCounts(repoTasks)
  const waiting = directSessions.filter(
    (session) => isActiveSessionState(session.state) && session.activity?.state === 'waiting'
  ).length
  const setupFailed = repositoryPreparationView(repo)?.kind === 'failed'
  const setup = setupFailed ? 1 : 0
  const activity = projectActivity(workSessions)
  const activityStamps = workSessions.flatMap((session) =>
    isActiveSessionState(session.state) &&
    session.activity !== null &&
    session.activity.state !== 'unknown'
      ? [session.activity.since]
      : []
  )
  const stamps = [
    ...activityStamps,
    ...repoTasks.map((task) => task.updatedAt),
    repo.preparation?.finishedAt ?? repo.preparation?.startedAt ?? 0
  ].filter((value) => value > 0)
  return {
    repo,
    sessions: repoSessions,
    controlSessions,
    directSessions,
    liveSessions,
    activity,
    tasks: repoTasks,
    load: {
      live: directLive,
      running,
      queued,
      total: directLive + running + queued
    },
    needs: {
      approval: taskNeeds.approval,
      answer: taskNeeds.answer,
      retry: taskNeeds.retry,
      review: taskNeeds.review,
      blocked: taskNeeds.blocked,
      waiting,
      setup,
      total: taskNeeds.total + waiting + setup
    },
    setupFailed,
    lastActivityAt: stamps.length > 0 ? Math.max(...stamps) : null,
    openMode: directSessions.length > 0 ? 'sessions' : 'tasks'
  }
}

/** The header counts direct sessions; `ProjectStats.sessions` is repository-wide. */
export function projectHeaderStats(stats: ProjectStats): {
  sessions: number
  live: number
  tasks: number
  needs: number
} {
  return {
    sessions: stats.directSessions.length,
    live: stats.liveSessions,
    tasks: stats.tasks.length,
    needs: stats.needs.total
  }
}

/** The Work/In-flight cell: live direct sessions plus open tasks. */
export function inFlightView(stats: ProjectStats): {
  text: string
  title: string
  preparing: boolean
} {
  const { load, tasks, repo } = stats
  const openTasks = load.running + load.queued
  if (load.live === 0 && openTasks === 0) {
    const preparation = repositoryPreparationView(repo)
    if (preparation?.kind === 'preparing') {
      return {
        text: translate('projects.inFlight.preparing'),
        title: preparation.label,
        preparing: true
      }
    }
    return {
      text: translate('projects.inFlight.none'),
      title: translate('projects.inFlight.noWork'),
      preparing: false
    }
  }
  const parts: string[] = []
  if (load.live > 0) {
    parts.push(translate('projects.inFlight.live', { count: load.live }))
  }
  if (openTasks > 0) {
    parts.push(translatePlural('projects.inFlight.task', openTasks))
  }
  const waitingTasks = tasks.filter((task) => task.status === 'waiting').length
  const finishedTasks = tasks.filter((task) => isTerminalTaskStatus(task.status)).length
  return {
    text: parts.join(' · '),
    title: translate('projects.inFlight.title', {
      live: load.live,
      running: load.running,
      queued: load.queued,
      waiting: waitingTasks,
      finished: finishedTasks
    }),
    preparing: false
  }
}

export function needsLabel(needs: ProjectNeeds): string {
  const parts: string[] = []
  if ((needs.approval ?? 0) > 0) {
    parts.push(translate('projects.needs.approve', { count: needs.approval ?? 0 }))
  }
  if (needs.answer > 0) parts.push(translate('projects.needs.answer', { count: needs.answer }))
  if (needs.retry > 0) parts.push(translate('projects.needs.retry', { count: needs.retry }))
  if (needs.blocked > 0) parts.push(translate('projects.needs.blocked', { count: needs.blocked }))
  if (needs.review > 0) parts.push(translate('projects.needs.review', { count: needs.review }))
  if (needs.waiting > 0) {
    parts.push(translate('projects.needs.waiting', { count: needs.waiting }))
  }
  if (needs.setup > 0) parts.push(translate('projects.needs.setupFailed'))
  return parts.join(' · ')
}

export function needYouLabel(total: number): string {
  return total > 0
    ? translate('projects.needs.needYou', { count: total })
    : translate('projects.inFlight.none')
}

export function needEntryTitle(entry: NeedEntry): string {
  if (entry.source === 'task') return entry.task.title
  if (entry.source === 'session') return entry.session.title
  return translate('projects.need.firstCommit')
}

function attentionSince(task: TaskRecordPayload): number {
  if (task.status === 'completed') return task.finishedAt ?? task.updatedAt
  return task.updatedAt
}

/**
 * Cross-project triage. A person unblocks an agent first, then retries a
 * failure, then reviews finished work; within a kind the oldest item wins.
 */
export function attentionEntries(
  tasks: readonly TaskRecordPayload[],
  repos: readonly RepositorySummary[],
  sessions: readonly SessionSummary[] = []
): NeedEntry[] {
  const reposById = new Map(repos.map((repo) => [repo.id, repo]))
  const taskSessionIds = new Set(
    tasks.map((task) => task.sessionId).filter((id): id is string => id !== null)
  )
  const rank = (kind: NeedEntry['kind']): number =>
    kind === 'Setup'
      ? 0
      : kind === 'Approval'
        ? 1
        : kind === 'Answer' || kind === 'Waiting'
          ? 2
          : kind === 'Retry'
            ? 3
            : kind === 'Blocked'
              ? 4
              : 5
  const taskEntries: NeedEntry[] = tasks.flatMap((task) => {
    const kind = taskAttention(task)
    const repo = reposById.get(task.repoId)
    if (kind === null || repo === undefined) return []
    return [{ source: 'task', task, repo, kind, since: attentionSince(task) }]
  })
  const setupEntries: NeedEntry[] = repos.flatMap((repo) => {
    const preparation = repositoryPreparationView(repo)
    if (preparation?.kind !== 'failed') return []
    return [{
      source: 'setup',
      repo,
      kind: 'Setup',
      detail: preparation.detail,
      since: repo.preparation?.finishedAt ?? repo.preparation?.startedAt ?? 0
    }]
  })
  const sessionEntries: NeedEntry[] = sessions.flatMap((session) => {
    const repo = reposById.get(session.repoId)
    if (repo === undefined || taskSessionIds.has(session.id)) return []
    if (session.role === 'supervisor') return []
    if (!isActiveSessionState(session.state)) return []
    if (session.activity?.state !== 'waiting') return []
    return [{
      source: 'session',
      session,
      repo,
      kind: 'Waiting',
      since: session.activity.since
    }]
  })
  return [...setupEntries, ...taskEntries, ...sessionEntries].sort((left, right) => {
    return (
      rank(left.kind) - rank(right.kind) ||
      left.since - right.since ||
      needEntryTitle(left).localeCompare(needEntryTitle(right))
    )
  })
}

export function needCounts(entries: readonly NeedEntry[]): ProjectNeeds {
  const counts: ProjectNeeds = {
    approval: 0,
    answer: 0,
    retry: 0,
    review: 0,
    blocked: 0,
    waiting: 0,
    setup: 0,
    total: 0
  }
  for (const entry of entries) {
    if (entry.kind === 'Approval') counts.approval = (counts.approval ?? 0) + 1
    else if (entry.kind === 'Answer') counts.answer += 1
    else if (entry.kind === 'Retry') counts.retry += 1
    else if (entry.kind === 'Review') counts.review += 1
    else if (entry.kind === 'Blocked') counts.blocked += 1
    else if (entry.kind === 'Waiting') counts.waiting += 1
    else counts.setup += 1
    counts.total += 1
  }
  return counts
}

function projectMatchesQuery(stats: ProjectStats, query: string): boolean {
  if (query.length === 0) return true
  const repo = stats.repo
  const target = repo.target.kind === 'wsl' ? `wsl ${repo.target.distro}` : 'local'
  return `${repo.displayName} ${repo.path} ${repo.currentBranch ?? ''} ${target}`
    .toLowerCase()
    .includes(query)
}

/**
 * Pinned projects are a shortcut, not a separate surface: they sort first, then
 * needs, in-flight load, recency and name decide the rest.
 */
export function filterAndSortProjects(
  projects: readonly ProjectStats[],
  pinnedIds: readonly string[],
  filter: ProjectDirectoryFilter,
  query: string
): ProjectStats[] {
  const pinned = new Set(pinnedIds)
  const normalized = query.trim().toLowerCase()
  return projects
    .filter((project) => {
      if (filter === 'pinned' && !pinned.has(project.repo.id)) return false
      if (filter === 'needs' && project.needs.total === 0) return false
      if (filter === 'live' && project.liveSessions === 0) return false
      if (filter === 'idle' && (project.needs.total !== 0 || project.load.total !== 0)) {
        return false
      }
      return projectMatchesQuery(project, normalized)
    })
    .sort((left, right) => {
      return (
        Number(pinned.has(right.repo.id)) - Number(pinned.has(left.repo.id)) ||
        Number(right.setupFailed) - Number(left.setupFailed) ||
        right.needs.total - left.needs.total ||
        right.load.total - left.load.total ||
        (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0) ||
        left.repo.displayName.localeCompare(right.repo.displayName)
      )
    })
}

export function togglePinnedProject(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id]
}

export function readPinnedProjectIds(storage?: StorageLike): string[] {
  const target = storageOrNull(storage)
  if (target === null) return []
  try {
    const raw = target.getItem(PINNED_PROJECTS_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))]
  } catch {
    return []
  }
}

export function writePinnedProjectIds(ids: readonly string[], storage?: StorageLike): void {
  const target = storageOrNull(storage)
  if (target === null) return
  try {
    target.setItem(PINNED_PROJECTS_KEY, JSON.stringify([...new Set(ids)]))
  } catch {
    // A disabled storage backend must not block the project directory.
  }
}

/** Compact age labels: no wall clock, no locale-dependent formatting. */
export function relativeTimeLabel(timestamp: number | null, now: number = Date.now()): string {
  if (timestamp === null || timestamp <= 0) return translate('projects.inFlight.none')
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return translate('projects.time.now')
  if (elapsed < 3_600_000) {
    return translate('projects.time.minutes', { count: Math.floor(elapsed / 60_000) })
  }
  if (elapsed < 86_400_000) {
    return translate('projects.time.hours', { count: Math.floor(elapsed / 3_600_000) })
  }
  return translate('projects.time.days', { count: Math.floor(elapsed / 86_400_000) })
}

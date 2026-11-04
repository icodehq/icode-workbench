import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import { repositoryPreparationView } from '../lib/repository-preparation'
import {
  taskAttention,
  taskAttentionCounts,
  type TaskAttentionCounts,
  type TaskAttentionKind
} from './task-status'

export type ProjectDirectoryFilter = 'all' | 'pinned' | 'needs' | 'live' | 'idle'

export type ProjectStats = {
  repo: RepositorySummary
  sessions: SessionSummary[]
  directSessions: SessionSummary[]
  liveSessions: number
  tasks: TaskRecordPayload[]
  attention: TaskAttentionCounts
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

export type NeedEntry = TaskNeedEntry | SetupNeedEntry

export type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export const PINNED_PROJECTS_KEY = 'icode.pinnedProjectIds'

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
 * Project-level activity. Repositories themselves have no change stamp, so the
 * newest session, task, or preparation update is the truthful signal we have.
 */
export function projectStats(
  repo: RepositorySummary,
  sessions: readonly SessionSummary[],
  tasks: readonly TaskRecordPayload[]
): ProjectStats {
  const repoSessions = sessions.filter((session) => session.repoId === repo.id)
  const repoTasks = tasks.filter((task) => task.repoId === repo.id)
  const taskSessionIds = new Set(
    repoTasks.map((task) => task.sessionId).filter((id): id is string => id !== null)
  )
  const directSessions = repoSessions.filter((session) => !taskSessionIds.has(session.id))
  const liveSessions = repoSessions.filter(
    (session) => session.state === 'live' || session.state === 'starting'
  ).length
  const stamps = [
    ...repoSessions.map((session) => session.updatedAt),
    ...repoTasks.map((task) => task.updatedAt),
    repo.preparation?.finishedAt ?? repo.preparation?.startedAt ?? 0
  ].filter((value) => value > 0)
  return {
    repo,
    sessions: repoSessions,
    directSessions,
    liveSessions,
    tasks: repoTasks,
    attention: taskAttentionCounts(repoTasks),
    setupFailed: repositoryPreparationView(repo)?.kind === 'failed',
    lastActivityAt: stamps.length > 0 ? Math.max(...stamps) : null,
    openMode: directSessions.length > 0 ? 'sessions' : 'tasks'
  }
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
  repos: readonly RepositorySummary[]
): NeedEntry[] {
  const reposById = new Map(repos.map((repo) => [repo.id, repo]))
  const rank = (kind: NeedEntry['kind']): number =>
    kind === 'Setup' ? 0 : kind === 'Answer' ? 1 : kind === 'Retry' ? 2 : 3
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
  return [...setupEntries, ...taskEntries].sort((left, right) => {
    const leftTitle = left.source === 'task' ? left.task.title : 'First commit needs attention'
    const rightTitle = right.source === 'task' ? right.task.title : 'First commit needs attention'
    return (
      rank(left.kind) - rank(right.kind) ||
      left.since - right.since ||
      leftTitle.localeCompare(rightTitle)
    )
  })
}

export function attentionLabel(attention: TaskAttentionCounts): string {
  const parts: string[] = []
  if (attention.answer > 0) parts.push(`Answer ${String(attention.answer)}`)
  if (attention.retry > 0) parts.push(`Retry ${String(attention.retry)}`)
  if (attention.review > 0) parts.push(`Review ${String(attention.review)}`)
  return parts.join(' · ')
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
 * attention, live work, recency and name decide the rest.
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
      if (filter === 'needs' && project.attention.total === 0 && !project.setupFailed) {
        return false
      }
      if (filter === 'live' && project.liveSessions === 0) return false
      if (
        filter === 'idle' &&
        (project.liveSessions > 0 || project.attention.total > 0 || project.setupFailed)
      ) {
        return false
      }
      return projectMatchesQuery(project, normalized)
    })
    .sort((left, right) => {
      return (
        Number(pinned.has(right.repo.id)) - Number(pinned.has(left.repo.id)) ||
        Number(right.setupFailed) - Number(left.setupFailed) ||
        right.attention.total - left.attention.total ||
        right.liveSessions - left.liveSessions ||
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
  if (timestamp === null || timestamp <= 0) return '—'
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return 'now'
  if (elapsed < 3_600_000) return `${String(Math.floor(elapsed / 60_000))}m`
  if (elapsed < 86_400_000) return `${String(Math.floor(elapsed / 3_600_000))}h`
  return `${String(Math.floor(elapsed / 86_400_000))}d`
}

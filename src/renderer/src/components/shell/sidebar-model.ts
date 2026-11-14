import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import { taskAttention, type TaskAttentionKind } from '../task-status'

export type SidebarTaskGroup = {
  repo: RepositorySummary
  tasks: TaskRecordPayload[]
  attention: number
}

export type WorktreeSessionGroup = {
  worktreeId: string
  branch: string
  path: string
  sessions: SessionSummary[]
}

export type DirectSessionGroups = {
  root: SessionSummary[]
  worktrees: WorktreeSessionGroup[]
}

const ATTENTION_RANK: Record<TaskAttentionKind, number> = {
  Approval: 0,
  Answer: 1,
  Retry: 2,
  Blocked: 3,
  Review: 4
}

export function isTaskSession(
  sessionId: string,
  taskSessionIds: ReadonlySet<string>
): boolean {
  return taskSessionIds.has(sessionId)
}

export function directSessionsByRepo(
  sessions: readonly SessionSummary[],
  taskSessionIds: ReadonlySet<string>
): Map<string, SessionSummary[]> {
  const grouped = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    if (isTaskSession(session.id, taskSessionIds)) continue
    const list = grouped.get(session.repoId)
    if (list) list.push(session)
    else grouped.set(session.repoId, [session])
  }
  return grouped
}

/**
 * The project tree shows a root group then one group per checkout.
 *
 * A worktree is keyed by its stable path, never its branch: a `git checkout`
 * inside the folder changes the label but must not split — or merge — the
 * sessions that live there. Session order within a group follows the store
 * (newest first).
 */
export function groupDirectSessions(sessions: readonly SessionSummary[]): DirectSessionGroups {
  const root: SessionSummary[] = []
  const worktrees = new Map<string, WorktreeSessionGroup>()
  for (const session of sessions) {
    if (session.worktree === null) {
      root.push(session)
      continue
    }
    const key = session.worktree.path
    const existing = worktrees.get(key)
    if (existing) existing.sessions.push(session)
    else {
      worktrees.set(key, {
        worktreeId: session.worktree.id,
        branch: session.worktree.branch,
        path: session.worktree.path,
        sessions: [session]
      })
    }
  }
  return { root, worktrees: [...worktrees.values()] }
}

export function sidebarTaskRank(task: TaskRecordPayload): number {
  const attention = taskAttention(task)
  if (attention !== null) return ATTENTION_RANK[attention]
  if (task.status === 'running' || task.status === 'dispatching') return 5
  if (task.status === 'queued') return 6
  if (task.status === 'completed') return 7
  if (task.status === 'failed') return 2
  return 8
}

export function sortSidebarTasks(tasks: readonly TaskRecordPayload[]): TaskRecordPayload[] {
  return [...tasks].sort(
    (left, right) =>
      sidebarTaskRank(left) - sidebarTaskRank(right) ||
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt
  )
}

export function buildSidebarTaskGroups(
  tasks: readonly TaskRecordPayload[],
  repos: readonly RepositorySummary[],
  needsOnly = false,
  historyOnly = false
): SidebarTaskGroup[] {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const visible = tasks.filter(
    (task) =>
      (historyOnly
        ? task.archivedAt !== null && task.archivedAt !== undefined
        : task.archivedAt === null || task.archivedAt === undefined) &&
      (!needsOnly || taskAttention(task) !== null)
  )
  const groups = new Map<string, TaskRecordPayload[]>()
  for (const task of visible) {
    const list = groups.get(task.repoId)
    if (list) list.push(task)
    else groups.set(task.repoId, [task])
  }
  return repos
    .filter((repo) => groups.has(repo.id))
    .map((repo) => {
      const grouped = groups.get(repo.id) ?? []
      return {
        repo: repoById.get(repo.id) ?? repo,
        tasks: sortSidebarTasks(grouped),
        attention: grouped.filter((task) => taskAttention(task) !== null).length
      }
    })
}

export function attentionTaskCount(tasks: readonly TaskRecordPayload[]): number {
  return tasks.filter((task) => taskAttention(task) !== null).length
}

export function pinnedProjectsFirst(
  repos: readonly RepositorySummary[],
  pinnedProjectIds: readonly string[]
): { pinned: RepositorySummary[]; rest: RepositorySummary[] } {
  const pinned = new Set(pinnedProjectIds)
  return {
    pinned: repos.filter((repo) => pinned.has(repo.id)),
    rest: repos.filter((repo) => !pinned.has(repo.id))
  }
}

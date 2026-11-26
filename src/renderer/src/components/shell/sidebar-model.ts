import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import { taskAttention } from '../task-status'

export type WorktreeSessionGroup = {
  worktreeId: string
  branch: string
  path: string
  sessions: SessionSummary[]
}

export type DirectSessionGroups = {
  /** Sessions running in the project's primary checkout (no worktree link). */
  defaultCheckout: SessionSummary[]
  worktrees: WorktreeSessionGroup[]
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
  const defaultCheckout: SessionSummary[] = []
  const worktrees = new Map<string, WorktreeSessionGroup>()
  for (const session of sessions) {
    if (session.worktree === null) {
      defaultCheckout.push(session)
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
  return { defaultCheckout, worktrees: [...worktrees.values()] }
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

/** Sessions and worktrees a repository removal takes with it, including task sessions. */
export function repositoryRemovalImpact(
  repoId: string,
  sessions: readonly SessionSummary[],
  tasks: readonly TaskRecordPayload[]
): { sessions: number; worktrees: number } {
  const repoTasks = tasks.filter((task) => task.repoId === repoId)
  const repoSessions = sessions.filter((session) => session.repoId === repoId)
  return {
    sessions:
      repoSessions.length + repoTasks.filter((task) => task.sessionId !== null).length,
    worktrees:
      repoSessions.filter((session) => session.worktree !== null).length +
      repoTasks.filter((task) => task.worktreePath !== null).length
  }
}

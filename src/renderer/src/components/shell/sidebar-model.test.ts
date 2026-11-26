import { describe, expect, it } from 'vitest'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import {
  attentionTaskCount,
  groupDirectSessions,
  pinnedProjectsFirst,
  repositoryRemovalImpact
} from './sidebar-model'

function repo(id: string): RepositorySummary {
  return {
    id,
    displayName: id,
    path: `/tmp/${id}`,
    currentBranch: 'main'
  } as RepositorySummary
}

function session(
  id: string,
  repoId: string,
  branch: string | null = null
): SessionSummary {
  return {
    id,
    repoId,
    title: id,
    worktree:
      branch === null
        ? null
        : {
            id: `wt_${branch}`,
            path: `/tmp/wt/${branch}`,
            branch,
            baseOid: 'abc',
            state: 'ready',
            status: 'active',
            error: null
          }
  } as SessionSummary
}

function task(
  id: string,
  repoId: string,
  status: TaskRecordPayload['status'],
  overrides: Partial<TaskRecordPayload> = {}
): TaskRecordPayload {
  return {
    id,
    repoId,
    title: id,
    prompt: id,
    harness: 'claude',
    status,
    sessionId: null,
    attempt: 0,
    reviewDecision: 'pending',
    updatedAt: 0,
    createdAt: 0,
    archivedAt: null,
    ...overrides
  } as TaskRecordPayload
}

describe('repository removal impact', () => {
  it('counts direct sessions and task sessions, including archived tasks', () => {
    const sessions = [
      session('s1', 'repo-a', 'branch-a'),
      session('s2', 'repo-a'),
      session('s3', 'repo-b', 'branch-b')
    ]
    const tasks = [
      task('t1', 'repo-a', 'completed', {
        sessionId: 'session-t1',
        worktreePath: '/tmp/wt/t1'
      }),
      task('t2', 'repo-a', 'completed', {
        sessionId: 'session-t2',
        worktreePath: null,
        archivedAt: 1
      }),
      task('t3', 'repo-b', 'completed', {
        sessionId: 'session-t3',
        worktreePath: '/tmp/wt/t3'
      })
    ]

    expect(repositoryRemovalImpact('repo-a', sessions, tasks)).toEqual({
      sessions: 4,
      worktrees: 2
    })
  })

  it('counts nothing for a repository with no sessions or tasks', () => {
    expect(repositoryRemovalImpact('repo-empty', [], [])).toEqual({
      sessions: 0,
      worktrees: 0
    })
  })
})

describe('sidebar model', () => {
  it('groups default-checkout sessions and worktrees by checkout and keeps order', () => {
    const groups = groupDirectSessions([
      session('root-1', 'demo'),
      session('wt-1', 'demo', 'feat/a'),
      session('root-2', 'demo'),
      session('wt-2', 'demo', 'feat/a')
    ])
    expect(groups.defaultCheckout.map((entry) => entry.id)).toEqual(['root-1', 'root-2'])
    expect(groups.worktrees).toHaveLength(1)
    expect(groups.worktrees[0]?.worktreeId).toBe('wt_feat/a')
    expect(groups.worktrees[0]?.branch).toBe('feat/a')
    expect(groups.worktrees[0]?.sessions.map((entry) => entry.id)).toEqual(['wt-1', 'wt-2'])
  })

  it('keys a checkout by path, so a branch rename cannot split its sessions', () => {
    const first = session('wt-1', 'demo', 'feat/a')
    const second = session('wt-2', 'demo', 'feat/renamed')
    // Same checkout, live branch label has moved on for one of the sessions.
    if (second.worktree !== null) second.worktree.path = '/tmp/wt/feat/a'
    const groups = groupDirectSessions([first, second])
    expect(groups.worktrees).toHaveLength(1)
    expect(groups.worktrees[0]?.sessions.map((entry) => entry.id)).toEqual(['wt-1', 'wt-2'])
  })

  it('counts attention tasks', () => {
    expect(attentionTaskCount([task('a', 'demo', 'failed'), task('b', 'demo', 'running')])).toBe(1)
  })

  it('splits pinned projects from the rest without changing order', () => {
    const result = pinnedProjectsFirst([repo('demo'), repo('api'), repo('docs')], ['docs'])
    expect(result.pinned.map((entry) => entry.id)).toEqual(['docs'])
    expect(result.rest.map((entry) => entry.id)).toEqual(['demo', 'api'])
  })
})

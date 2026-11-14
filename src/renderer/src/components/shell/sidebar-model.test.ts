import { describe, expect, it } from 'vitest'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { RepositorySummary, SessionSummary } from '../../../../shared/schemas/ipc'
import {
  attentionTaskCount,
  buildSidebarTaskGroups,
  directSessionsByRepo,
  groupDirectSessions,
  pinnedProjectsFirst,
  sidebarTaskRank,
  sortSidebarTasks
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
        : { path: `/tmp/wt/${branch}`, branch, baseOid: 'abc', state: 'ready', status: 'active', error: null }
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

describe('sidebar model', () => {
  it('excludes task-owned sessions from the direct-session map', () => {
    const map = directSessionsByRepo(
      [session('direct', 'demo'), session('task', 'demo')],
      new Set(['task'])
    )
    expect(map.get('demo')?.map((entry) => entry.id)).toEqual(['direct'])
  })

  it('groups root sessions and worktrees by branch and keeps order', () => {
    const groups = groupDirectSessions([
      session('root-1', 'demo'),
      session('wt-1', 'demo', 'feat/a'),
      session('root-2', 'demo'),
      session('wt-2', 'demo', 'feat/a')
    ])
    expect(groups.root.map((entry) => entry.id)).toEqual(['root-1', 'root-2'])
    expect(groups.worktrees).toHaveLength(1)
    expect(groups.worktrees[0]?.branch).toBe('feat/a')
    expect(groups.worktrees[0]?.sessions.map((entry) => entry.id)).toEqual(['wt-1', 'wt-2'])
  })

  it('ranks attention before running, queued and finished', () => {
    expect(sidebarTaskRank(task('review', 'demo', 'completed', { reviewDecision: 'pending' }))).toBe(4)
    expect(sidebarTaskRank(task('run', 'demo', 'running'))).toBe(5)
    expect(sidebarTaskRank(task('queue', 'demo', 'queued'))).toBe(6)
    expect(sidebarTaskRank(task('done', 'demo', 'completed', { reviewDecision: 'accepted' }))).toBe(7)
  })

  it('groups tasks by repository and filters Needs-you while excluding archives', () => {
    const groups = buildSidebarTaskGroups(
      [
        task('needs', 'demo', 'failed', { updatedAt: 2 }),
        task('running', 'demo', 'running', { updatedAt: 1 }),
        task('archived', 'api', 'failed', { archivedAt: 1 }),
        task('api-review', 'api', 'completed', { reviewDecision: 'pending' })
      ],
      [repo('demo'), repo('api')],
      true
    )
    expect(groups.map((group) => group.repo.id)).toEqual(['demo', 'api'])
    expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(['needs'])
    expect(groups[1]?.tasks.map((entry) => entry.id)).toEqual(['api-review'])
  })

  it('keeps history mode separate from the active queue', () => {
    const groups = buildSidebarTaskGroups(
      [
        task('active', 'demo', 'running'),
        task('archived', 'demo', 'completed', { archivedAt: 1 })
      ],
      [repo('demo')],
      false,
      true
    )
    expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(['archived'])
  })

  it('preserves repo order and counts attention', () => {
    const demo = repo('demo')
    const api = repo('api')
    const groups = buildSidebarTaskGroups(
      [task('one', 'api', 'running'), task('two', 'demo', 'queued')],
      [demo, api]
    )
    expect(groups.map((group) => group.repo.id)).toEqual(['demo', 'api'])
    expect(attentionTaskCount([task('a', 'demo', 'failed'), task('b', 'demo', 'running')])).toBe(1)
  })

  it('sorts tasks deterministically within a group', () => {
    const sorted = sortSidebarTasks([
      task('old', 'demo', 'queued', { updatedAt: 1 }),
      task('new', 'demo', 'queued', { updatedAt: 3 }),
      task('needs', 'demo', 'failed', { updatedAt: 0 })
    ])
    expect(sorted.map((entry) => entry.id)).toEqual(['needs', 'new', 'old'])
  })

  it('splits pinned projects from the rest without changing order', () => {
    const result = pinnedProjectsFirst([repo('demo'), repo('api'), repo('docs')], ['docs'])
    expect(result.pinned.map((entry) => entry.id)).toEqual(['docs'])
    expect(result.rest.map((entry) => entry.id)).toEqual(['demo', 'api'])
  })
})

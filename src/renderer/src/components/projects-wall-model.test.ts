import { describe, expect, it } from 'vitest'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import {
  attentionEntries,
  attentionLabel,
  filterAndSortProjects,
  PINNED_PROJECTS_KEY,
  projectStats,
  readPinnedProjectIds,
  relativeTimeLabel,
  togglePinnedProject,
  writePinnedProjectIds,
  type ProjectStats
} from './projects-wall-model'

function repo(id: string, overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    id,
    displayName: id,
    path: `/home/oliver/Development/${id}`,
    currentBranch: 'main',
    availability: 'present',
    target: { kind: 'local' },
    preparation: null,
    ...overrides
  }
}

function session(
  id: string,
  repoId: string,
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id,
    repoId,
    title: `Session ${id}`,
    harness: 'claude',
    state: 'live',
    authority: 'host',
    reason: 'host_live',
    incarnationId: 'incarnation',
    exitCode: null,
    error: null,
    updatedAt: 100,
    sleeping: false,
    worktree: null,
    activity: null,
    ...overrides
  }
}

function task(
  id: string,
  repoId: string,
  overrides: Partial<TaskRecordPayload> = {}
): TaskRecordPayload {
  return {
    id,
    repoId,
    title: `Task ${id}`,
    prompt: 'Do the work',
    harness: 'claude',
    status: 'queued',
    sessionId: null,
    worktreePath: null,
    attempt: 1,
    previousTaskId: null,
    scheduleId: null,
    occurrenceAt: null,
    createdAt: 10,
    updatedAt: 10,
    startedAt: null,
    finishedAt: null,
    resultSummary: null,
    error: null,
    errorDetail: null,
    failureReason: null,
    lastObservedState: null,
    exitCode: null,
    reviewDecision: 'pending',
    reviewedAt: null,
    reviewNote: null,
    sessionLive: false,
    canRetry: false,
    canReview: false,
    canDecideReview: false,
    reviewDecisionFinal: false,
    ...overrides
  }
}

describe('project directory model', () => {
  it('derives live work, attention, recency and the project opening mode', () => {
    const project = repo('project')
    const direct = session('direct', 'project', { updatedAt: 30 })
    const taskSession = session('task-session', 'project', { updatedAt: 90 })
    const stats = projectStats(
      project,
      [direct, taskSession],
      [
        task('answer', 'project', {
          status: 'waiting',
          sessionId: 'task-session',
          sessionLive: true,
          updatedAt: 60
        }),
        task('review', 'project', {
          status: 'completed',
          reviewDecision: 'pending',
          finishedAt: 80,
          updatedAt: 80
        })
      ]
    )

    expect(stats.liveSessions).toBe(2)
    expect(stats.directSessions.map((entry) => entry.id)).toEqual(['direct'])
    expect(stats.attention).toEqual({ answer: 1, retry: 0, review: 1, total: 2 })
    expect(stats.lastActivityAt).toBe(90)
    expect(stats.openMode).toBe('sessions')
    expect(attentionLabel(stats.attention)).toBe('Answer 1 · Review 1')

    const taskOnly = projectStats(
      repo('other'),
      [session('owned', 'other')],
      [task('owned-task', 'other', { sessionId: 'owned', status: 'running' })]
    )
    expect(taskOnly.openMode).toBe('tasks')
  })

  it('orders cross-project attention by kind, then oldest first', () => {
    const projects = [repo('a'), repo('b')]
    const entries = attentionEntries(
      [
        task('review-new', 'a', { status: 'completed', reviewDecision: 'pending', finishedAt: 50 }),
        task('retry', 'b', { status: 'failed', updatedAt: 20 }),
        task('answer-new', 'a', { status: 'waiting', updatedAt: 30 }),
        task('answer-old', 'b', { status: 'waiting', updatedAt: 10 }),
        task('ignored', 'a', { status: 'running' })
      ],
      projects
    )

    expect(entries.map((entry) => entry.source === 'task' ? entry.task.id : entry.repo.id)).toEqual([
      'answer-old',
      'answer-new',
      'retry',
      'review-new'
    ])
  })

  it('surfaces a failed first commit as a setup exception', () => {
    const setup = repo('setup', {
      preparation: {
        state: 'failed',
        startedAt: 1,
        finishedAt: 5,
        committedFiles: null,
        skippedFolders: [],
        error: {
          code: 'GIT_COMMIT_FAILED',
          message: 'The first commit failed.',
          retryable: false
        }
      }
    })
    const entries = attentionEntries([], [setup])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('Setup')
    expect(entries[0]?.source).toBe('setup')
  })

  it('pins first, then sorts by attention, live work and recency', () => {
    const pinned = projectStats(repo('pinned'), [], [])
    const attention = projectStats(
      repo('attention'),
      [],
      [task('needs', 'attention', { status: 'failed', updatedAt: 50 })]
    )
    const live = projectStats(
      repo('live'),
      [session('live-session', 'live', { updatedAt: 40 })],
      []
    )
    const setup = projectStats(
      repo('setup', {
        preparation: {
          state: 'failed',
          startedAt: 1,
          finishedAt: 5,
          committedFiles: null,
          skippedFolders: [],
          error: {
            code: 'GIT_COMMIT_FAILED',
            message: 'The first commit failed.',
            retryable: false
          }
        }
      }),
      [],
      []
    )
    const idle = projectStats(repo('idle'), [], [])
    const projects: ProjectStats[] = [idle, live, attention, pinned, setup]

    expect(
      filterAndSortProjects(projects, ['pinned'], 'all', '').map((entry) => entry.repo.id)
    ).toEqual(['pinned', 'setup', 'attention', 'live', 'idle'])
    expect(
      filterAndSortProjects(projects, [], 'needs', '').map((entry) => entry.repo.id)
    ).toEqual(['setup', 'attention'])
    expect(
      filterAndSortProjects(projects, [], 'live', '').map((entry) => entry.repo.id)
    ).toEqual(['live'])
    expect(
      filterAndSortProjects(projects, [], 'idle', '').map((entry) => entry.repo.id)
    ).toEqual(['idle', 'pinned'])
    expect(
      filterAndSortProjects(projects, [], 'pinned', '').map((entry) => entry.repo.id)
    ).toEqual([])
    expect(
      filterAndSortProjects(projects, [], 'all', 'wsl ubuntu').map((entry) => entry.repo.id)
    ).toEqual([])
  })

  it('matches project search against name, path, branch and target', () => {
    const local = projectStats(repo('payments-api', { currentBranch: 'feat/retry' }), [], [])
    const wsl = projectStats(
      repo('docs-site', {
        target: { kind: 'wsl', distro: 'Ubuntu-24.04', distroId: null }
      }),
      [],
      []
    )
    const projects = [local, wsl]

    expect(filterAndSortProjects(projects, [], 'all', 'payments')).toHaveLength(1)
    expect(filterAndSortProjects(projects, [], 'all', 'feat/retry')[0]?.repo.id).toBe('payments-api')
    expect(filterAndSortProjects(projects, [], 'all', 'ubuntu')[0]?.repo.id).toBe('docs-site')
  })

  it('pins without a cap and persists defensively', () => {
    expect(togglePinnedProject([], 'a')).toEqual(['a'])
    expect(togglePinnedProject(['a'], 'a')).toEqual([])
    expect(togglePinnedProject(['a', 'b', 'c'], 'd')).toEqual(['a', 'b', 'c', 'd'])

    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
    writePinnedProjectIds(['a', 'a', 'b'], storage)
    expect(values.get(PINNED_PROJECTS_KEY)).toBe('["a","b"]')
    expect(readPinnedProjectIds(storage)).toEqual(['a', 'b'])

    values.set(PINNED_PROJECTS_KEY, '{"not":"an array"}')
    expect(readPinnedProjectIds(storage)).toEqual([])
  })

  it('formats activity ages without locale dependence', () => {
    const now = 1_000_000_000
    expect(relativeTimeLabel(null, now)).toBe('—')
    expect(relativeTimeLabel(now - 30_000, now)).toBe('now')
    expect(relativeTimeLabel(now - 6 * 60_000, now)).toBe('6m')
    expect(relativeTimeLabel(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relativeTimeLabel(now - 2 * 86_400_000, now)).toBe('2d')
  })
})

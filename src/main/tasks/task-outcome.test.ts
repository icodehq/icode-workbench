import { afterEach, describe, expect, it } from 'vitest'
import { TaskStore } from './task-store'
import { TaskService, type TaskChangesOutcome } from './task-service'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import type { SessionService } from '../sessions/session-service'

/**
 * Task outcome and review decisions.
 *
 * The distinction this file protects: `status` says what the process did, and
 * `reviewDecision` says what a human concluded about the result. Neither may
 * imply the other, and a decision must never perform a Git operation.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

type Harness = {
  store: TaskStore
  service: TaskService
  repoId: string
  workspaceId: string
  clock: { now: number }
  /** Replace the change-listing seam for a case. */
  setChanges: (next: (sessionId: string) => Promise<TaskChangesOutcome>) => void
  /** Sessions this harness pretends exist, by task id. */
  sessions: Map<string, string>
}

async function harness(): Promise<Harness> {
  const root = makeTempRoot('icode-w85-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  const repoDir = `${root.dir}/repo`
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  mkdirSync(repoDir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'pipe' })
  writeFileSync(`${repoDir}/README.md`, 'base\n')
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', repoDir, '-c', 'user.email=w85@test', '-c', 'user.name=W85', 'commit', '-qm', 'base'],
    { stdio: 'pipe' }
  )
  const added = await stores.service.addRepository(repoDir)

  const store = new TaskStore(db)
  const clock = { now: 1_700_000_000_000 }
  const sessions = new Map<string, string>()
  let changes: (sessionId: string) => Promise<TaskChangesOutcome> = async () => ({
    status: 'available',
    files: [],
    baselineOid: 'a'.repeat(40),
    listTruncated: false
  })
  let sequence = 0

  const service = new TaskService({
    tasks: store,
    repositories: stores.repositories,
    sessions: {} as unknown as SessionService,
    now: () => clock.now,
    newId: () => {
      sequence += 1
      return `task_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
    },
    isSessionLive: () => false,
    listChanges: (sessionId) => changes(sessionId),
    onQueueChanged: () => undefined
  })

  cleanups.push(() => {
    db.close()
    root.cleanup()
  })

  return {
    store,
    service,
    repoId: added.repository.id,
    workspaceId: stores.repositories.workspaceForRepo(added.repository.id)!.id,
    clock,
    setChanges: (next) => {
      changes = next
    },
    sessions
  }
}

/** A task that reached a terminal state, with or without changes. */
function finished(
  h: Harness,
  options: { status?: 'completed' | 'failed' | 'cancelled'; withSession?: boolean; worktree?: string } = {}
): string {
  const created = h.service.create({
    repoId: h.repoId as never,
    prompt: 'Do the thing',
    harness: 'claude'
  })
  if (!created.ok) throw new Error(created.error.message)
  const id = created.value.id
  const status = options.status ?? 'completed'
  const sessionId = options.withSession === false ? null : `ses_00000000-0000-4000-8000-0000000000${String(h.sessions.size + 1).padStart(2, '0')}`
  h.store.updateIfStatus(
    id,
    ['queued'],
    {
      status,
      sessionId: sessionId as never,
      worktreePath: options.worktree ?? (sessionId ? `/wt/${sessionId}` : null),
      startedAt: h.clock.now,
      finishedAt: h.clock.now + 1000
    },
    h.clock.now
  )
  return id
}

describe('task outcome facts', () => {
  it('keeps execution status and review decision independent', async () => {
    const h = await harness()
    const id = finished(h, { status: 'completed' })
    const view = h.service.get(id)!
    expect(view.status).toBe('completed')
    // A completed task is NOT accepted: nobody has judged it.
    expect(view.reviewDecision).toBe('pending')
    expect(view.canDecideReview).toBe(true)
    expect(view.reviewDecisionFinal).toBe(false)
  })

  it('exposes failure facts rather than a success shape', async () => {
    const h = await harness()
    const created = h.service.create({ repoId: h.repoId as never, prompt: 'x', harness: 'claude' })
    if (!created.ok) throw new Error('create failed')
    h.store.updateIfStatus(
      created.value.id,
      ['queued'],
      {
        status: 'failed',
        failureReason: 'harness-failed',
        exitCode: 3,
        error: 'The harness exited with code 3.',
        finishedAt: h.clock.now
      },
      h.clock.now
    )
    const view = h.service.get(created.value.id)!
    expect(view.status).toBe('failed')
    expect(view.exitCode).toBe(3)
    expect(view.failureReason).toBe('harness-failed')
    expect(view.resultSummary).toBeNull()
    // A failed task can still be reviewed: its worktree may hold something useful.
    expect(view.canDecideReview).toBe(true)
  })

  it('refuses a decision on a task that is still running', async () => {
    const h = await harness()
    const created = h.service.create({ repoId: h.repoId as never, prompt: 'x', harness: 'claude' })
    if (!created.ok) throw new Error('create failed')
    h.store.updateIfStatus(created.value.id, ['queued'], { status: 'running' }, h.clock.now)

    const result = h.service.decideReview(created.value.id, 'accepted')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('has not finished')
    expect(h.service.get(created.value.id)!.reviewDecision).toBe('pending')
  })
})

describe('review decisions', () => {
  it('records an acceptance with a timestamp', async () => {
    const h = await harness()
    const id = finished(h)
    const result = h.service.decideReview(id, 'accepted', { note: 'Looks right' })
    expect(result.ok).toBe(true)
    const view = h.service.get(id)!
    expect(view.reviewDecision).toBe('accepted')
    expect(view.reviewedAt).toBe(h.clock.now)
    expect(view.reviewNote).toBe('Looks right')
    // Execution status is untouched by the decision.
    expect(view.status).toBe('completed')
  })

  it('records a rejection without changing the task or its files', async () => {
    const h = await harness()
    const id = finished(h, { status: 'failed' })
    const result = h.service.decideReview(id, 'rejected', { note: 'Wrong approach' })
    expect(result.ok).toBe(true)
    const view = h.service.get(id)!
    expect(view.reviewDecision).toBe('rejected')
    // Rejection is a record, not a cleanup: the task keeps its status and worktree.
    expect(view.status).toBe('failed')
    expect(view.worktreePath).not.toBeNull()
  })

  it('is idempotent for the same decision and keeps the first timestamp', async () => {
    const h = await harness()
    const id = finished(h)
    h.service.decideReview(id, 'accepted', { note: 'first' })
    const first = h.service.get(id)!
    h.clock.now += 60_000
    const again = h.service.decideReview(id, 'accepted', { note: 'second' })
    expect(again.ok).toBe(true)
    const after = h.service.get(id)!
    expect(after.reviewedAt).toBe(first.reviewedAt)
    expect(after.reviewNote).toBe('first')
  })

  it('requires explicit confirmation to replace a decision', async () => {
    const h = await harness()
    const id = finished(h)
    h.service.decideReview(id, 'accepted')
    const refused = h.service.decideReview(id, 'rejected')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.message).toContain('already accepted')
    expect(h.service.get(id)!.reviewDecision).toBe('accepted')

    const confirmed = h.service.decideReview(id, 'rejected', { replace: true })
    expect(confirmed.ok).toBe(true)
    expect(h.service.get(id)!.reviewDecision).toBe('rejected')
  })

  it('survives a reopen of the database', async () => {
    const h = await harness()
    const id = finished(h)
    h.service.decideReview(id, 'rejected', { note: 'needs rework' })
    // Reading through the store is what a restart does first.
    const reloaded = h.store.findById(id)!
    expect(reloaded.reviewDecision).toBe('rejected')
    expect(reloaded.reviewNote).toBe('needs rework')
    expect(reloaded.reviewedAt).not.toBeNull()
    expect(reloaded.status).toBe('completed')
  })

  it('does not touch Git: a decision leaves status, branch and files alone', async () => {
    const h = await harness()
    const id = finished(h)
    const before = h.store.findById(id)!
    h.service.decideReview(id, 'accepted')
    const after = h.store.findById(id)!
    expect(after.status).toBe(before.status)
    expect(after.sessionId).toBe(before.sessionId)
    expect(after.worktreePath).toBe(before.worktreePath)
    expect(after.exitCode).toBe(before.exitCode)
  })
})

describe('retry chains stay separate', () => {
  it('gives each attempt its own result and its own decision', async () => {
    const h = await harness()
    const first = finished(h, { status: 'failed' })
    const retried = h.service.retry(first)
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    expect(retried.value.attempt).toBe(2)
    expect(retried.value.previousTaskId).toBe(first)

    h.service.decideReview(first, 'rejected', { note: 'attempt 1 wrong' })
    h.store.updateIfStatus(retried.value.id, ['queued'], { status: 'completed' }, h.clock.now)
    h.service.decideReview(retried.value.id, 'accepted', { note: 'attempt 2 good' })

    const one = h.service.get(first)!
    const two = h.service.get(retried.value.id)!
    expect(one.reviewDecision).toBe('rejected')
    expect(two.reviewDecision).toBe('accepted')
    // The decisions did not leak between attempts.
    expect(one.reviewNote).toBe('attempt 1 wrong')
    expect(two.reviewNote).toBe('attempt 2 good')

    const history = h.service.history(retried.value.id)
    expect(history.map((task) => [task.attempt, task.reviewDecision])).toEqual([
      [1, 'rejected'],
      [2, 'accepted']
    ])
  })
})

describe('task-scoped changes', () => {
  it('lists the changes of the task own session', async () => {
    const h = await harness()
    const id = finished(h)
    const seen: string[] = []
    h.setChanges(async (sessionId) => {
      seen.push(sessionId)
      return {
        status: 'available',
        files: [
          {
            path: 'src/a.ts',
            oldPath: null,
            status: 'modified',
            origin: 'tracked',
            additions: 3,
            deletions: 1,
            binary: false,
            symlink: null
          }
        ],
        baselineOid: 'b'.repeat(40),
        listTruncated: false
      }
    })

    const result = await h.service.changes(id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('available')
    expect(result.value.files).toHaveLength(1)
    expect(result.value.taskId).toBe(id)
    // The session asked about is the task's own, never "the current one".
    expect(seen).toEqual([h.service.get(id)!.sessionId])
  })

  it('passes the review layer verbatim, so an empty worktree reads as empty', async () => {
    const h = await harness()
    const id = finished(h)
    h.setChanges(async () => ({
      status: 'available',
      files: [],
      baselineOid: 'c'.repeat(40),
      listTruncated: false
    }))
    const result = await h.service.changes(id)
    if (!result.ok) throw new Error('unexpected failure')
    expect(result.value.status).toBe('available')
    expect(result.value.files).toEqual([])
  })

  it('reports a missing worktree instead of falling back to another checkout', async () => {
    const h = await harness()
    const id = finished(h)
    h.setChanges(async () => ({
      status: 'unavailable',
      reason: 'worktree-missing',
      detail: 'The session worktree directory is missing.'
    }))
    const result = await h.service.changes(id)
    if (!result.ok) throw new Error('unexpected failure')
    expect(result.value.status).toBe('unavailable')
    expect(result.value.reason).toBe('worktree-missing')
    // And definitively nothing was listed.
    expect(result.value.files).toBeUndefined()
  })

  it('explains that an unstarted task has no changes and asks about no session', async () => {
    const h = await harness()
    const created = h.service.create({ repoId: h.repoId as never, prompt: 'queued', harness: 'claude' })
    if (!created.ok) throw new Error('create failed')
    let asked = 0
    h.setChanges(async () => {
      asked += 1
      return { status: 'available', files: [], baselineOid: 'd'.repeat(40), listTruncated: false }
    })

    const result = await h.service.changes(created.value.id)
    if (!result.ok) throw new Error('unexpected failure')
    expect(result.value.status).toBe('unavailable')
    expect(result.value.reason).toBe('no-session')
    expect(result.value.detail).toContain('has not started')
    // It must not query some other session to fill the gap.
    expect(asked).toBe(0)
  })
})

describe('supervisor review recommendations', () => {
  it('records a recommendation without deciding the review', async () => {
    const h = await harness()
    const id = finished(h)
    const result = h.service.recommendReview(id, 'accept', 'Diff is small and tests pass', 'ses_00000000-0000-4000-8000-000000000099')
    expect(result.ok).toBe(true)

    const view = h.service.get(id)!
    expect(view.reviewDecision).toBe('pending')
    expect(view.reviewRecommendation).toBe('accept')
    expect(view.reviewRecommendationNote).toBe('Diff is small and tests pass')
    expect(view.reviewRecommendedBySessionId).toBe('ses_00000000-0000-4000-8000-000000000099')
    expect(view.canDecideReview).toBe(true)
  })

  it('replaces an older recommendation but still leaves the decision to a person', async () => {
    const h = await harness()
    const id = finished(h)
    expect(h.service.recommendReview(id, 'accept', 'first').ok).toBe(true)
    expect(h.service.recommendReview(id, 'reject', 'second').ok).toBe(true)
    expect(h.service.get(id)!.reviewRecommendation).toBe('reject')
    expect(h.service.get(id)!.reviewRecommendationNote).toBe('second')

    const decided = h.service.decideReview(id, 'accepted', { note: 'I looked' })
    expect(decided.ok).toBe(true)
    expect(h.service.get(id)!.reviewDecision).toBe('accepted')
    expect(h.service.get(id)!.reviewRecommendation).toBe('reject')
    expect(h.service.recommendReview(id, 'accept', 'too late').ok).toBe(false)
  })

  it('refuses a recommendation before the task stops', async () => {
    const h = await harness()
    const created = h.service.create({ repoId: h.repoId as never, prompt: 'running', harness: 'claude' })
    if (!created.ok) throw new Error('create failed')
    const result = h.service.recommendReview(created.value.id, 'accept')
    expect(result.ok).toBe(false)
  })
})

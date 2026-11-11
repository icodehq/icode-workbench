import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepositoryRemovalService } from './repository-removal-service'
import { SessionService } from '../sessions/session-service'
import { FakeHostGateway } from '../sessions/fake-host-gateway'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { MergeStore } from '../persistence/merge-store'
import { RepoRemovalJobStore, type RepoRemovalJobRecord } from '../persistence/repo-removal-job-store'
import { TaskStore } from '../tasks/task-store'
import { SupervisorStore } from '../persistence/supervisor-store'
import { AssistantStore } from '../persistence/assistant-store'
import { makeAppError } from '../../shared/domain/errors'
import { newSessionId, type RepoId } from '../../shared/domain/ids'
import { SessionServiceError } from '../sessions/session-errors'
import type { TempRoot } from '../persistence/persistence-test-fixtures'
import type { Database } from '../persistence/database'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { StopAndWait } from './repository-removal-types'

const cleanups: Array<() => void> = []
const NOW = 1_700_000_000_000

function available(): HarnessDetectionResult {
  return {
    state: 'available',
    harness: 'claude',
    version: '2.1.304',
    resolvedPath: '/usr/bin/claude',
    diagnostics: {
      resolvedPath: '/usr/bin/claude',
      outcome: 'exited',
      exitCode: 0,
      signal: null,
      stdoutTail: '2.1.304',
      stderrTail: '',
      durationMs: 5,
      observedAt: 1,
      attempts: 1
    },
    command: { command: '/usr/bin/claude', args: [] }
  }
}

type Fixture = {
  root: TempRoot
  db: Database
  stores: ReturnType<typeof makeRepositoryService>
  host: FakeHostGateway
  sessions: SessionService
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  jobs: RepoRemovalJobStore
  removals: RepositoryRemovalService
  repoPath: string
  repoId: RepoId
}

async function setup(
  options: { stopAndWait?: StopAndWait } = {}
): Promise<Fixture> {
  const root = makeTempRoot('icode-removal-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  const host = new FakeHostGateway()
  const worktrees = new WorktreeStore(db)
  const gitWorktrees = new GitWorktreeService({ worktreeRoot: join(root.dir, 'worktrees') })
  const sessions = new SessionService({
    database: db,
    repositories: stores.repositories,
    sessions: stores.sessions,
    worktrees,
    gitWorktrees,
    host,
    detectHarness: async () => available(),
    now: () => NOW
  })
  sessions.start()

  const repoPath = join(root.dir, 'atlas')
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath], { stdio: 'pipe' })
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  execFileSync('git', ['-C', repoPath, 'add', 'README.md'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', repoPath, '-c', 'user.email=icode@test', '-c', 'user.name=iCode', 'commit', '-qm', 'init'],
    { stdio: 'pipe' }
  )
  const added = await stores.service.addRepository(repoPath)
  const jobs = new RepoRemovalJobStore(db)
  const mergeStore = new MergeStore(db)
  const removals = new RepositoryRemovalService({
    database: db,
    repositories: stores.repositories,
    sessions: stores.sessions,
    worktrees,
    merges: mergeStore,
    sessionService: {
      stopAndWait: options.stopAndWait ?? ((sessionId) => sessions.stopAndWait(sessionId))
    },
    repositoryService: stores.service,
    mergeService: { abort: vi.fn(async () => ({}) as never) },
    gitWorktrees,
    jobs,
    uiState: stores.uiState,
    gitStatusWatcher: { setActive: vi.fn(async () => ({ watching: false })) },
    filesWatcher: {
      setActive: vi.fn(async () => ({ watching: false as const, reason: 'cancelled' as const }))
    },
    workspaceFiles: {
      discardTrashForSessions: vi.fn(async () => undefined),
      disposeSessions: vi.fn()
    },
    preparations: { cancel: vi.fn() },
    now: () => NOW,
    onTasksPurged: vi.fn(),
    onRepoChanged: vi.fn(),
    onChanged: vi.fn()
  })

  cleanups.push(() => {
    removals.stop()
    sessions.dispose()
    db.close()
    root.cleanup()
  })

  return {
    root,
    db,
    stores,
    host,
    sessions,
    worktrees,
    gitWorktrees,
    jobs,
    removals,
    repoPath,
    repoId: added.repository.id
  }
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

async function waitForJob(
  f: Fixture,
  jobId: string
): Promise<RepoRemovalJobRecord | null> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const job = f.jobs.findById(jobId)
    if (
      job === null ||
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'waiting_host'
    ) {
      return job
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the removal job.')
}

function branches(repoPath: string): string {
  return execFileSync('git', ['-C', repoPath, 'branch', '--format=%(refname:short)'], {
    stdio: 'pipe'
  }).toString('utf8')
}

function keepRefs(repoPath: string): string {
  return execFileSync('git', ['-C', repoPath, 'for-each-ref', 'refs/icode/removed'], {
    stdio: 'pipe'
  }).toString('utf8')
}

describe('instant repository removal', () => {
  it('hides the repository immediately and completes cleanup', async () => {
    const f = await setup()
    const started = await f.removals.start(f.repoId)
    expect(started.status).toBe('removing')
    // The tombstone hides the row from the wall even before the worker runs.
    expect(f.stores.repositories.list()).toHaveLength(0)
    expect(await waitForJob(f, started.jobId)).toBeNull()
    expect(f.stores.repositories.findById(f.repoId)).toBeNull()
    expect(f.stores.service.listRepositories()).toHaveLength(0)
  })

  it('stops a live session, removes its worktree, and keeps its branch', async () => {
    const f = await setup()
    const created = await f.sessions.create({
      repoId: f.repoId,
      harness: 'claude',
      cols: 100,
      rows: 30
    })
    const worktree = f.worktrees.findBySession(created.id)!
    expect(existsSync(worktree.path)).toBe(true)

    const started = await f.removals.start(f.repoId)
    expect(await waitForJob(f, started.jobId)).toBeNull()

    expect(existsSync(worktree.path)).toBe(false)
    expect(branches(f.repoPath)).toContain(worktree.branch)
    expect(f.stores.sessions.listForRepo(f.repoId)).toHaveLength(0)
  })

  it('snapshots tracked and untracked changes, then discards the ref on request', async () => {
    const f = await setup()
    const created = await f.sessions.create({
      repoId: f.repoId,
      harness: 'claude',
      cols: 100,
      rows: 30
    })
    const worktree = f.worktrees.findBySession(created.id)!
    writeFileSync(join(worktree.path, 'untracked.txt'), 'untracked\n')
    writeFileSync(join(worktree.path, 'README.md'), '# changed\n')
    writeFileSync(join(worktree.path, 'ignored.log'), 'ignored\n')
    writeFileSync(join(worktree.path, '.gitignore'), 'ignored.log\n')

    const started = await f.removals.start(f.repoId)
    const job = await waitForJob(f, started.jobId)
    expect(job).not.toBeNull()
    expect(job!.status).toBe('completed')
    expect(job!.manifest.snapshots).toHaveLength(1)
    expect(keepRefs(f.repoPath)).toContain('refs/icode/removed/')
    const files = execFileSync(
      'git',
      ['-C', f.repoPath, 'ls-tree', '-r', '--name-only', job!.manifest.snapshots[0]!.commit],
      { stdio: 'pipe' }
    ).toString('utf8')
    expect(files).toContain('README.md')
    expect(files).toContain('untracked.txt')
    expect(files).not.toContain('ignored.log')
    expect(existsSync(worktree.path)).toBe(false)
    expect(branches(f.repoPath)).toContain(worktree.branch)

    const discarded = await f.removals.discardSnapshots(job!.id)
    expect(discarded.discarded).toBe(1)
    expect(keepRefs(f.repoPath)).toBe('')
    expect(f.jobs.findById(job!.id)).toBeNull()
  })

  it('preserves staged-only changes when the working copy was reverted', async () => {
    const f = await setup()
    const created = await f.sessions.create({
      repoId: f.repoId,
      harness: 'claude',
      cols: 100,
      rows: 30
    })
    const worktree = f.worktrees.findBySession(created.id)!
    writeFileSync(join(worktree.path, 'README.md'), '# staged only\n')
    execFileSync('git', ['-C', worktree.path, 'add', 'README.md'], { stdio: 'pipe' })
    writeFileSync(join(worktree.path, 'README.md'), '# fixture\n')

    const started = await f.removals.start(f.repoId)
    const job = await waitForJob(f, started.jobId)
    expect(job).not.toBeNull()
    expect(job!.manifest.snapshots).toHaveLength(1)
    const commit = job!.manifest.snapshots[0]!.commit
    const staged = execFileSync('git', ['-C', f.repoPath, 'show', `${commit}:README.md`], {
      stdio: 'pipe'
    }).toString('utf8')
    expect(staged).toBe('# staged only\n')
    await f.removals.discardSnapshots(job!.id)
  })

  it('does not wait for a slow host before returning', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const stopAndWait: StopAndWait = async () => {
      await gate
    }
    const f = await setup({ stopAndWait })
    const workspace = f.stores.repositories.workspaceForRepo(f.repoId)!
    f.stores.sessions.insert({
      id: newSessionId(),
      workspaceId: workspace.id,
      harness: 'shell',
      title: 'primary',
      createdAt: NOW,
      lastActiveAt: NOW,
      observation: {
        lastObservedState: 'exited',
        lastObservedExitCode: 0,
        lastObservedError: null,
        lastObservedIncarnationId: null,
        lastObservedAt: NOW
      }
    })

    const started = await f.removals.start(f.repoId)
    expect(f.stores.repositories.list()).toHaveLength(0)
    expect(f.jobs.findById(started.jobId)?.status).toBe('running')
    release()
    expect(await waitForJob(f, started.jobId)).toBeNull()
  })

  it('waits for an unreachable host and retries without unregistering early', async () => {
    let fail = true
    const stopAndWait: StopAndWait = async () => {
      if (fail) {
        throw new SessionServiceError(
          makeAppError('HOST_UNREACHABLE', 'The terminal host is not reachable.')
        )
      }
    }
    const f = await setup({ stopAndWait })
    const workspace = f.stores.repositories.workspaceForRepo(f.repoId)!
    f.stores.sessions.insert({
      id: newSessionId(),
      workspaceId: workspace.id,
      harness: 'shell',
      title: 'primary',
      createdAt: NOW,
      lastActiveAt: NOW,
      observation: {
        lastObservedState: 'exited',
        lastObservedExitCode: 0,
        lastObservedError: null,
        lastObservedIncarnationId: null,
        lastObservedAt: NOW
      }
    })

    const started = await f.removals.start(f.repoId)
    const waiting = await waitForJob(f, started.jobId)
    expect(waiting?.status).toBe('waiting_host')
    expect(f.stores.repositories.list()).toHaveLength(0)
    expect(f.stores.repositories.findById(f.repoId)).not.toBeNull()

    await expect(f.stores.service.addRepository(f.repoPath)).rejects.toMatchObject({
      appError: { code: 'REPOSITORY_REMOVING' }
    })

    fail = false
    await f.removals.retry(started.jobId)
    expect(await waitForJob(f, started.jobId)).toBeNull()
    expect(f.stores.repositories.findById(f.repoId)).toBeNull()
    const readded = await f.stores.service.addRepository(f.repoPath)
    expect(readded.created).toBe(true)
  })

  it('purges tasks, schedules, and occurrences', async () => {
    const f = await setup()
    const workspace = f.stores.repositories.workspaceForRepo(f.repoId)!
    const tasks = new TaskStore(f.db)
    expect(
      tasks.insertSchedule({
        id: 'sch_1',
        repoId: f.repoId,
        title: 'schedule',
        prompt: 'do work',
        harness: 'shell',
        shape: { type: 'once', runAt: NOW },
        overlap: 'queue',
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
        nextRunAt: NOW,
        lastRunAt: null,
        consecutiveFailures: 0,
        lastNote: null
      })
    ).toBe(true)
    expect(
      tasks.reserveOccurrence(
        { id: 'occ_1', scheduleId: 'sch_1', occurrenceAt: NOW, note: null },
        NOW
      )
    ).toBe(true)
    expect(
      tasks.insert(
        {
          id: 'task_1',
          workspaceId: workspace.id,
          repoId: f.repoId,
          title: 'task',
          prompt: 'do work',
          harness: 'shell',
          attempt: 1,
          previousTaskId: null,
          scheduleId: null,
          occurrenceAt: null,
          dedupeKey: null
        },
        NOW
      )
    ).not.toBeNull()

    const supervisors = new SupervisorStore(f.db)
    supervisors.upsert(
      {
        repoId: f.repoId,
        sessionId: newSessionId(),
        controlToken: 'token-1',
        initializedAt: null
      },
      NOW
    )
    supervisors.recordAction({
      repoId: f.repoId,
      sessionId: newSessionId(),
      op: 'test',
      taskId: null,
      outcome: 'ok',
      now: NOW
    })
    new AssistantStore(f.db).recordAction({
      actor: 'system',
      op: 'test',
      repoId: f.repoId,
      outcome: 'ok',
      now: NOW
    })

    const started = await f.removals.start(f.repoId)
    expect(await waitForJob(f, started.jobId)).toBeNull()
    expect(tasks.list({ repoId: f.repoId, includeArchived: true })).toHaveLength(0)
    expect(tasks.listSchedules(f.repoId)).toHaveLength(0)
    const count = (table: string): number =>
      (
        f.db.raw
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repo_id = ?`)
          .get(f.repoId) as { n: number }
      ).n
    expect(count('supervisor_bindings')).toBe(0)
    expect(count('supervisor_actions')).toBe(0)
    expect(count('assistant_actions')).toBe(0)
  })
})

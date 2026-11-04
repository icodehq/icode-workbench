import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RepositoryRemovalService } from './repository-removal-service'
import { SessionService } from '../sessions/session-service'
import { FakeHostGateway } from '../sessions/fake-host-gateway'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { existsSync, writeFileSync } from 'node:fs'
import type { TempRoot } from '../persistence/persistence-test-fixtures'
import type { Database } from '../persistence/database'
import type { HarnessDetectionResult } from '../harness/harness-detector'

const cleanups: Array<() => void> = []

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
  removals: RepositoryRemovalService
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  repoId: string
}

async function setup(): Promise<Fixture> {
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
    now: () => 1_700_000_000_000
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

  const removals = new RepositoryRemovalService({
    repositories: stores.repositories,
    sessions: stores.sessions,
    repositoryService: stores.service,
    host,
    worktrees,
    gitWorktrees,
    summarise: async (repoId) => (await sessions.list(repoId)).sessions
  })

  cleanups.push(() => {
    sessions.dispose()
    db.close()
    root.cleanup()
  })

  return { root, db, stores, host, sessions, removals, worktrees, gitWorktrees, repoId: added.repository.id }
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('repository removal safety', () => {
  it('removes a repository with no sessions', async () => {
    const f = await setup()
    const result = await f.removals.remove(f.repoId, {})
    expect(result).toEqual({ status: 'removed' })
    expect(f.stores.service.listRepositories()).toHaveLength(0)
  })

  it('refuses to remove a repository while an affected PTY is live', async () => {
    const f = await setup()
    const created = await f.sessions.create({
      repoId: f.repoId,
      harness: 'claude',
      cols: 100,
      rows: 30
    })
    const result = await f.removals.remove(f.repoId, {
      acknowledgeDependentSessions: true
    })
    expect(result.status).toBe('blocked_live_sessions')
    if (result.status !== 'blocked_live_sessions') return
    expect(result.sessions.map((session) => session.id)).toEqual([created.id])
    expect(f.stores.service.listRepositories()).toHaveLength(1)
    expect(f.host.calls.kill).toHaveLength(0)
  })

  it('blocks deletion when host state cannot be verified', async () => {
    const f = await setup()
    await f.sessions.create({ repoId: f.repoId, harness: 'claude', cols: 100, rows: 30 })
    f.host.reachable = false
    const result = await f.removals.remove(f.repoId, {
      acknowledgeDependentSessions: true
    })
    expect(result.status).toBe('host_unavailable')
    if (result.status !== 'host_unavailable') return
    expect(result.error.code).toBe('HOST_UNREACHABLE')
    expect(f.stores.service.listRepositories()).toHaveLength(1)
  })

  it('asks for acknowledgement when only stopped sessions would be deleted', async () => {
    const f = await setup()
    const created = await f.sessions.create({
      repoId: f.repoId,
      harness: 'claude',
      cols: 100,
      rows: 30
    })
    f.host.finish(created.id, 0)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const blocked = await f.removals.remove(f.repoId, {})
    expect(blocked.status).toBe('confirmation_required')
    if (blocked.status !== 'confirmation_required') return
    expect(blocked.sessions).toHaveLength(1)
    expect(f.stores.service.listRepositories()).toHaveLength(1)

    const removed = await f.removals.remove(f.repoId, { acknowledgeDependentSessions: true })
    expect(removed).toEqual({ status: 'removed' })
    expect(f.stores.service.listRepositories()).toHaveLength(0)
    expect(f.stores.sessions.listForRepo(f.repoId as never)).toHaveLength(0)
  })

  it('treats a persisted live session the host forgot as removable with acknowledgement', async () => {
    const f = await setup()
    const created = await f.sessions.create({
      repoId: f.repoId,
      harness: 'claude',
      cols: 100,
      rows: 30
    })
    f.host.remove(created.id)
    const pending = await f.removals.remove(f.repoId, {})
    expect(pending.status).toBe('confirmation_required')
    const removed = await f.removals.remove(f.repoId, { acknowledgeDependentSessions: true })
    expect(removed.status).toBe('removed')
  })

  it('rejects an unknown or malformed repository ID', async () => {
    const f = await setup()
    await expect(
      f.removals.remove('repo_00000000-0000-4000-8000-000000000000', {})
    ).rejects.toMatchObject({ appError: { code: 'INVALID_ARGUMENT' } })
    await expect(f.removals.remove('bad-id', {})).rejects.toMatchObject({
      appError: { code: 'INVALID_ARGUMENT' }
    })
  })

  it('blocks repository removal when a worktree holds uncommitted work', async () => {
    const f = await setup()
    const created = await f.sessions.create({
      repoId: f.repoId,
      harness: 'claude',
      cols: 100,
      rows: 30
    })
    f.host.finish(created.id, 0, true)
    writeFileSync(join(created.worktree!.path, 'dirty.txt'), 'work\n')

    const result = await f.removals.remove(f.repoId, { acknowledgeDependentSessions: true })
    expect(result.status).toBe('blocked_worktree_changes')
    if (result.status === 'blocked_worktree_changes') {
      expect(result.blockers[0]!.blocker.kind).toBe('dirty')
    }
    expect(f.stores.service.listRepositories()).toHaveLength(1)
    expect(existsSync(created.worktree!.path)).toBe(true)
  })

  it('removes clean worktrees and retains their branches', async () => {
    const f = await setup()
    const created = await f.sessions.create({
      repoId: f.repoId,
      harness: 'claude',
      cols: 100,
      rows: 30
    })
    f.host.finish(created.id, 0, true)
    const worktree = created.worktree!
    const branch = worktree.branch

    const result = await f.removals.remove(f.repoId, { acknowledgeDependentSessions: true })
    expect(result.status).toBe('removed')
    expect(existsSync(worktree.path)).toBe(false)
    expect(f.stores.service.listRepositories()).toHaveLength(0)
    // The branch survives repository removal.
    const branches = execFileSync('git', ['-C', join(f.root.dir, 'atlas'), 'branch', '--list'], {
      encoding: 'utf8'
    })
    expect(branches).toContain(branch)
  })

  it('removes only the addressed repository', async () => {
    const f = await setup()
    const secondPath = join(f.root.dir, 'console')
    mkdirSync(secondPath, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', secondPath], { stdio: 'pipe' })
    const second = await f.stores.service.addRepository(secondPath)

    await f.removals.remove(f.repoId, {})
    const remaining = f.stores.service.listRepositories()
    expect(remaining.map((entry) => entry.repository.id)).toEqual([second.repository.id])
  })
})

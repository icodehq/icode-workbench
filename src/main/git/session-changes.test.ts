import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import type { RepositoryService } from '../repositories/repository-service'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { SessionService } from '../sessions/session-service'
import { SessionServiceError } from '../sessions/session-errors'
import { FakeHostGateway } from '../sessions/fake-host-gateway'
import { readSessionChanges, type SessionChangesDeps } from './session-changes'
import { newSessionId } from '../../shared/domain/ids'
import type { Database } from '../persistence/database'
import type { RepositoryStore } from '../persistence/repository-store'
import type { SessionStore } from '../persistence/session-store'
import type { TempRoot } from '../persistence/persistence-test-fixtures'
import type { RepoId } from '../../shared/domain/ids'

type Fixture = {
  root: TempRoot
  db: Database
  repoPath: string
  repoId: RepoId
  repositories: RepositoryStore
  sessionStore: SessionStore
  repositoryService: RepositoryService
  sessions: SessionService
  review: { list: (sessionId: string) => ReturnType<typeof readSessionChanges> }
  host: FakeHostGateway
  worktrees: WorktreeStore
  createSession: () => Promise<{ id: string; worktreePath: string; baseOid: string }>
}

const cleanups: Array<() => void> = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

async function setup(): Promise<Fixture> {
  const root = makeTempRoot('icode-review-svc-')
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
    detectHarness: async () => ({
      state: 'available',
      harness: 'claude',
      version: '1.0.0',
      resolvedPath: '/usr/bin/claude',
      command: { command: '/usr/bin/claude', args: [] },
      diagnostics: {
        resolvedPath: '/usr/bin/claude',
        outcome: 'exited',
        exitCode: 0,
        signal: null,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1,
        observedAt: 1,
        attempts: 1
      }
    }),
    now: () => 1_700_000_000_000
  })
  sessions.start()

  const repoPath = join(root.dir, 'atlas')
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath], { stdio: 'pipe' })
  writeFileSync(join(repoPath, 'a.txt'), 'one\ntwo\n')
  git(repoPath, 'add', '.')
  execFileSync(
    'git',
    ['-C', repoPath, '-c', 'user.email=icode@test', '-c', 'user.name=iCode', 'commit', '-qm', 'init'],
    { stdio: 'pipe' }
  )
  const added = await stores.service.addRepository(repoPath)

  const changesDeps: SessionChangesDeps = {
    sessions,
    repositories: stores.repositories,
    worktrees,
    gitWorktrees
  }

  cleanups.push(() => {
    sessions.dispose()
    db.close()
    root.cleanup()
  })

  const fixture: Fixture = {
    root,
    db,
    repoPath,
    repoId: added.repository.id,
    repositories: stores.repositories,
    sessionStore: stores.sessions,
    repositoryService: stores.service,
    sessions,
    review: { list: (sessionId) => readSessionChanges(changesDeps, sessionId) },
    host,
    worktrees,
    createSession: async () => {
      const summary = await sessions.create({
        repoId: added.repository.id,
        harness: 'claude',
        cols: 100,
        rows: 30
      })
      return {
        id: summary.id,
        worktreePath: summary.worktree!.path,
        baseOid: summary.worktree!.baseOid
      }
    }
  }
  return fixture
}

function codeOf(error: unknown): string | undefined {
  return error instanceof SessionServiceError ? error.appError.code : undefined
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('review availability', () => {
  it('reviews a live session without asking the Host', async () => {
    const f = await setup()
    const session = await f.createSession()
    writeFileSync(join(session.worktreePath, 'a.txt'), 'one\nTWO\n')

    f.host.reachable = false
    const result = await f.review.list(session.id)
    expect(result.status).toBe('available')
    if (result.status === 'available') {
      expect(result.baselineOid).toBe(session.baseOid)
      expect(result.files.map((file) => file.path)).toContain('a.txt')
    }
    // Review never touches PTY lifecycle.
    expect(f.host.calls.createOrAttach).toHaveLength(1)
  })

  it('reviews an exited session identically', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.host.finish(session.id, 0, true)
    writeFileSync(join(session.worktreePath, 'fresh.txt'), 'new\n')

    const result = await f.review.list(session.id)
    expect(result.status).toBe('available')
    if (result.status === 'available') {
      expect(result.files.map((file) => file.path)).toContain('fresh.txt')
    }
  })

  it('explains a legacy session instead of inventing a baseline', async () => {
    const f = await setup()
    const workspace = f.repositories.workspaceForRepo(f.repoId)!
    const legacyId = newSessionId()
    f.sessionStore.insert({
      id: legacyId,
      workspaceId: workspace.id,
      harness: 'shell',
      title: 'legacy',
      createdAt: 1,
      lastActiveAt: 1,
      observation: {
        lastObservedState: 'exited',
        lastObservedExitCode: 0,
        lastObservedError: null,
        lastObservedIncarnationId: null,
        lastObservedAt: 1
      }
    })

    const result = await f.review.list(legacyId)
    expect(result).toMatchObject({ status: 'unavailable', reason: 'primary-checkout' })
  })

  it('reports a missing worktree and never falls back to the primary checkout', async () => {
    const f = await setup()
    const session = await f.createSession()
    renameSync(session.worktreePath, `${session.worktreePath}-moved`)

    const result = await f.review.list(session.id)
    expect(result).toMatchObject({ status: 'unavailable', reason: 'worktree-missing' })
    // The primary checkout is untouched and still has no review surface.
    expect(git(f.repoPath, 'status', '--porcelain')).toBe('')
  })

  it('reports an unregistered worktree directory as inconsistent', async () => {
    const f = await setup()
    const session = await f.createSession()
    execFileSync('git', ['-C', f.repoPath, 'worktree', 'remove', '--force', session.worktreePath])
    mkdirSync(session.worktreePath, { recursive: true })
    writeFileSync(join(session.worktreePath, 'stray.txt'), 'x\n')

    const result = await f.review.list(session.id)
    expect(result).toMatchObject({ status: 'unavailable', reason: 'worktree-inconsistent' })
  })

  it('reports a deleted baseline commit', async () => {
    const f = await setup()
    const session = await f.createSession()
    // A second worktree keeps the branch reachable; delete the baseline object
    // by pruning reflogs is impractical, so simulate with an unknown OID.
    f.db.raw
      .prepare(
        `UPDATE worktrees SET base_oid = ?
         WHERE id = (SELECT worktree_id FROM session_worktree_links WHERE session_id = ?)`
      )
      .run('a'.repeat(40), session.id)

    const result = await f.review.list(session.id)
    expect(result).toMatchObject({ status: 'unavailable', reason: 'invalid-baseline' })
  })

  it('throws SESSION_NOT_FOUND for an unknown session', async () => {
    const f = await setup()
    await expect(f.review.list(newSessionId())).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'SESSION_NOT_FOUND'
    )
  })
})

describe('review content', () => {
  it('lists changes for a session', async () => {
    const f = await setup()
    const session = await f.createSession()
    writeFileSync(join(session.worktreePath, 'a.txt'), 'one\nTWO\n')
    writeFileSync(join(session.worktreePath, 'fresh.txt'), 'hello\n')

    const list = await f.review.list(session.id)
    if (list.status !== 'available') throw new Error('expected available')
    const paths = list.files.map((file) => file.path)
    expect(paths).toEqual(expect.arrayContaining(['a.txt', 'fresh.txt']))
  })

  it('reviews a stopped session and leaves the worktree clean', async () => {
    const f = await setup()
    const session = await f.createSession()
    writeFileSync(join(session.worktreePath, 'a.txt'), 'one\nCHANGED\n')
    await f.sessions.stop(session.id)

    const before = git(session.worktreePath, 'status', '--porcelain')
    const result = await f.review.list(session.id)
    expect(result.status).toBe('available')
    expect(git(session.worktreePath, 'status', '--porcelain')).toBe(before)
  })
})

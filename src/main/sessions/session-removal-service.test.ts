import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openTempDatabase, makeRepositoryService, makeTempRoot } from '../persistence/persistence-test-fixtures'
import type { TempRoot } from '../persistence/persistence-test-fixtures'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { SessionService } from './session-service'
import { SessionRemovalService } from './session-removal-service'
import { SessionServiceError } from './session-errors'
import { FakeHostGateway } from './fake-host-gateway'
import type { Database } from '../persistence/database'
import type { SessionSummary } from '../../shared/schemas/ipc'
import { newSessionId } from '../../shared/domain/ids'

type Fixture = {
  root: TempRoot
  db: Database
  host: FakeHostGateway
  sessions: SessionService
  removals: SessionRemovalService
  worktrees: WorktreeStore
  git: GitWorktreeService
  repoId: string
  repoPath: string
  createSession: () => Promise<SessionSummary>
  finish: (sessionId: string) => void
}

const cleanups: Array<() => void> = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

async function setup(): Promise<Fixture> {
  const root = makeTempRoot('ade-removal-session-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  const host = new FakeHostGateway()
  const worktrees = new WorktreeStore(db)
  const gitService = new GitWorktreeService({ worktreeRoot: join(root.dir, 'worktrees') })
  const sessions = new SessionService({
    database: db,
    repositories: stores.repositories,
    sessions: stores.sessions,
    worktrees,
    gitWorktrees: gitService,
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
  writeFileSync(join(repoPath, 'README.md'), '# atlas\\n')
  git(repoPath, 'add', 'README.md')
  execFileSync('git', [
    '-C',
    repoPath,
    '-c',
    'user.email=ade@test',
    '-c',
    'user.name=ADE',
    'commit',
    '-qm',
    'init'
  ])
  const added = await stores.service.addRepository(repoPath)

  const removals = new SessionRemovalService({
    database: db,
    sessions: stores.sessions,
    repositories: stores.repositories,
    worktrees,
    gitWorktrees: gitService,
    host,
    summarise: (sessionId) => sessions.get(sessionId)
  })

  cleanups.push(() => {
    sessions.dispose()
    db.close()
    root.cleanup()
  })

  return {
    root,
    db,
    host,
    sessions,
    removals,
    worktrees,
    git: gitService,
    repoId: added.repository.id,
    repoPath,
    createSession: () =>
      sessions.create({
        repoId: added.repository.id,
        harness: 'claude',
        cols: 100,
        rows: 30
      }),
    finish: (sessionId) => host.finish(sessionId, 0, true)
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof SessionServiceError ? error.appError.code : undefined
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('ordinary session removal', () => {
  it('blocks while the PTY is live', async () => {
    const f = await setup()
    const session = await f.createSession()
    const result = await f.removals.remove(session.id)
    expect(result.status).toBe('blocked_live_sessions')
    expect(f.worktrees.findBySession(session.id)).not.toBeNull()
    expect(existsSync(session.worktree!.path)).toBe(true)
  })

  it('stops a live PTY when Remove asks to stop it first', async () => {
    const f = await setup()
    const session = await f.createSession()
    const result = await f.removals.remove(session.id, { stopIfLive: true })
    expect(result.status).toBe('removed')
    expect(f.host.calls.kill.some((entry) => entry.sessionId === session.id)).toBe(true)
    expect(f.worktrees.findBySession(session.id)).toBeNull()
  })

  it('fails closed when the host cannot be reached', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.host.reachable = false

    const result = await f.removals.remove(session.id)
    expect(result.status).toBe('host_unavailable')
    expect(f.worktrees.findBySession(session.id)).not.toBeNull()
    expect(existsSync(session.worktree!.path)).toBe(true)
  })

  it('blocks on uncommitted changes and never deletes them', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.finish(session.id)
    writeFileSync(join(session.worktree!.path, 'agent.txt'), 'work in progress\\n')

    const result = await f.removals.remove(session.id)
    expect(result.status).toBe('blocked_worktree')
    if (result.status === 'blocked_worktree') {
      expect(result.blocker.kind).toBe('dirty')
      expect(result.blocker.files).toContain('agent.txt')
    }
    expect(existsSync(join(session.worktree!.path, 'agent.txt'))).toBe(true)
    expect(f.worktrees.findBySession(session.id)).not.toBeNull()
  })

  it('blocks on unmerged commits', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.finish(session.id)
    writeFileSync(join(session.worktree!.path, 'work.txt'), 'x\\n')
    git(session.worktree!.path, 'add', 'work.txt')
    execFileSync('git', [
      '-C',
      session.worktree!.path,
      '-c',
      'user.email=ade@test',
      '-c',
      'user.name=ADE',
      'commit',
      '-qm',
      'work'
    ])

    const result = await f.removals.remove(session.id)
    expect(result.status).toBe('blocked_worktree')
    if (result.status === 'blocked_worktree') {
      expect(result.blocker.kind).toBe('unmerged')
      expect(result.blocker.commits).toBe(1)
    }
    expect(existsSync(session.worktree!.path)).toBe(true)
  })

  it('removes a clean worktree and retains the branch and its ownership', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.finish(session.id)
    const worktree = session.worktree!

    const result = await f.removals.remove(session.id)
    expect(result).toEqual({ status: 'removed', branch: worktree.branch, branchRetained: true })

    expect(existsSync(worktree.path)).toBe(false)
    expect(f.worktrees.findBySession(session.id)).toBeNull()
    await expect(f.git.branchExists(f.repoPath, worktree.branch)).resolves.toBe(true)
    expect(f.worktrees.findBranch(worktree.branch)).not.toBeNull()
    await expect(f.sessions.get(session.id)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'SESSION_NOT_FOUND'
    )
  })

  it('blocks when the worktree directory has vanished', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.finish(session.id)
    execFileSync('rm', ['-rf', session.worktree!.path])

    const result = await f.removals.remove(session.id)
    expect(result.status).toBe('blocked_worktree')
    if (result.status === 'blocked_worktree') expect(result.blocker.kind).toBe('missing')
    expect(f.worktrees.findBySession(session.id)).not.toBeNull()
  })
})

describe('explicit discard', () => {
  it('requires the exact branch name', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.finish(session.id)
    writeFileSync(join(session.worktree!.path, 'agent.txt'), 'work\\n')

    await expect(f.removals.discard(session.id, 'wrong')).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT'
    )
    expect(existsSync(session.worktree!.path)).toBe(true)
  })

  it('discards a dirty worktree but keeps the branch', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.finish(session.id)
    writeFileSync(join(session.worktree!.path, 'agent.txt'), 'work\\n')

    const result = await f.removals.discard(session.id, session.worktree!.branch)
    expect(result.status).toBe('discarded')
    if (result.status === 'discarded') {
      expect(result.files).toContain('agent.txt')
      expect(result.branchRetained).toBe(true)
    }
    expect(existsSync(session.worktree!.path)).toBe(false)
    await expect(f.git.branchExists(f.repoPath, session.worktree!.branch)).resolves.toBe(true)
    expect(f.worktrees.findBranch(session.worktree!.branch)).not.toBeNull()
  })

  it('refuses to discard when the worktree is missing', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.finish(session.id)
    execFileSync('rm', ['-rf', session.worktree!.path])

    const result = await f.removals.discard(session.id, session.worktree!.branch)
    expect(result.status).toBe('blocked_worktree')
    if (result.status === 'blocked_worktree') expect(result.blocker.kind).toBe('missing')
  })

  it('refuses to discard while the PTY is live', async () => {
    const f = await setup()
    const session = await f.createSession()
    const result = await f.removals.discard(session.id, session.worktree!.branch)
    expect(result.status).toBe('blocked_live_sessions')
    expect(existsSync(session.worktree!.path)).toBe(true)
  })
})

describe('owned branch deletion', () => {
  it('refuses branches ADE did not create', async () => {
    const f = await setup()
    await expect(f.removals.removeBranch(f.repoId, 'main')).resolves.toEqual({
      status: 'not_owned',
      branch: 'main'
    })
  })

  it('is blocked while a worktree still uses the branch', async () => {
    const f = await setup()
    const session = await f.createSession()
    const result = await f.removals.removeBranch(f.repoId, session.worktree!.branch)
    expect(result).toEqual({
      status: 'blocked_worktree',
      branch: session.worktree!.branch,
      path: session.worktree!.path
    })
  })

  it('requires the exact branch name when commits are unmerged', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.finish(session.id)
    writeFileSync(join(session.worktree!.path, 'work.txt'), 'x\\n')
    git(session.worktree!.path, 'add', 'work.txt')
    execFileSync('git', [
      '-C',
      session.worktree!.path,
      '-c',
      'user.email=ade@test',
      '-c',
      'user.name=ADE',
      'commit',
      '-qm',
      'work'
    ])
    // Ordinary removal is blocked by the unmerged commit; discard removes the
    // checkout while keeping the branch and its commits.
    expect((await f.removals.remove(session.id)).status).toBe('blocked_worktree')
    const discarded = await f.removals.discard(session.id, session.worktree!.branch)
    expect(discarded.status).toBe('discarded')
    const branch = session.worktree!.branch

    const listed = await f.removals.listBranches(f.repoId)
    expect(listed.find((entry) => entry.branch === branch)).toMatchObject({
      exists: true,
      unmergedCommits: 1,
      worktreePath: null
    })

    await expect(f.removals.removeBranch(f.repoId, branch)).resolves.toEqual({
      status: 'confirmation_required',
      branch,
      commits: 1
    })
    await expect(f.git.branchExists(f.repoPath, branch)).resolves.toBe(true)

    await expect(f.removals.removeBranch(f.repoId, branch, branch)).resolves.toEqual({
      status: 'removed',
      branch
    })
    await expect(f.git.branchExists(f.repoPath, branch)).resolves.toBe(false)
    expect(f.worktrees.findBranch(branch)).toBeNull()
  })

  it('deletes a merged branch without a typed confirmation', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.finish(session.id)
    const branch = session.worktree!.branch
    await f.removals.remove(session.id)
    git(f.repoPath, 'merge', '--ff-only', branch)

    await expect(f.removals.removeBranch(f.repoId, branch)).resolves.toEqual({
      status: 'removed',
      branch
    })
    await expect(f.git.branchExists(f.repoPath, branch)).resolves.toBe(false)
  })
})

describe('failed creation cleanup', () => {
  it('removes a failed session that never produced a worktree or branch', async () => {
    const f = await setup()
    // Simulate a creation that failed before Git created anything.
    const id = newSessionId()
    const workspace = f.db.raw
      .prepare('SELECT id FROM workspaces LIMIT 1')
      .get() as { id: string }
    f.db.raw
      .prepare(
        `INSERT INTO sessions (id, workspace_id, harness, title, created_at, last_active_at,
           last_observed_state, last_observed_exit_code, last_observed_error_json,
           last_observed_incarnation_id, last_observed_at)
         VALUES (?, ?, 'shell', 'failed create', 1, 1, 'failed', NULL, NULL, NULL, 1)`
      )
      .run(id, workspace.id)
    f.worktrees.insert({
      sessionId: id,
      repoId: f.repoId as never,
      path: join(f.root.dir, 'worktrees', 'never-created'),
      branch: `ade/${id}`,
      baseRef: 'main',
      baseOid: 'a'.repeat(40),
      state: 'failed',
      error: null,
      createdAt: 1,
      updatedAt: 1
    })
    f.host.seedSession(id, { status: 'exited', exitCode: 1 })

    const result = await f.removals.remove(id)
    expect(result.status).toBe('removed')
    expect(f.worktrees.findBySession(id)).toBeNull()
  })

  it('still blocks when only the directory is missing but the branch exists', async () => {
    const f = await setup()
    const session = await f.createSession()
    f.finish(session.id)
    execFileSync('rm', ['-rf', session.worktree!.path])

    const result = await f.removals.remove(session.id)
    expect(result.status).toBe('blocked_worktree')
    if (result.status === 'blocked_worktree') expect(result.blocker.kind).toBe('missing')
  })
})

/**
 * A WSL session's worktree lives in its distro, so every probe on the removal path
 * must name the execution target.
 *
 * Regression: `worktreeBlocker` inspected without one, so on Windows the guest
 * path was `statSync`ed locally, found absent, and reported `missing` — a live,
 * registered worktree that the user could never remove or discard. Invisible on a
 * Linux controller, where the guest path happened to exist there too.
 */
describe('removal probes the repository target', () => {
  it('inspects a WSL worktree through the distro, not this machine', async () => {
    const target = {
      kind: 'wsl' as const,
      distro: 'Ubuntu-26.04',
      distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
    }
    const seen: unknown[] = []
    const repoId = 'repo_a5489bf0-0000-4000-8000-000000000001'
    const sessionId = newSessionId()
    const worktreePath = '/home/you/.ade/worktrees/s/repo/ses'

    const removals = new SessionRemovalService({
      database: { transaction: (run: () => void) => run() } as never,
      sessions: {
        findById: () => ({
          id: sessionId,
          workspaceId: 'ws_1',
          harness: 'claude',
          title: 'agent'
        }),
        delete: () => undefined
      } as never,
      repositories: {
        findById: () => ({
          id: repoId,
          path: '/home/you/atlas',
          displayName: 'atlas',
          executionTarget: target
        }),
        findWorkspaceById: () => ({ id: 'ws_1', repoId, path: '/home/you/atlas' })
      } as never,
      worktrees: {
        findBySession: () => ({
          sessionId,
          repoId,
          path: worktreePath,
          branch: 'ade/ses',
          state: 'ready'
        }),
        deleteBySession: () => undefined
      } as never,
      gitWorktrees: {
        inspect: async (input: { target?: unknown }) => {
          seen.push(input.target)
          // What a distro-aware probe answers for a present worktree.
          return {
            pathExists: true,
            registered: true,
            headOid: 'abc',
            dirtyFiles: [],
            unmergedCommits: 0
          }
        },
        remove: async () => undefined,
        hostFsFor: async () => ({ exists: async () => true }),
        branchExists: async () => true,
        countUnmerged: async () => 0
      } as never,
      host: {
        listSessions: async () => ({ sessions: [], orphans: [] })
      } as never,
      summarise: async () => ({}) as never
    })

    const result = await removals.remove(sessionId)
    expect(result.status).toBe('removed')
    // The probe must be told where the worktree actually lives.
    expect(seen).toEqual([target])
  })
})

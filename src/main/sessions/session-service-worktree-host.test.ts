import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openTempDatabase, makeTempRoot } from '../persistence/persistence-test-fixtures'
import { RepositoryStore } from '../persistence/repository-store'
import { SessionStore } from '../persistence/session-store'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { SessionService } from './session-service'
import { FakeHostGateway } from './fake-host-gateway'
import { newRepoId, newSessionId, newWorkspaceId, toPtyIncarnationId } from '../../shared/domain/ids'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { GitExecutorRouter } from '../git/executor'
import { toCanonicalRepositoryPath } from '../../shared/domain/paths'

/**
 * Session list status for a checkout that lives in a distro.
 *
 * The controller cannot `statSync` a guest path, so asking the local filesystem
 * made every healthy WSL worktree report `missing`. The UI turns that into a
 * warning and, worse, disables Restart — so a recovered session could be looked
 * at but never restarted.
 */

const GUEST_PATH = '/home/u/.ade/worktrees/scope/repo_x/ses_y'
const WSL_TARGET: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
}
const LOCAL_TARGET: ExecutionTarget = { kind: 'local' }

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup(options: { guestExists: boolean; resolveFails?: boolean; target?: ExecutionTarget }) {
  const root = makeTempRoot('ade-session-wsl-')
  const db = openTempDatabase(root)
  const repositories = new RepositoryStore(db)
  const sessions = new SessionStore(db)
  const worktrees = new WorktreeStore(db)
  const repoPath = join(root.dir, 'atlas')
  mkdirSync(repoPath, { recursive: true })

  const asked: string[] = []
  const router: GitExecutorRouter = {
    resolve: async () => {
      if (options.resolveFails) throw new Error('wsl.exe: the distro did not answer')
      return {
        executor: {
          exec: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false })
        },
        worktreeRoot: '/home/u/.ade/worktrees',
        fs: {
          isDirectory: async (path: string) => {
            asked.push(path)
            return options.guestExists
          },
          exists: async () => options.guestExists,
          ensureParentDirectory: async () => undefined,
          isEmptyDirectory: async () => false,
          removeDirectory: async () => undefined
        }
      }
    }
  }
  const gitWorktrees = new GitWorktreeService({ worktreeRoot: join(root.dir, 'worktrees'), router })

  const service = new SessionService({
    database: db,
    repositories,
    sessions,
    worktrees,
    gitWorktrees,
    host: new FakeHostGateway(),
    detectHarness: async () => ({
      state: 'available',
      harness: 'claude',
      version: '2.1.310',
      resolvedPath: '/home/u/bin/claude',
      command: { command: '/bin/bash', args: ['-ilc', "exec '/home/u/bin/claude'"] },
      diagnostics: {
        resolvedPath: '/home/u/bin/claude',
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
  service.start()

  const repoId = newRepoId()
  const workspaceId = newWorkspaceId()
  repositories.insert({
    id: repoId,
    path: toCanonicalRepositoryPath(repoPath),
    displayName: 'atlas',
    addedAt: 1,
    lastOpenedAt: 1,
    currentBranch: 'main',
    availability: 'present',
    gitCommonDir: null,
    executionTarget: options.target ?? WSL_TARGET
  })
  repositories.insertWorkspace({
    id: workspaceId,
    repoId,
    path: toCanonicalRepositoryPath(repoPath),
    kind: 'primary-checkout',
    createdAt: 1
  })

  const sessionId = newSessionId()
  sessions.insert({
    id: sessionId,
    workspaceId,
    harness: 'claude',
    title: 'guest session',
    createdAt: 1,
    lastActiveAt: 1,
    observation: {
      lastObservedState: 'exited',
      lastObservedExitCode: 0,
      lastObservedError: null,
      lastObservedIncarnationId: toPtyIncarnationId('inc_guest_0001'),
      lastObservedAt: 1
    }
  })
  const worktreePath = options.target?.kind === 'local' ? join(root.dir, 'worktrees', 'local-wt') : GUEST_PATH
  if (options.target?.kind === 'local') mkdirSync(worktreePath, { recursive: true })
  worktrees.insert({
    sessionId,
    repoId,
    path: worktreePath,
    branch: `ade/${sessionId}`,
    baseRef: 'main',
    baseOid: 'a'.repeat(40),
    state: 'ready',
    error: null,
    createdAt: 1,
    updatedAt: 1
  })

  cleanups.push(() => {
    service.dispose()
    db.close()
    root.cleanup()
  })

  return { service, sessionId, asked, worktreePath }
}

describe('session list worktree status', () => {
  it('asks the distro, not the local filesystem, for a guest worktree', async () => {
    const f = setup({ guestExists: true })
    const view = await f.service.list()
    const row = view.sessions.find((s) => s.id === f.sessionId)!
    // The path does not exist on this machine at all.
    expect(f.asked).toContain(GUEST_PATH)
    expect(row.worktree?.status).not.toBe('missing')
    expect(row.worktree?.status).toBe('ready-to-start')
  })

  it('still reports a genuinely absent guest worktree as missing', async () => {
    const f = setup({ guestExists: false })
    const view = await f.service.list()
    expect(view.sessions.find((s) => s.id === f.sessionId)!.worktree?.status).toBe('missing')
  })

  it('does not invent missing when the distro cannot be reached', async () => {
    const f = setup({ guestExists: true, resolveFails: true })
    const view = await f.service.list()
    const status = view.sessions.find((s) => s.id === f.sessionId)!.worktree?.status
    // Unresolved: the record says ready and the host never answered.
    expect(status).not.toBe('missing')
  })

  it('keeps the local path unchanged (no router call for local repositories)', async () => {
    const f = setup({ guestExists: false, target: LOCAL_TARGET })
    const view = await f.service.list()
    expect(f.asked).toHaveLength(0)
    expect(view.sessions.find((s) => s.id === f.sessionId)!.worktree?.status).toBe('ready-to-start')
  })

  it('reports a local worktree that really is gone as missing', async () => {
    const f = setup({ guestExists: false, target: LOCAL_TARGET })
    rmSync(f.worktreePath, { recursive: true, force: true })
    const view = await f.service.list()
    expect(view.sessions.find((s) => s.id === f.sessionId)!.worktree?.status).toBe('missing')
  })
})

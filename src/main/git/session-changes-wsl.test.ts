import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeRepositoryService, makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { SessionService } from '../sessions/session-service'
import { FakeHostGateway } from '../sessions/fake-host-gateway'
import type { GitReadResult } from './bounded-read'
import { GitWorkspaceService } from './git-workspace-service'
import { readChangeList, type ReadContext } from './change-reader'
import { assertContained, guestContainment, localContainment } from './path-safety'
import type { ChangeDiffInput } from '../../shared/schemas/changes'
import type { ChangeDiffOutcome, ChangeListOutcome } from '../../shared/domain/changes'
import { newSessionId, toPtyIncarnationId } from '../../shared/domain/ids'
import type { GitExecutorRouter } from '../git/executor'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { Database } from '../persistence/database'
import type { RepositoryStore } from '../persistence/repository-store'
import type { SessionStore } from '../persistence/session-store'
import type { TempRoot } from '../persistence/persistence-test-fixtures'
import type { SessionWorktreeRecord } from '../../shared/domain/worktree'

/**
 * Review of a session whose checkout lives inside a distro.
 *
 * The defect this file exists for: the controller cannot `statSync` a guest
 * path, so a *host* filesystem check reported every healthy WSL worktree as
 * missing and the guest reader was never reached.
 *
 * The simulation is a real Git repository whose paths are exposed under a guest
 * root (`/home/u`). Every Git answer therefore comes from real Git and the real
 * parsers; only the *location* is translated, which is exactly the boundary a
 * distro sits behind. No Git output is hand-written.
 */

const GUEST_HOST_ROOT = '/home/u'
const WSL_TARGET: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
}

type Fixture = {
  root: TempRoot
  db: Database
  repoPath: string
  repositories: RepositoryStore
  sessionStore: SessionStore
  worktrees: WorktreeStore
  changes: {
    list: (sessionId: string) => Promise<ChangeListOutcome>
    diffArea: (input: ChangeDiffInput) => Promise<ChangeDiffOutcome>
  }
  /** Real path standing in for the guest filesystem. */
  guestHome: string
  seedSession: (options?: { dirtyGit?: boolean }) => {
    sessionId: string
    guestPath: string
    realPath: string
    baseOid: string
  }
}

const cleanups: Array<() => void> = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function toSlash(value: string): string {
  return value.replace(/\\/gu, '/')
}

async function setup(options: { resolveTargetFails?: boolean } = {}): Promise<Fixture> {
  const root = makeTempRoot('icode-review-wsl-')
  const db = openTempDatabase(root)
  const stores = makeRepositoryService(db)
  const host = new FakeHostGateway()
  const worktrees = new WorktreeStore(db)

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
  const baseOid = git(repoPath, 'rev-parse', 'HEAD')
  const added = await stores.service.addRepository(repoPath)

  // The guest view of that same repository: /home/u/atlas -> <tmp>/guest-home/atlas
  const guestHome = join(root.dir, 'guest-home')
  mkdirSync(guestHome, { recursive: true })
  execFileSync('git', ['-C', repoPath, 'worktree', 'add', '-q', '--detach', join(guestHome, 'atlas'), baseOid], {
    stdio: 'pipe'
  })

  // Only guest paths are translated. The repository record still holds the real
  // controller path in this fixture, and must be passed through untouched.
  const toReal = (candidate: string): string =>
    candidate.startsWith(`${GUEST_HOST_ROOT}/`)
      ? join(guestHome, candidate.slice(GUEST_HOST_ROOT.length).replace(/^\/+/u, ''))
      : candidate
  // Git prints the real location; the controller would only ever see the guest one.
  // Windows adds two spellings (8.3 short name and long name) and may vary case,
  // so replace every known spelling rather than only the mkdtemp one.
  const toGuest = (text: string): string => {
    const variants = new Set([
      toSlash(guestHome),
      toSlash(realpathSync.native(guestHome)),
      toSlash(root.dir),
      toSlash(realpathSync.native(root.dir))
    ])
    let out = text
    for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
      const pattern = new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu')
      out = out.replace(pattern, GUEST_HOST_ROOT)
    }
    return out
  }

  const guestGit = async (request: { cwd: string; args: readonly string[] }) => {
    try {
      const stdout = execFileSync('git', ['-C', toReal(request.cwd), ...request.args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
      })
      return {
        stdout: Buffer.from(toGuest(stdout), 'utf8'),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        timedOut: false
      }
    } catch (error) {
      const failure = error as { status?: number; stderr?: Buffer | string; stdout?: Buffer | string }
      return {
        stdout: Buffer.from(toGuest(String(failure.stdout ?? '')), 'utf8'),
        stderr: Buffer.from(toGuest(String(failure.stderr ?? '')), 'utf8'),
        exitCode: typeof failure.status === 'number' ? failure.status : 1,
        timedOut: false
      }
    }
  }

  const router: GitExecutorRouter = {
    resolve: async () => {
      if (options.resolveTargetFails) {
        throw new Error('wsl.exe: the distro did not answer')
      }
      return {
        executor: { exec: guestGit, read: guestRead },
        read: guestRead,
        symlinkProbe: async (worktreePath: string, relativePath: string) => {
          try {
            execFileSync('test', ['-L', join(toReal(worktreePath), relativePath)], { stdio: 'pipe' })
            return true
          } catch {
            return false
          }
        },
        worktreeRoot: `${GUEST_HOST_ROOT}/.icode/worktrees`,
        fs: {
          // The guest filesystem: a guest path *is* present here, even though the
          // controller cannot see it.
          isDirectory: async (path: string) => {
            try {
              execFileSync('test', ['-d', toReal(path)], { stdio: 'pipe' })
              return true
            } catch {
              return false
            }
          },
          exists: async (path: string) => {
            try {
              execFileSync('test', ['-e', toReal(path)], { stdio: 'pipe' })
              return true
            } catch {
              return false
            }
          },
          ensureParentDirectory: async () => undefined,
          isEmptyDirectory: async () => false,
          removeDirectory: async () => undefined
        }
      }
    }
  }

  const gitWorktrees = new GitWorktreeService({
    worktreeRoot: join(root.dir, 'worktrees'),
    router
  })

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
      version: '2.1.310',
      resolvedPath: '/home/u/.nvm/bin/claude',
      command: { command: '/bin/bash', args: ['-ilc', "exec '/home/u/.nvm/bin/claude'"] },
      diagnostics: {
        resolvedPath: '/home/u/.nvm/bin/claude',
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

  // The stored repository says "this checkout lives in a distro".
  const wslRepositories = {
    findById: (id: Parameters<RepositoryStore['findById']>[0]) => {
      const found = stores.repositories.findById(id)
      return found === null ? null : { ...found, executionTarget: WSL_TARGET }
    }
  } as unknown as RepositoryStore

  // The guest read function, in the same shape the composition root supplies
  // (`createGuestReviewReader`), so this test exercises the real selection path.
  const guestRead = async (request: { cwd: string; args: string[]; byteBudget?: number }): Promise<GitReadResult> => {
    const result = await guestGit(request)
    return {
      stdout: result.stdout.toString('utf8'),
      stderrTail: result.stderr.toString('utf8').trim(),
      exitCode: result.exitCode,
      signal: null,
      truncated: false,
      truncatedReason: null
    }
  }

  const gitWorkspace = new GitWorkspaceService({
    sessions,
    repositories: wslRepositories,
    worktrees,
    gitWorktrees
  })

  cleanups.push(() => {
    sessions.dispose()
    db.close()
    root.cleanup()
  })

  return {
    root,
    db,
    repoPath,
    repositories: stores.repositories,
    sessionStore: stores.sessions,
    worktrees,
    changes: {
      list: (sessionId) => gitWorkspace.sessionChanges(sessionId),
      diffArea: (input) => gitWorkspace.changeDiff(input)
    },
    guestHome,
    seedSession: () => {
      const sessionId = newSessionId()
      const workspace = stores.repositories.workspaceForRepo(added.repository.id)!
      const guestPath = `${GUEST_HOST_ROOT}/.icode/worktrees/scope/${added.repository.id}/${sessionId}`
      const realPath = toReal(guestPath)
      mkdirSync(realPath, { recursive: true })
      // A checkout the distro really has, at the path the record claims.
      execFileSync('git', ['-C', repoPath, 'worktree', 'add', '-q', '--detach', realPath, baseOid], {
        stdio: 'pipe'
      })

      stores.sessions.insert({
        id: sessionId,
        workspaceId: workspace.id,
        harness: 'claude',
        title: 'wsl session',
        createdAt: 1,
        lastActiveAt: 1,
        observation: {
          lastObservedState: 'live',
          lastObservedExitCode: null,
          lastObservedError: null,
          lastObservedIncarnationId: toPtyIncarnationId('inc_wsl_00000001'),
          lastObservedAt: 1
        }
      })
      const record: SessionWorktreeRecord = {
        sessionId,
        repoId: added.repository.id,
        path: guestPath,
        branch: `icode/${sessionId}`,
        baseRef: 'main',
        baseOid,
        state: 'ready',
        error: null,
        createdAt: 1,
        updatedAt: 1
      }
      worktrees.insert(record)
      return { sessionId, guestPath, realPath, baseOid }
    }
  }
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('WSL change listing and working-tree diffs', () => {
  it('does not treat a guest worktree path as missing (AC-01)', async () => {
    const f = await setup()
    const session = f.seedSession()

    // The premise: the controller genuinely cannot see this path.
    expect(() => execFileSync('test', ['-d', session.guestPath], { stdio: 'pipe' })).toThrow()

    const result = await f.changes.list(session.sessionId)
    expect(result.status).toBe('available')
    // The old code answered worktree-missing here; the detail is only produced
    // when the *distro* says the directory is gone.
    expect(result).not.toMatchObject({ reason: 'worktree-missing' })
  })

  it('lists tracked changes from the distro Git (AC-02)', async () => {
    const f = await setup()
    const session = f.seedSession()
    writeFileSync(join(session.realPath, 'a.txt'), 'one\nTWO\n')

    const result = await f.changes.list(session.sessionId)
    if (result.status !== 'available') throw new Error(`expected available, got ${JSON.stringify(result)}`)
    expect(result.baselineOid).toBe(session.baseOid)
    const file = result.files.find((entry) => entry.path === 'a.txt')
    expect(file).toBeDefined()
    expect(file).toMatchObject({ status: 'modified', origin: 'tracked' })
  })

  it('includes an untracked file created inside the distro (AC-03)', async () => {
    const f = await setup()
    const session = f.seedSession()
    writeFileSync(join(session.realPath, 'fresh.txt'), 'hello\n')

    const result = await f.changes.list(session.sessionId)
    if (result.status !== 'available') throw new Error('expected available')
    const untracked = result.files.find((entry) => entry.path === 'fresh.txt')
    expect(untracked).toMatchObject({ area: 'untracked', origin: 'untracked', status: 'added' })
  })

  it('reads a working-tree diff through the guest reader (AC-04)', async () => {
    const f = await setup()
    const session = f.seedSession()
    writeFileSync(join(session.realPath, 'a.txt'), 'one\nTWO\n')
    writeFileSync(join(session.realPath, 'fresh.txt'), 'hello\n')

    const modified = await f.changes.diffArea({
      sessionId: session.sessionId,
      path: 'a.txt',
      oldPath: null,
      scope: 'unstaged',
      status: 'modified',
      binary: false,
      symlink: false,
      additions: null,
      deletions: null
    })
    if (modified.status !== 'available') throw new Error('expected available')
    expect(modified.patch).toContain('+TWO')
    expect(modified.fileStatus).toBe('modified')

    const added = await f.changes.diffArea({
      sessionId: session.sessionId,
      path: 'fresh.txt',
      oldPath: null,
      scope: 'untracked',
      status: 'added',
      binary: false,
      symlink: false,
      additions: null,
      deletions: null
    })
    if (added.status !== 'available') throw new Error('expected available')
    expect(added.patch).toContain('+hello')
  })

  it('reports a genuinely absent guest worktree as missing', async () => {
    const f = await setup()
    const session = f.seedSession()
    execFileSync('git', ['-C', f.repoPath, 'worktree', 'remove', '--force', session.realPath], {
      stdio: 'pipe'
    })

    const result = await f.changes.list(session.sessionId)
    expect(result).toMatchObject({ status: 'unavailable', reason: 'worktree-missing' })
    if (result.status === 'unavailable') expect(result.detail).toContain('inside its distro')
  })

  it('does not disguise a distro that cannot be reached as a missing worktree (AC-06)', async () => {
    const f = await setup({ resolveTargetFails: true })
    const session = f.seedSession()

    const result = await f.changes.list(session.sessionId)
    expect(result).toMatchObject({ status: 'unavailable', reason: 'worktree-inconsistent' })
    if (result.status === 'unavailable') {
      expect(result.detail).toContain('could not be inspected inside its distro')
      expect(result.detail).not.toContain('missing')
    }
  })
})

describe('guest path containment', () => {
  it('accepts a guest path that the controller dialect would reject', () => {
    // The Windows dialect is what a Windows controller uses by default. On a
    // guest path it resolves `/tmp/x` onto the current drive and rejects the
    // file, which is exactly the bug this dialect exists to prevent.
    const windowsDialect = {
      realpath: (value: string) => value,
      resolve: (root: string, child: string) => win32.resolve(root, child),
      dirname: (value: string) => win32.dirname(value),
      separator: '\\'
    }

    expect(() => assertContained('/tmp/wt/ses', 'a.txt', windowsDialect)).toThrow()
    expect(() => assertContained('/tmp/wt/ses', 'a.txt', guestContainment)).not.toThrow()
    expect(() => assertContained('/tmp/wt/ses', 'sub/dir/b.txt', guestContainment)).not.toThrow()
  })

  it('still refuses traversal and absolute paths', () => {
    expect(() => assertContained('/tmp/wt/ses', '../etc/passwd', guestContainment)).toThrow()
    expect(() => assertContained('/tmp/wt/ses', '/etc/passwd', guestContainment)).toThrow()
    expect(() => assertContained('/tmp/wt/ses', 'a/../../b', guestContainment)).toThrow()
  })
})

/**
 * Work 82 recorded a real misreport: untracked symlink detection used the
 * controller's `lstatSync` on a guest path. The call threw ENOENT, the catch set
 * `false`, and the UI said "regular file" about a file nobody had asked the
 * right filesystem about.
 *
 * The probe now travels with the checkout, and "cannot tell" stays `null`.
 */
describe('untracked symlink detection', () => {
  function emptyRead(): Promise<{
    stdout: string
    stderrTail: string
    exitCode: number
    signal: null
    truncated: boolean
    truncatedReason: null
  }> {
    return Promise.resolve({
      stdout: '',
      stderrTail: '',
      exitCode: 0,
      signal: null,
      truncated: false,
      truncatedReason: null
    })
  }

  it("asks the checkout's own host and reports what it says", async () => {
    const asked: string[] = []
    const context: ReadContext = {
      read: async (options) => {
        const args = options.args.join(' ')
        if (args.startsWith('ls-files')) {
          return {
            stdout: 'link-to-elsewhere\u0000plain.txt\u0000',
            stderrTail: '',
            exitCode: 0,
            signal: null,
            truncated: false,
            truncatedReason: null
          }
        }
        return emptyRead()
      },
      containment: localContainment,
      // The probe is the distro's answer: one path is a link, the other is not.
      symlinkProbe: async (_worktreePath, relativePath) => {
        asked.push(relativePath)
        return relativePath === 'link-to-elsewhere' ? true : false
      }
    }

    const list = await readChangeList(context, {
      worktreePath: '/home/u/wt',
      baseOid: 'a'.repeat(40),
      sessionId: 'ses_x'
    })
    expect(asked).toEqual(['link-to-elsewhere', 'plain.txt'])
    expect(list.files.find((file) => file.path === 'link-to-elsewhere')?.symlink).toBe(true)
    expect(list.files.find((file) => file.path === 'plain.txt')?.symlink).toBe(false)
  })

  it('reports unknown, never false, when the target cannot answer', async () => {
    const context: ReadContext = {
      read: async (options) => {
        const args = options.args.join(' ')
        if (args.startsWith('ls-files')) {
          return {
            stdout: 'maybe-link\u0000',
            stderrTail: '',
            exitCode: 0,
            signal: null,
            truncated: false,
            truncatedReason: null
          }
        }
        return emptyRead()
      },
      containment: localContainment,
      // An unreachable distro: the question was never answered.
      symlinkProbe: async () => null
    }

    const list = await readChangeList(context, {
      worktreePath: '/home/u/wt',
      baseOid: 'a'.repeat(40),
      sessionId: 'ses_x'
    })
    const entry = list.files.find((file) => file.path === 'maybe-link')
    expect(entry?.symlink).toBeNull()
    expect(entry?.symlink).not.toBe(false)
  })
})

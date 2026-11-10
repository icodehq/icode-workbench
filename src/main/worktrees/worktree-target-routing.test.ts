import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { WslCommandRunner, type WslByteResult } from '../wsl/exec'
import { GitUnavailableError, createGitExecutorRouter } from '../git/executor'
import {
  CREATE_WORKTREE_SENTINEL,
  GUEST_CREATE_WORKTREE_SCRIPT,
  GUEST_INSPECT_FOR_CREATE_SCRIPT,
  INSPECT_FOR_CREATE_SENTINEL
} from '../wsl/git/guest-session-scripts'
import { makeTempRoot } from '../persistence/persistence-test-fixtures'
import { GitWorktreeService } from './git-worktree-service'

const WSL: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
}

/**
 * A scripted guest, so the assertion is about *routing*: which host each Git and
 * filesystem question reached. Real guest behaviour is exercised in the
 * real-binary run, not here.
 */
/** Answers the login-shell probe as a distro with Git on PATH does. */
function probeAnswer(): Buffer {
  return Buffer.concat([
    Buffer.from('__ICODE_GIT_OUT_START__'),
    Buffer.from('/usr/local/bin:/usr/bin:/bin\u0000/usr/bin/git\u0000/home/u'),
    Buffer.from('__ICODE_GIT_OUT_END____ICODE_GIT_STATUS__0')
  ])
}

function isProbe(guest: readonly string[]): boolean {
  return guest[1] === '-lc' && (guest[2] ?? '').includes('command -v git')
}

function gitArgv(guest: readonly string[]): { cwd: string; args: string[] } | null {
  const dashC = guest.indexOf('-C')
  if (dashC === -1) return null
  return { cwd: guest[dashC + 1] ?? '', args: guest.slice(dashC + 2) }
}

function guestRunner(handlers: {
  git?: (cwd: string, args: string[]) => { code: number; stdout?: string; stderr?: string }
  exists?: (path: string) => boolean
  directories?: string[]
  transportScript?: boolean
}) {
  const calls: { kind: 'git' | 'fs' | 'script'; cwd?: string; args?: string[]; path?: string }[] = []
  const markers = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'BISECT_LOG'
  ]
  const bytes = (stdout: string, code = 0): WslByteResult => ({
    code,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    timedOut: false
  })
  const answerGit = (cwd: string, args: string[], record = true) => {
    if (record) calls.push({ kind: 'git', cwd, args })
    return handlers.git?.(cwd, args) ?? { code: 1, stderr: 'unexpected' }
  }
  const batch = (guest: readonly string[]): WslByteResult | null => {
    const index = guest.findIndex(
      (part) => part === GUEST_INSPECT_FOR_CREATE_SCRIPT || part === GUEST_CREATE_WORKTREE_SCRIPT
    )
    if (index === -1) return null
    calls.push({ kind: 'script', args: guest.slice(index + 2) })
    if (handlers.transportScript === true) {
      return { code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: true }
    }
    const args = guest.slice(index + 2)
    if (guest[index] === GUEST_INSPECT_FOR_CREATE_SCRIPT) {
      const workspace = args[1] ?? ''
      const root = args[2] ?? ''
      const workspacePresent = handlers.directories?.includes(workspace) ?? true
      const verify = answerGit(root, ['rev-parse', '--verify', 'HEAD'])
      const head = verify.code === 0 ? answerGit(root, ['rev-parse', 'HEAD']) : null
      const ref = verify.code === 0 ? answerGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']) : null
      const operation = markers.find((marker) => handlers.exists?.(`${root}/.git/${marker}`)) ?? ''
      return bytes(
        [
          INSPECT_FOR_CREATE_SENTINEL,
          `workspace=${workspacePresent ? 'present' : 'missing'}`,
          'root=present',
          'git=present',
          `verify_status=${verify.code}`,
          `head=${verify.code === 0 ? (head?.stdout ?? '').trim() : ''}`,
          `ref=${verify.code === 0 ? (ref?.stdout ?? '').trim() : ''}`,
          `operation=${operation}`,
          INSPECT_FOR_CREATE_SENTINEL
        ].join('\n')
      )
    }
    const primaryRoot = args[1] ?? ''
    const path = args[2] ?? ''
    const branch = args[3] ?? ''
    const baseOid = args[4] ?? ''
    if (handlers.exists?.(path)) {
      return bytes([CREATE_WORKTREE_SENTINEL, 'exists=1', CREATE_WORKTREE_SENTINEL].join('\n'))
    }
    const addArgs = ['worktree', 'add', '-b', branch, path, baseOid]
    const add = answerGit(primaryRoot, addArgs)
    if (add.code !== 0) {
      return bytes(
        [
          CREATE_WORKTREE_SENTINEL,
          'exists=0',
          'mkdir=0',
          `add=${add.code}`,
          'add_begin',
          add.stderr ?? '',
          'add_end',
          CREATE_WORKTREE_SENTINEL
        ].join('\n')
      )
    }
    const top = answerGit(path, ['rev-parse', '--show-toplevel'])
    const head = answerGit(path, ['rev-parse', 'HEAD'])
    const list = answerGit(primaryRoot, ['worktree', 'list', '--porcelain'])
    return bytes(
      [
        CREATE_WORKTREE_SENTINEL,
        'exists=0',
        'mkdir=0',
        'add=0',
        'add_begin',
        'add_end',
        `toplevel=${(top.stdout ?? '').trim()}`,
        `head=${(head.stdout ?? '').trim()}`,
        'worktrees_begin',
        (list.stdout ?? '').trim(),
        'worktrees_end',
        CREATE_WORKTREE_SENTINEL
      ].join('\n')
    )
  }
  const byteLauncher = async (spec: { args: readonly string[] }): Promise<WslByteResult> => {
    const args = [...spec.args]
    const guest = args.slice(args.indexOf('--exec') + 1)
    if (isProbe(guest)) {
      return { code: 0, signal: null, stdout: probeAnswer(), stderr: Buffer.alloc(0), timedOut: false }
    }
    const batched = batch(guest)
    if (batched !== null) return batched
    const resolved = gitArgv(guest)
    if (resolved !== null) {
      const { cwd, args: gitArgs } = resolved
      calls.push({ kind: 'git', cwd, args: gitArgs })
      const answer = handlers.git?.(cwd, gitArgs) ?? { code: 1, stderr: 'unexpected' }
      return {
        code: answer.code,
        signal: null,
        stdout: Buffer.from(answer.stdout ?? ''),
        stderr: Buffer.from(answer.stderr ?? ''),
        timedOut: false
      }
    }
    if (guest[0] === 'sh' && guest[1] === '-c') {
      const path = guest[4] ?? ''
      calls.push({ kind: 'fs', path, args: [guest[2] ?? ''] })
      const exists = handlers.exists?.(path) ?? false
      const script = guest[2] ?? ''
      if (script.startsWith('test -d')) return result(exists ? 0 : 1)
      if (script.startsWith('test -e')) return result(exists ? 0 : 1)
      if (script.includes('ls -A')) return result(0)
      return result(0)
    }
    calls.push({ kind: 'fs', path: '', args: guest })
    return result(0)
  }
  function result(code: number): WslByteResult {
    return { code, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false }
  }
  return { runner: new WslCommandRunner({ byteLauncher, platform: 'win32' }), calls }
}

function serviceWith(runner: WslCommandRunner, localRoot: string) {
  return new GitWorktreeService({
    worktreeRoot: localRoot,
    router: createGitExecutorRouter({
      localWorktreeRoot: localRoot,
      runner,
      guestWorktreeRoot: async () => '/home/u/.icode/worktrees/scope'
    })
  })
}

describe('WSL worktree routing', () => {
  it('runs listWorktrees in the guest', async () => {
    const { runner, calls } = guestRunner({
      git: (_cwd, args) =>
        args.join(' ') === 'worktree list --porcelain'
          ? { code: 0, stdout: 'worktree /home/u/src/atlas\nHEAD aaa\n\n' }
          : { code: 1 }
    })
    const service = serviceWith(runner, '/local/worktrees')
    const list = await service.listWorktrees('/home/u/src/atlas', WSL)
    expect(list[0]?.path).toBe('/home/u/src/atlas')
    expect(calls.every((call) => call.kind === 'git' && call.cwd === '/home/u/src/atlas')).toBe(true)
  })

  it('creates a worktree with the guest path and the guest root check', async () => {
    const { runner, calls } = guestRunner({
      exists: (path) => path === '/home/u/src/atlas/.git/MERGE_HEAD',
      git: (_cwd, args) => {
        const joined = args.join(' ')
        if (joined.startsWith('worktree add')) return { code: 0 }
        if (joined === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: '/home/u/.icode/worktrees/scope/r1/s1\n' }
        }
        if (joined === 'rev-parse HEAD') return { code: 0, stdout: 'base1\n' }
        if (joined === 'worktree list --porcelain') {
          return {
            code: 0,
            stdout: 'worktree /home/u/src/atlas\n\nworktree /home/u/.icode/worktrees/scope/r1/s1\n'
          }
        }
        return { code: 1 }
      }
    })
    const service = serviceWith(runner, '/local/worktrees')
    await service.create({
      primaryRoot: '/home/u/src/atlas',
      path: '/home/u/.icode/worktrees/scope/r1/s1',
      branch: 'icode/session-1',
      baseOid: 'base1',
      target: WSL
    })
    const add = calls.find((call) => call.kind === 'git' && call.args?.[0] === 'worktree')
    expect(add?.cwd).toBe('/home/u/src/atlas')
    expect(add?.args).toContain('/home/u/.icode/worktrees/scope/r1/s1')
  })

  it('refuses a path outside the guest managed root', async () => {
    const { runner } = guestRunner({})
    const service = serviceWith(runner, '/local/worktrees')
    await expect(
      service.create({
        primaryRoot: '/home/u/src/atlas',
        path: '/home/u/elsewhere',
        branch: 'b',
        baseOid: 'o',
        target: WSL
      })
    ).rejects.toMatchObject({ appError: { code: 'WORKTREE_INCONSISTENT' } })
  })

  it('accepts a guest path even though it does not start with the local root', async () => {
    // The local managed root is a Windows path; a guest path must be judged
    // against the guest root, or every WSL worktree would be rejected.
    const { runner } = guestRunner({
      git: (_cwd, args) => {
        const joined = args.join(' ')
        if (joined === 'worktree list --porcelain') {
          return { code: 0, stdout: 'worktree /home/u/src/atlas\n\nworktree /home/u/.icode/worktrees/scope/r1/s1\n' }
        }
        if (joined === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: '/home/u/.icode/worktrees/scope/r1/s1\n' }
        }
        if (joined === 'rev-parse HEAD') return { code: 0, stdout: 'o1\n' }
        return { code: 0 }
      }
    })
    const service = serviceWith(runner, '/local/worktrees')
    await expect(service.worktreeRootFor(WSL)).resolves.toBe('/home/u/.icode/worktrees/scope')
    expect(() =>
      service.assertManagedPath('/home/u/.icode/worktrees/scope/r1/s1', '/home/u/.icode/worktrees/scope')
    ).not.toThrow()
  })

  it('inspects a guest worktree with guest Git', async () => {
    const { runner, calls } = guestRunner({
      exists: () => true,
      git: (_cwd, args) => {
        const joined = args.join(' ')
        if (joined === 'worktree list --porcelain') {
          return { code: 0, stdout: 'worktree /home/u/src/atlas\n\nworktree /home/u/wt\n' }
        }
        if (joined === 'rev-parse HEAD') return { code: 0, stdout: 'aaa\n' }
        if (joined === 'status --porcelain') return { code: 0, stdout: ' M src/a.ts\n' }
        if (joined.startsWith('rev-list')) return { code: 0, stdout: '0\n' }
        return { code: 1 }
      }
    })
    const service = serviceWith(runner, '/local/worktrees')
    const inspected = await service.inspect({
      primaryRoot: '/home/u/src/atlas',
      path: '/home/u/wt',
      branch: 'b',
      target: WSL
    })
    expect(inspected.pathExists).toBe(true)
    expect(inspected.dirtyFiles).toHaveLength(1)
    expect(inspected.headOid).toBe('aaa')
    expect(calls.some((call) => call.kind === 'fs')).toBe(true)
  })

  it('serializes concurrent creates per host, not across hosts', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const { runner } = guestRunner({
      git: (_cwd, args) => {
        if (args.join(' ').startsWith('worktree add')) {
          concurrent += 1
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          concurrent -= 1
          return { code: 0 }
        }
        if (args.join(' ') === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: '/home/u/.icode/worktrees/scope/r1/s1\n' }
        }
        if (args.join(' ') === 'rev-parse HEAD') return { code: 0, stdout: 'o\n' }
        if (args.join(' ') === 'worktree list --porcelain') {
          return { code: 0, stdout: 'worktree /home/u/src/atlas\n\nworktree /home/u/.icode/worktrees/scope/r1/s1\n' }
        }
        return { code: 0 }
      }
    })
    const service = serviceWith(runner, '/local/worktrees')
    const create = () =>
      service.create({
        primaryRoot: '/home/u/src/atlas',
        path: '/home/u/.icode/worktrees/scope/r1/s1',
        branch: 'b',
        baseOid: 'o',
        target: WSL
      })
    await Promise.all([create(), create()])
    // Two creates for one repository never overlap.
    expect(maxConcurrent).toBeLessThanOrEqual(1)
  }, 15_000)

  it('reads workspace and repository state in one guest script', async () => {
    const { runner, calls } = guestRunner({
      git: (_cwd, args) => {
        const joined = args.join(' ')
        if (joined === 'rev-parse --verify HEAD') return { code: 0, stdout: 'abc\n' }
        if (joined === 'rev-parse HEAD') return { code: 0, stdout: 'abc\n' }
        if (joined === 'rev-parse --abbrev-ref HEAD') return { code: 0, stdout: 'main\n' }
        return { code: 1 }
      }
    })
    const service = serviceWith(runner, '/local/worktrees')
    const state = await service.inspectForCreate({
      workspacePath: '/home/u/src',
      primaryRoot: '/home/u/src',
      target: WSL
    })
    expect(state).toEqual({
      headOid: 'abc',
      headRef: 'main',
      unborn: false,
      inProgressOperation: null
    })
    expect(calls.filter((call) => call.kind === 'script')).toHaveLength(1)
  })

  it('reports a missing workspace as CWD_MISSING from the same script', async () => {
    const { runner } = guestRunner({ directories: [] })
    const service = serviceWith(runner, '/local/worktrees')
    await expect(
      service.inspectForCreate({
        workspacePath: '/home/u/missing',
        primaryRoot: '/home/u/src',
        target: WSL
      })
    ).rejects.toMatchObject({ appError: { code: 'CWD_MISSING' } })
  })

  it('reports an in-progress operation from the same script', async () => {
    const { runner } = guestRunner({
      exists: (path) => path === '/home/u/src/.git/MERGE_HEAD',
      git: (_cwd, args) => {
        const joined = args.join(' ')
        if (joined === 'rev-parse --verify HEAD') return { code: 0, stdout: 'abc\n' }
        if (joined === 'rev-parse HEAD') return { code: 0, stdout: 'abc\n' }
        if (joined === 'rev-parse --abbrev-ref HEAD') return { code: 0, stdout: 'main\n' }
        return { code: 1 }
      }
    })
    const service = serviceWith(runner, '/local/worktrees')
    const state = await service.inspectForCreate({
      workspacePath: '/home/u/src',
      primaryRoot: '/home/u/src',
      target: WSL
    })
    expect(state.inProgressOperation).toBe('MERGE_HEAD')
  })

  it('reports a transport failure on the read script as unavailable, after one retry', async () => {
    const { runner, calls } = guestRunner({ transportScript: true })
    const service = serviceWith(runner, '/local/worktrees')
    await expect(
      service.inspectForCreate({
        workspacePath: '/home/u/src',
        primaryRoot: '/home/u/src',
        target: WSL
      })
    ).rejects.toBeInstanceOf(GitUnavailableError)
    expect(calls.filter((call) => call.kind === 'script')).toHaveLength(2)
  })

  it('never retries the create mutation and reports an unknown outcome', async () => {
    const { runner, calls } = guestRunner({ transportScript: true })
    const service = serviceWith(runner, '/local/worktrees')
    await expect(
      service.create({
        primaryRoot: '/home/u/src/atlas',
        path: '/home/u/.icode/worktrees/scope/r1/s1',
        branch: 'icode/session-1',
        baseOid: 'base1',
        target: WSL
      })
    ).rejects.toMatchObject({
      appError: {
        code: 'WORKTREE_CREATE_FAILED',
        detail: expect.stringContaining('may or may not')
      }
    })
    expect(calls.filter((call) => call.kind === 'script')).toHaveLength(1)
  })

  it('maps a failed add to WORKTREE_CREATE_FAILED with Git output', async () => {
    const { runner } = guestRunner({
      git: (_cwd, args) =>
        args.join(' ').startsWith('worktree add')
          ? { code: 128, stderr: 'fatal: already checked out' }
          : { code: 1 }
    })
    const service = serviceWith(runner, '/local/worktrees')
    await expect(
      service.create({
        primaryRoot: '/home/u/src/atlas',
        path: '/home/u/.icode/worktrees/scope/r1/s1',
        branch: 'icode/session-1',
        baseOid: 'base1',
        target: WSL
      })
    ).rejects.toMatchObject({
      appError: {
        code: 'WORKTREE_CREATE_FAILED',
        detail: expect.stringContaining('already checked out')
      }
    })
  })
})

describe('local worktree behaviour is unchanged', () => {
  it('still runs on the local filesystem and local Git', async () => {
    const root = makeTempRoot('icode-w6-local-')
    try {
      const localRoot = join(root.dir, 'worktrees')
      mkdirSync(localRoot, { recursive: true })
      const service = new GitWorktreeService({ worktreeRoot: localRoot })
      await expect(service.worktreeRootFor({ kind: 'local' })).resolves.toBe(localRoot)
      expect(() => service.assertManagedPath(join(localRoot, 'r1', 's1'))).not.toThrow()
      expect(() => service.assertManagedPath('/tmp/not-managed')).toThrow()
      expect(statSync(localRoot).isDirectory()).toBe(true)
    } finally {
      root.cleanup()
    }
  })

  it('refuses a local path outside the local root, as before', async () => {
    const root = makeTempRoot('icode-w6-local2-')
    try {
      const service = new GitWorktreeService({ worktreeRoot: join(root.dir, 'worktrees') })
      await expect(
        service.remove({ primaryRoot: '/x', path: '/not/managed', force: true })
      ).rejects.toMatchObject({ appError: { code: 'WORKTREE_INCONSISTENT' } })
    } finally {
      root.cleanup()
    }
  })
})

describe('adversarial: a guest path never reaches the controller', () => {
  it('answers guest filesystem questions in the guest, not with node:fs', async () => {
    const fsPaths: string[] = []
    const { runner } = guestRunner({
      exists: (path) => {
        fsPaths.push(path)
        return path === '/home/u/wt'
      },
      git: (_cwd, args) => {
        const joined = args.join(' ')
        if (joined === 'worktree list --porcelain') {
          return { code: 0, stdout: 'worktree /home/u/src/atlas\n\nworktree /home/u/wt\n' }
        }
        if (joined === 'rev-parse HEAD') return { code: 0, stdout: 'aaa\n' }
        if (joined === 'status --porcelain') return { code: 0, stdout: '' }
        if (joined.startsWith('rev-list')) return { code: 0, stdout: '0\n' }
        return { code: 0 }
      }
    })
    const service = serviceWith(runner, '/local/worktrees')
    const inspected = await service.inspect({
      primaryRoot: '/home/u/src/atlas',
      path: '/home/u/wt',
      branch: 'b',
      target: WSL
    })
    // The guest answered: `/home/u/wt` exists because the *guest* said so.
    expect(inspected.pathExists).toBe(true)
    // And every filesystem question named a guest path.
    expect(fsPaths.length).toBeGreaterThan(0)
    for (const path of fsPaths) expect(path.startsWith('/home/u/')).toBe(true)
  })

  it('reports a missing guest worktree as missing without consulting the local disk', async () => {
    // `/home/u/wt` does not exist locally either, so a local statSync would also
    // say "absent" — the point is which host answered.
    const consulted: string[] = []
    const { runner } = guestRunner({
      exists: (path) => {
        consulted.push(path)
        return false
      }
    })
    const service = serviceWith(runner, '/local/worktrees')
    const inspected = await service.inspect({
      primaryRoot: '/home/u/src/atlas',
      path: '/home/u/wt',
      branch: 'b',
      target: WSL
    })
    expect(inspected.pathExists).toBe(false)
    expect(consulted).toContain('/home/u/wt')
  })

  it('keeps two hosts with the same path independent', async () => {
    // The same guest path on a different distro must not share a queue key or a
    // worktree root: matching by path text would conflate them.
    const other = { kind: 'wsl' as const, distro: 'Ubuntu-24.04', distroId: 'dddddddd-1111-2222-3333-444455556666' }
    const roots: string[] = []
    const runner = new WslCommandRunner({
      platform: 'win32',
      byteLauncher: async (): Promise<WslByteResult> => ({
        code: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false
      })
    })
    const service = new GitWorktreeService({
      worktreeRoot: '/local/worktrees',
      router: createGitExecutorRouter({
        localWorktreeRoot: '/local/worktrees',
        runner,
        guestWorktreeRoot: async (distro) => {
          roots.push(distro)
          return distro === 'Ubuntu-24.04' ? '/home/u/.icode/worktrees/other' : '/home/u/.icode/worktrees/scope'
        }
      })
    })
    expect(await service.worktreeRootFor(WSL)).toBe('/home/u/.icode/worktrees/scope')
    expect(await service.worktreeRootFor(other)).toBe('/home/u/.icode/worktrees/other')
    expect(roots).toEqual(['Ubuntu-26.04', 'Ubuntu-24.04'])
  })
})

/**
 * A stall must never be reported as a fact about the user's repository.
 *
 * A timed-out `rev-parse` used to leave empty stdout, which `isUnborn` read as
 * "no commit yet" — so a healthy repository was shown an instruction to make an
 * initial commit it already had.
 */
describe('guest Git timeouts are unknown, not answers', () => {
  it('does not report an unreadable repository as unborn', async () => {
    const runner = {
      runBytes: async () => ({
        code: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: true
      })
    } as unknown as WslCommandRunner
    const service = new GitWorktreeService({
      worktreeRoot: '/tmp/unused-local-root',
      router: createGitExecutorRouter({
        localWorktreeRoot: '/tmp/unused-local-root',
        runner,
        guestWorktreeRoot: async () => '/home/you/.icode/worktrees/scope'
      })
    })
    const error = await service
      .inspectRepository('/home/you/atlas', {
        kind: 'wsl',
        distro: 'Ubuntu-26.04',
        distroId: null
      })
      .catch((value: unknown) => value)
    // Whatever the wrapping, the outcome must not be "unborn: true".
    if (error && typeof error === 'object' && 'unborn' in error) {
      expect((error as { unborn: boolean }).unborn).toBe(false)
    } else {
      expect(error).toBeInstanceOf(GitUnavailableError)
    }
  })
})

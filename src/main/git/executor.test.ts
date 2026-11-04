import { describe, expect, it } from 'vitest'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { WslCommandRunner, type WslByteResult } from '../wsl/exec'
import {
  createGitExecutorRouter,
  createGuestGitExecutor,
  createLocalGitExecutor,
  GitUnavailableError
} from './executor'

const WSL: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
}

describe('local executor', () => {
  it('runs git in the given directory and keeps the exit code', async () => {
    const executor = createLocalGitExecutor()
    const result = await executor.exec({
      cwd: process.cwd(),
      args: ['rev-parse', '--is-inside-work-tree'],
      timeoutMs: 5_000
    })
    // This workspace is a Git checkout; the point is the contract, not the value.
    expect([0, 128]).toContain(result.exitCode)
  })

  it('reports a failing command with its stderr rather than throwing', async () => {
    const executor = createLocalGitExecutor()
    const result = await executor.exec({
      cwd: '/',
      args: ['rev-parse', '--show-toplevel'],
      timeoutMs: 5_000
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString('utf8')).toContain('not a git repository')
  })

  it('streams stdout as chunks without keeping a second copy', async () => {
    const executor = createLocalGitExecutor()
    const chunks: Buffer[] = []
    const result = await executor.stream!(
      {
        cwd: process.cwd(),
        args: ['rev-parse', '--is-inside-work-tree'],
        timeoutMs: 5_000
      },
      { onStdout: (chunk) => chunks.push(chunk) }
    )
    expect(result.exitCode).toBe(0)
    expect(Buffer.concat(chunks).toString('utf8').trim()).toBe('true')
    expect(result.stdout.length).toBe(0)
  })

  it('rejects a stream whose signal was already aborted', async () => {
    const executor = createLocalGitExecutor()
    const controller = new AbortController()
    controller.abort()
    await expect(
      executor.stream!(
        {
          cwd: process.cwd(),
          args: ['status'],
          timeoutMs: 5_000,
          signal: controller.signal
        },
        { onStdout: () => undefined }
      )
    ).rejects.toHaveProperty('name', 'AbortError')
  })
})

/** Answers the login-shell probe as a distro with Git on PATH does. */
function probeAnswer(): Buffer {
  return Buffer.concat([
    Buffer.from('__ADE_GIT_OUT_START__'),
    Buffer.from('/usr/local/bin:/usr/bin:/bin\u0000/usr/bin/git\u0000/home/u'),
    Buffer.from('__ADE_GIT_OUT_END____ADE_GIT_STATUS__0')
  ])
}

const isProbe = (guest: readonly string[]): boolean =>
  guest[1] === '-lc' && (guest[2] ?? '').includes('command -v git')

describe('guest executor', () => {
  it('runs git through wsl.exe with -C and argv only', async () => {
    const calls: string[][] = []
    const runner = new WslCommandRunner({
      platform: 'win32',
      byteLauncher: async (spec): Promise<WslByteResult> => {
        const guest = [...spec.args].slice([...spec.args].indexOf('--exec') + 1)
        if (isProbe(guest)) {
          return { code: 0, signal: null, stdout: probeAnswer(), stderr: Buffer.alloc(0), timedOut: false }
        }
        calls.push([...spec.args])
        return {
          code: 0,
          signal: null,
          stdout: Buffer.from('abc123\n'),
          stderr: Buffer.alloc(0),
          timedOut: false
        }
      }
    })
    const executor = createGuestGitExecutor(runner, 'Ubuntu-26.04')
    const result = await executor.exec({
      cwd: '/home/u/src/atlas',
      args: ['rev-parse', 'HEAD'],
      timeoutMs: 5_000
    })
    expect(result.stdout.toString('utf8').trim()).toBe('abc123')
    expect(result.exitCode).toBe(0)
    const args = calls[0]!
    // The direct call is env-based and names the absolute Git path the probe found.
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu-26.04', '--exec', '/usr/bin/env'])
    expect(args).toContain('PATH=/usr/local/bin:/usr/bin:/bin')
    expect(args).toContain('HOME=/home/u')
    expect(args).toContain('/usr/bin/git')
    expect(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2)).toEqual([
      '-C',
      '/home/u/src/atlas'
    ])
  })

  it('preserves a Git exit code and stderr exactly', async () => {
    const runner = new WslCommandRunner({
      platform: 'win32',
      byteLauncher: async (spec): Promise<WslByteResult> => {
        const guest = [...spec.args].slice([...spec.args].indexOf('--exec') + 1)
        if (isProbe(guest)) {
          return { code: 0, signal: null, stdout: probeAnswer(), stderr: Buffer.alloc(0), timedOut: false }
        }
        return {
          code: 128,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from('fatal: not a git repository\n'),
          timedOut: false
        }
      }
    })
    const result = await createGuestGitExecutor(runner, 'd').exec({
      cwd: '/x',
      args: ['status'],
      timeoutMs: 1_000
    })
    expect(result.exitCode).toBe(128)
    expect(result.stderr.toString('utf8')).toContain('fatal')
  })

  it('keeps non-UTF-8 bytes intact', async () => {
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x00])
    const runner = new WslCommandRunner({
      platform: 'win32',
      byteLauncher: async (spec): Promise<WslByteResult> => {
        const guest = [...spec.args].slice([...spec.args].indexOf('--exec') + 1)
        if (isProbe(guest)) {
          return { code: 0, signal: null, stdout: probeAnswer(), stderr: Buffer.alloc(0), timedOut: false }
        }
        return { code: 0, signal: null, stdout: raw, stderr: Buffer.alloc(0), timedOut: false }
      }
    })
    const result = await createGuestGitExecutor(runner, 'd').exec({
      cwd: '/x',
      args: ['diff', '--binary'],
      timeoutMs: 1_000
    })
    // The text reader would have decoded this as UTF-16 and lost it.
    expect(result.stdout.equals(raw)).toBe(true)
  })

  it('reports a missing wsl.exe as unavailable, not as a Git failure', async () => {
    const runner = new WslCommandRunner({
      platform: 'win32',
      byteLauncher: async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      }
    })
    await expect(
      createGuestGitExecutor(runner, 'd').exec({ cwd: '/x', args: ['status'], timeoutMs: 1_000 })
    ).rejects.toMatchObject({ reason: 'wsl_missing' })
  })
})

describe('router', () => {
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

  function router(guestRoot: string | null = '/home/u/.ade/worktrees/scope') {
    return createGitExecutorRouter({
      localWorktreeRoot: '/profile/worktrees',
      runner,
      guestWorktreeRoot: async () => guestRoot
    })
  }

  it('keeps the local root for a local target', async () => {
    const resolved = await router().resolve({ kind: 'local' })
    expect(resolved.worktreeRoot).toBe('/profile/worktrees')
  })

  it('uses the guest root for a WSL target', async () => {
    const resolved = await router().resolve(WSL)
    expect(resolved.worktreeRoot).toBe('/home/u/.ade/worktrees/scope')
  })

  it('refuses a WSL target with no registration id', async () => {
    await expect(router().resolve({ kind: 'wsl', distro: 'Ubuntu', distroId: null })).rejects.toThrow(
      GitUnavailableError
    )
  })

  it('refuses when the distro reports no home directory', async () => {
    await expect(router(null).resolve(WSL)).rejects.toThrow(GitUnavailableError)
  })

  it('gives two profiles different guest worktree roots', async () => {
    const a = await createGitExecutorRouter({
      localWorktreeRoot: '/p/worktrees',
      runner,
      guestWorktreeRoot: async () => '/home/u/.ade/worktrees/scopeA'
    }).resolve(WSL)
    const b = await createGitExecutorRouter({
      localWorktreeRoot: '/p/worktrees',
      runner,
      guestWorktreeRoot: async () => '/home/u/.ade/worktrees/scopeB'
    }).resolve(WSL)
    expect(a.worktreeRoot).not.toBe(b.worktreeRoot)
  })

  it('reuses one executor per distro registration', async () => {
    const shared = router()
    const first = await shared.resolve(WSL)
    const second = await shared.resolve(WSL)
    expect(first.executor).toBe(second.executor)
  })
})

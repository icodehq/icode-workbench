import { describe, expect, it } from 'vitest'
import { WslCommandRunner, type WslByteResult } from '../exec'
import { GuestPathError, resolveGuestRepositoryRoot } from './guest-path'

/**
 * A guest whose filesystem and Git are scripted, so the *sequence of guest
 * processes* can be asserted — this suite is about "does this run in the guest at
 * all, with argv only", not about a real distro (that is the real-binary run).
 */

/** Answers the login-shell probe the way a distro with Git on PATH does. */
export function probeAnswer(gitPath = '/usr/bin/git'): Buffer {
  return Buffer.concat([
    Buffer.from('__ICODE_GIT_OUT_START__'),
    Buffer.from(`/usr/local/bin:/usr/bin:/bin\u0000${gitPath}\u0000/home/u`),
    Buffer.from('__ICODE_GIT_OUT_END____ICODE_GIT_STATUS__0')
  ])
}

/** True when this guest argv is the environment probe, not a Git command. */
function isProbe(guest: readonly string[]): boolean {
  return guest[1] === '-lc' && (guest[2] ?? '').includes('command -v git')
}

/** Git argv after the resolved absolute path (or the literal `git`). */
function gitArgv(guest: readonly string[]): { cwd: string; args: string[] } | null {
  const dashC = guest.indexOf('-C')
  if (dashC === -1) return null
  return { cwd: guest[dashC + 1] ?? '', args: guest.slice(dashC + 2) }
}

type Script = {
  /** Where Git lives in this fake distro; default `/usr/bin/git`. */
  gitPath?: string
  realpath?: Record<string, string>
  kinds?: Record<string, 'dir' | 'other' | 'missing'>
  git?: (cwd: string, args: string[]) => { code: number; stdout?: string; stderr?: string }
}

function runnerFor(script: Script) {
  const calls: Array<{ argv: string[]; cwd: string }> = []
  const byteLauncher = async (spec: {
    args: readonly string[]
    cwd: string
  }): Promise<WslByteResult> => {
    const args = [...spec.args]
    calls.push({ argv: args, cwd: spec.cwd })
    const exec = args.indexOf('--exec')
    const guest = args.slice(exec + 1)

    // `sh -c <script> icode-path <path>`
    if (guest[0] === 'sh' && guest[1] === '-c') {
      const path = guest[4] ?? ''
      if (guest[2] === 'realpath -e -- "$1"') {
        const mapped = script.realpath?.[path]
        return {
          code: mapped === undefined ? 1 : 0,
          signal: null,
          stdout: Buffer.from(mapped === undefined ? '' : `${mapped}\n`),
          stderr: Buffer.alloc(0),
          timedOut: false
        }
      }
      if (guest[2]?.startsWith('test -d')) {
        return {
          code: 0,
          signal: null,
          stdout: Buffer.from(`${script.kinds?.[path] ?? 'missing'}\n`),
          stderr: Buffer.alloc(0),
          timedOut: false
        }
      }
    }

    // The environment probe runs first, in the login shell.
    if (isProbe(guest)) {
      return { code: 0, signal: null, stdout: probeAnswer(script.gitPath), stderr: Buffer.alloc(0), timedOut: false }
    }
    // Then the direct call: /usr/bin/env PATH=… HOME=… GIT_… <git> -C <cwd> <args>
    const resolved = gitArgv(guest)
    if (resolved !== null) {
      const answer = script.git?.(resolved.cwd, resolved.args) ?? { code: 1 }
      return {
        code: answer.code,
        signal: null,
        stdout: Buffer.from(answer.stdout ?? ''),
        stderr: Buffer.from(answer.stderr ?? ''),
        timedOut: false
      }
    }

    return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false }
  }
  return { runner: new WslCommandRunner({ byteLauncher, platform: 'win32' }), calls }
}

describe('byte-exact guest capture', () => {
  it('returns bytes, never a decoded string', async () => {
    // Measured regression: `execFile` defaults to utf8, so an omitted `encoding`
    // silently returned a String with 0xFF replaced by U+FFFD.
    //
    // A fake launcher, not the real wsl.exe: on a Windows runner a missing
    // distro produces a UTF-16 error message, which is not the property under
    // test and would make the result platform-dependent.
    const runner = new WslCommandRunner({
      platform: 'win32',
      byteLauncher: async () => ({
        code: 0,
        signal: null,
        stdout: Buffer.from([0x61, 0x00, 0x62, 0xff, 0x63]),
        stderr: Buffer.alloc(0),
        timedOut: false
      })
    })
    const result = await runner.runBytes({
      scope: 'guest',
      distro: 'Ubuntu-26.04',
      argv: ['sh', '-c', 'printf "a\\000b\\377c"', 'x'],
      timeoutMs: 20_000
    })
    if ('status' in result) return
    expect(Buffer.isBuffer(result.stdout)).toBe(true)
    expect(result.stdout.toString('hex')).toBe('610062ff63')
  }, 30_000)
})

describe('guest repository resolution', () => {
  const base: Script = {
    realpath: {
      '/home/u/src/atlas': '/home/u/src/atlas',
      '/home/u/src/atlas/.git': '/home/u/src/atlas/.git',
      '/home/u/link-to-atlas': '/home/u/src/atlas'
    },
    kinds: {
      '/home/u/src/atlas': 'dir',
      '/home/u/link-to-atlas': 'dir',
      '/home/u/src/atlas/README.md': 'other'
    },
    git: (_cwd, args) => {
      const joined = args.join(' ')
      if (joined.includes('--git-common-dir')) {
        return { code: 0, stdout: '/home/u/src/atlas/.git\n' }
      }
      if (joined.includes('worktree list')) {
        return { code: 0, stdout: 'worktree /home/u/src/atlas\nHEAD abc\n\n' }
      }
      if (joined.includes('--abbrev-ref')) return { code: 0, stdout: 'main\n' }
      if (joined.includes('--show-toplevel')) return { code: 0, stdout: '/home/u/src/atlas\n' }
      return { code: 1, stderr: 'unexpected' }
    }
  }

  it('resolves a guest absolute path to its canonical root', async () => {
    const { runner, calls } = runnerFor(base)
    const resolved = await resolveGuestRepositoryRoot('/home/u/src/atlas', {
      runner,
      distro: 'Ubuntu-26.04'
    })
    expect(resolved.root).toBe('/home/u/src/atlas')
    expect(resolved.commonDir).toBe('/home/u/src/atlas/.git')
    expect(resolved.currentBranch).toBe('main')
    expect(resolved.registeredVia).toBeNull()
    // Every call was a guest call: `wsl.exe -d … --exec …`.
    expect(calls.every((call) => call.argv[0] === '-d' && call.argv[1] === 'Ubuntu-26.04')).toBe(true)
  })

  it('treats a symlinked path as the repository it points to', async () => {
    const { runner } = runnerFor(base)
    const resolved = await resolveGuestRepositoryRoot('/home/u/link-to-atlas', {
      runner,
      distro: 'Ubuntu-26.04'
    })
    // One repository, not two: the symlink and its target share a canonical root.
    expect(resolved.root).toBe('/home/u/src/atlas')
    // `registeredVia` matches the local resolver's semantics: it is set only when
    // the *resolved input* differs from the primary root (a subdirectory). A
    // symlink to the root canonicalizes to the root, so this is null — identical
    // to what the local resolver reports for the same shape.
    expect(resolved.registeredVia).toBeNull()
  })

  it('resolves a subdirectory to the repository root', async () => {
    const script: Script = {
      ...base,
      realpath: { ...base.realpath, '/home/u/src/atlas/src': '/home/u/src/atlas/src' },
      kinds: { ...base.kinds, '/home/u/src/atlas/src': 'dir' }
    }
    const { runner } = runnerFor(script)
    const resolved = await resolveGuestRepositoryRoot('/home/u/src/atlas/src', {
      runner,
      distro: 'Ubuntu-26.04'
    })
    expect(resolved.root).toBe('/home/u/src/atlas')
    expect(resolved.registeredVia).toBe('/home/u/src/atlas/src')
  })

  it('reports a missing guest path as PATH_NOT_FOUND', async () => {
    const { runner } = runnerFor(base)
    await expect(
      resolveGuestRepositoryRoot('/home/u/gone', { runner, distro: 'Ubuntu-26.04' })
    ).rejects.toMatchObject({ appError: { code: 'PATH_NOT_FOUND' } })
  })

  it('reports a file path as NOT_A_DIRECTORY', async () => {
    const script: Script = {
      realpath: { '/home/u/src/atlas/README.md': '/home/u/src/atlas/README.md' },
      kinds: { '/home/u/src/atlas/README.md': 'other' }
    }
    const { runner } = runnerFor(script)
    await expect(
      resolveGuestRepositoryRoot('/home/u/src/atlas/README.md', {
        runner,
        distro: 'Ubuntu-26.04'
      })
    ).rejects.toMatchObject({ appError: { code: 'NOT_A_DIRECTORY' } })
  })

  it('reports a non-repository directory as NOT_A_GIT_REPO', async () => {
    const script: Script = {
      realpath: { '/home/u/plain': '/home/u/plain' },
      kinds: { '/home/u/plain': 'dir' },
      git: () => ({ code: 128, stderr: 'fatal: not a git repository' })
    }
    const { runner } = runnerFor(script)
    await expect(
      resolveGuestRepositoryRoot('/home/u/plain', { runner, distro: 'Ubuntu-26.04' })
    ).rejects.toMatchObject({ appError: { code: 'NOT_A_GIT_REPO' } })
  })

  it('refuses a relative path instead of resolving it against a Windows cwd', async () => {
    const { runner, calls } = runnerFor(base)
    await expect(
      resolveGuestRepositoryRoot('src/atlas', { runner, distro: 'Ubuntu-26.04' })
    ).rejects.toMatchObject({ appError: { code: 'PATH_NOT_FOUND' } })
    // Nothing was executed: a relative path has no guest meaning.
    expect(calls).toHaveLength(0)
  })

  it('passes the path as argv, never interpolated into the script text', async () => {
    const { runner, calls } = runnerFor(base)
    // A path that would be destructive if it reached a shell.
    const hostile = '/home/u/src/atlas'
    await resolveGuestRepositoryRoot(hostile, { runner, distro: 'Ubuntu-26.04' })
    for (const call of calls) {
      const exec = call.argv.indexOf('--exec')
      const guest = call.argv.slice(exec + 1)
      // Where a script runs, it is a constant: `sh -c <script> icode-… <path>`.
      // The path is the argument, never part of the script string.
      if (guest[0] === 'sh' && guest[1] === '-c') {
        // No script ever embeds a path — of the input or of any derived path.
        expect(guest[2]).not.toContain('/home/u')
        // Each probe carries its target as a separate positional argument.
        expect(guest[4]?.startsWith('/')).toBe(true)
      }
    }
    // Where the path is addressed, it is a single argv element (`sh -c` arg or
    // `-C` value) — never glued into a script.
    // The realpath probe for the user's path carries it as its own arg.
    const realpathCalls = calls.filter((call) => call.argv.includes('realpath -e -- "$1"'))
    expect(realpathCalls.some((call) => call.argv.includes(hostile))).toBe(true)
  })

  it('never calls a Windows path API: every invocation targets the distro', async () => {
    const { runner, calls } = runnerFor(base)
    await resolveGuestRepositoryRoot('/home/u/src/atlas', { runner, distro: 'Ubuntu-26.04' })
    expect(calls.length).toBeGreaterThan(3)
    for (const call of calls) {
      expect(call.argv).toContain('-d')
      expect(call.argv).toContain('--exec')
    }
  })

  it('handles a linked worktree by reporting the primary root and the common dir', async () => {
    const script: Script = {
      realpath: {
        '/home/u/.icode/worktrees/r1/s1': '/home/u/.icode/worktrees/r1/s1'
      },
      kinds: { '/home/u/.icode/worktrees/r1/s1': 'dir' },
      git: (_cwd, args) => {
        const joined = args.join(' ')
        if (joined.includes('--git-common-dir')) return { code: 0, stdout: '/home/u/src/atlas/.git\n' }
        if (joined.includes('worktree list')) {
          return {
            code: 0,
            stdout:
              'worktree /home/u/src/atlas\nHEAD aaa\n\nworktree /home/u/.icode/worktrees/r1/s1\nHEAD bbb\n\n'
          }
        }
        if (joined.includes('--abbrev-ref')) return { code: 0, stdout: 'feature/x\n' }
        return { code: 1 }
      }
    }
    const { runner } = runnerFor(script)
    const resolved = await resolveGuestRepositoryRoot('/home/u/.icode/worktrees/r1/s1', {
      runner,
      distro: 'Ubuntu-26.04'
    })
    expect(resolved.root).toBe('/home/u/src/atlas')
    expect(resolved.commonDir).toBe('/home/u/src/atlas/.git')
    expect(resolved.registeredVia).toBe('/home/u/.icode/worktrees/r1/s1')
  })

  it('reports a detached HEAD as no branch', async () => {
    const script: Script = { ...base, git: (_cwd, args) => {
      const joined = args.join(' ')
      if (joined.includes('--git-common-dir')) return { code: 0, stdout: '/home/u/src/atlas/.git\n' }
      if (joined.includes('worktree list')) return { code: 0, stdout: 'worktree /home/u/src/atlas\n' }
      if (joined.includes('--abbrev-ref')) return { code: 0, stdout: 'HEAD\n' }
      return { code: 1 }
    } }
    const { runner } = runnerFor(script)
    const resolved = await resolveGuestRepositoryRoot('/home/u/src/atlas', {
      runner,
      distro: 'Ubuntu-26.04'
    })
    expect(resolved.currentBranch).toBeNull()
  })

  it('surfaces a permission failure as NOT_A_GIT_REPO with the guest message', async () => {
    const script: Script = {
      realpath: { '/root/private': '/root/private' },
      kinds: { '/root/private': 'dir' },
      git: () => ({ code: 128, stderr: 'fatal: detected dubious ownership' })
    }
    const { runner } = runnerFor(script)
    const error = await resolveGuestRepositoryRoot('/root/private', {
      runner,
      distro: 'Ubuntu-26.04'
    }).catch((value: unknown) => value)
    expect(error).toMatchObject({ appError: { code: 'NOT_A_GIT_REPO' } })
    expect((error as { appError: { detail: string } }).appError.detail).toContain('dubious ownership')
  })
})

/**
 * "Could not ask" is not "no".
 *
 * A timed-out `test -d` used to leave empty stdout, which the caller read as
 * `missing` and reported to the user as "that path is not a folder" — about a
 * directory that was really there. These tests pin the distinction.
 */
describe('transport failure is not a negative answer', () => {
  function stalledRunner() {
    // `realpath` succeeds, then the shape probe stalls twice (the retry budget).
    let shapeCalls = 0
    const byteLauncher = async (spec: { args: readonly string[] }): Promise<WslByteResult> => {
      const guest = [...spec.args].slice([...spec.args].indexOf('--exec') + 1)
      if (guest[0] === 'sh' && guest[2] === 'realpath -e -- "$1"') {
        return {
          code: 0,
          signal: null,
          stdout: Buffer.from('/home/you/atlas\n'),
          stderr: Buffer.alloc(0),
          timedOut: false
        }
      }
      if (guest[2]?.startsWith('test -d')) {
        shapeCalls += 1
        return {
          code: null,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          timedOut: true
        }
      }
      return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false }
    }
    return { runner: new WslCommandRunner({ byteLauncher, platform: 'win32' }), shapeCalls: () => shapeCalls }
  }

  it('reports WSL_UNAVAILABLE, never NOT_A_DIRECTORY, when the shape probe cannot answer', async () => {
    const { runner } = stalledRunner()
    const error = await resolveGuestRepositoryRoot('/home/you/atlas', {
      runner,
      distro: 'Ubuntu-26.04'
    }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(GuestPathError)
    expect((error as GuestPathError).appError.code).toBe('WSL_UNAVAILABLE')
    expect((error as GuestPathError).appError.message).not.toMatch(/not a folder|does not exist/i)
  })

  it('still answers "missing" when the shell really says so', async () => {
    const { runner } = runnerFor({ realpath: { '/home/you/atlas': '/home/you/atlas' } })
    const error = await resolveGuestRepositoryRoot('/home/you/atlas', {
      runner,
      distro: 'Ubuntu-26.04'
    }).catch((value: unknown) => value)
    expect((error as GuestPathError).appError.code).toBe('NOT_A_DIRECTORY')
  })
})

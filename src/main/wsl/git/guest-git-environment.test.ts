import { describe, expect, it } from 'vitest'
import { WslCommandRunner, type WslByteResult } from '../exec'
import {
  fencedCommand,
  GUEST_GIT_PROBE_SCRIPT,
  LOGIN_FENCE_END,
  LOGIN_FENCE_START,
  LOGIN_FENCE_STATUS,
  parseFencedOutput,
  parseGuestGitProbe
} from './guest-git-environment'
import { createGuestGitEnvironmentCache } from './guest-git-environment'
import { resetGuestGitEnvironments, runGuestGit } from './guest-git'

function probeBody(path: string, git: string, home: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${LOGIN_FENCE_START}`),
    Buffer.from(`${path}\u0000${git}\u0000${home}`),
    Buffer.from(`${LOGIN_FENCE_END}${LOGIN_FENCE_STATUS}0`)
  ])
}

function runnerFor(handler: (guest: string[]) => WslByteResult) {
  const calls: string[][] = []
  const runner = new WslCommandRunner({
    platform: 'win32',
    byteLauncher: async (spec) => {
      const args = [...spec.args]
      const guest = args.slice(args.indexOf('--exec') + 1)
      calls.push(guest)
      return handler(guest)
    }
  })
  return { runner, calls }
}

function ok(stdout: Buffer, code = 0): WslByteResult {
  return { code, signal: null, stdout, stderr: Buffer.alloc(0), timedOut: false }
}

describe('probe parsing', () => {
  it('reads PATH, git path and HOME between the fences', () => {
    expect(parseGuestGitProbe(probeBody('/usr/bin:/bin', '/usr/bin/git', '/home/u'))).toEqual({
      gitPath: '/usr/bin/git',
      path: '/usr/bin:/bin',
      home: '/home/u'
    })
  })

  it('discards a login banner printed before the fence', () => {
    const noisy = Buffer.concat([
      Buffer.from('Welcome to Ubuntu!\n3 updates available.\n'),
      probeBody('/usr/bin', '/usr/bin/git', '/home/u')
    ])
    expect(parseGuestGitProbe(noisy)?.gitPath).toBe('/usr/bin/git')
  })

  it('rejects a relative git path', () => {
    expect(parseGuestGitProbe(probeBody('/usr/bin', 'git', '/home/u'))).toBeNull()
  })

  it('rejects a non-absolute HOME', () => {
    expect(parseGuestGitProbe(probeBody('/usr/bin', '/usr/bin/git', 'home'))).toBeNull()
  })

  it('rejects unfenced output', () => {
    expect(parseGuestGitProbe(Buffer.from('/usr/bin\u0000/usr/bin/git\u0000/home/u'))).toBeNull()
  })

  it('probes with the login shell and fingerprints the unsafe environment', () => {
    // Mirrors Orca's probe: refuse when a direct spawn would diverge.
    expect(GUEST_GIT_PROBE_SCRIPT).toContain('command -v git')
    expect(GUEST_GIT_PROBE_SCRIPT).toContain('exit 127')
    expect(GUEST_GIT_PROBE_SCRIPT).toContain('exit 78')
    expect(GUEST_GIT_PROBE_SCRIPT).toContain('XDG_CONFIG_HOME')
    expect(GUEST_GIT_PROBE_SCRIPT).toContain('LD_LIBRARY_PATH')
  })
})

describe('fencing', () => {
  it('drops banner output and keeps the payload bytes', () => {
    const payload = Buffer.from([0x41, 0x00, 0xff])
    const stdout = Buffer.concat([
      Buffer.from('banner line\n'),
      Buffer.from(LOGIN_FENCE_START),
      payload,
      Buffer.from(LOGIN_FENCE_END),
      Buffer.from(`${LOGIN_FENCE_STATUS}0`)
    ])
    const parsed = parseFencedOutput(stdout)
    expect(parsed?.payload.equals(payload)).toBe(true)
    expect(parsed?.stderrStatus).toBe(0)
  })

  it('returns the real exit status, not the shell default', () => {
    const stdout = Buffer.concat([
      Buffer.from(LOGIN_FENCE_START),
      Buffer.from(''),
      Buffer.from(LOGIN_FENCE_END),
      Buffer.from(`${LOGIN_FENCE_STATUS}128`)
    ])
    expect(parseFencedOutput(stdout)?.stderrStatus).toBe(128)
  })

  it('returns null when the shell never reached the command', () => {
    expect(parseFencedOutput(Buffer.from('bash: profile exploded\n'))).toBeNull()
  })

  it('wraps a command in fences and propagates its status', () => {
    const wrapped = fencedCommand('git status')
    expect(wrapped).toContain(LOGIN_FENCE_START)
    expect(wrapped).toContain(LOGIN_FENCE_END)
    expect(wrapped).toContain('exit "$__icode_status"')
  })
})

describe('environment cache', () => {
  it('probes once per distro and reuses the route', async () => {
    let probes = 0
    const { runner, calls } = runnerFor(() => {
      probes += 1
      return ok(probeBody('/usr/bin', '/usr/bin/git', '/home/u'))
    })
    const cache = createGuestGitEnvironmentCache(runner)
    await cache.probe('Ubuntu-26.04')
    await cache.probe('Ubuntu-26.04')
    expect(probes).toBe(1)
    // One probe call, and it was the login shell.
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('sh')
    expect(calls[0]![1]).toBe('-lc')
  })

  it('settles "no git" so a distro without Git is not probed repeatedly', async () => {
    let probes = 0
    const { runner } = runnerFor(() => {
      probes += 1
      return ok(Buffer.alloc(0), 127)
    })
    const cache = createGuestGitEnvironmentCache(runner)
    expect(await cache.probe('d')).toEqual({ kind: 'no_direct_route', reason: 'no_git' })
    expect(await cache.probe('d')).toEqual({ kind: 'no_direct_route', reason: 'no_git' })
    expect(probes).toBe(1)
    expect(cache.isSettled('d')).toBe(true)
  })

  it('treats an unsafe login environment as no direct route', async () => {
    const { runner } = runnerFor(() => ok(Buffer.alloc(0), 78))
    const cache = createGuestGitEnvironmentCache(runner)
    expect(await cache.probe('d')).toEqual({ kind: 'no_direct_route', reason: 'unsafe_env' })
  })

  it('re-probes after invalidation', async () => {
    let probes = 0
    const { runner } = runnerFor(() => {
      probes += 1
      return ok(probeBody('/usr/bin', '/usr/bin/git', '/home/u'))
    })
    const cache = createGuestGitEnvironmentCache(runner)
    await cache.probe('d')
    cache.invalidate('d')
    await cache.probe('d')
    expect(probes).toBe(2)
  })

  it('does not settle on unparseable output', async () => {
    const { runner } = runnerFor(() => ok(Buffer.from('garbage')))
    const cache = createGuestGitEnvironmentCache(runner)
    expect(await cache.probe('d')).toEqual({ kind: 'no_direct_route', reason: 'unparseable' })
    expect(cache.isSettled('d')).toBe(false)
  })

  it('shares one in-flight probe rather than racing', async () => {
    let probes = 0
    const { runner } = runnerFor(() => {
      probes += 1
      return ok(probeBody('/usr/bin', '/usr/bin/git', '/home/u'))
    })
    const cache = createGuestGitEnvironmentCache(runner)
    await Promise.all([cache.probe('d'), cache.probe('d'), cache.probe('d')])
    expect(probes).toBe(1)
  })
})

describe('runGuestGit environment strategy', () => {
  it('runs direct-git with the probed PATH, HOME and absolute git path', async () => {
    const { runner, calls } = runnerFor((guest) => {
      if (guest[1] === '-lc') return ok(probeBody('/opt/git/bin:/usr/bin', '/opt/git/bin/git', '/home/u'))
      return ok(Buffer.from('abc\n'))
    })
    const result = await runGuestGit(
      runner,
      { distro: 'Ubuntu-26.04', cwd: '/home/u/r', args: ['rev-parse', 'HEAD'] },
      { environments: createGuestGitEnvironmentCache(runner) }
    )
    expect(result.stdout.toString('utf8')).toBe('abc\n')
    const direct = calls[1]!
    // env, PATH, HOME, GIT_*, absolute git, -C, cwd
    expect(direct[0]).toBe('/usr/bin/env')
    expect(direct).toContain('PATH=/opt/git/bin:/usr/bin')
    expect(direct).toContain('HOME=/home/u')
    expect(direct).toContain('/opt/git/bin/git')
    expect(direct).toContain('-C')
    expect(direct).toContain('/home/u/r')
    // No shell in the direct path.
    expect(direct).not.toContain('-lc')
  })

  it('uses the login shell when the probe finds no direct route', async () => {
    const { runner, calls } = runnerFor((guest) => {
      if (guest[1] === '-lc' && guest[2]?.includes('command -v git')) return ok(Buffer.alloc(0), 127)
      return ok(
        Buffer.concat([
          Buffer.from(LOGIN_FENCE_START),
          Buffer.from('fenced-output'),
          Buffer.from(LOGIN_FENCE_END),
          Buffer.from(`${LOGIN_FENCE_STATUS}0`)
        ])
      )
    })
    const result = await runGuestGit(
      runner,
      { distro: 'd', cwd: '/home/u/r', args: ['status', '--porcelain'] },
      { environments: createGuestGitEnvironmentCache(runner) }
    )
    expect(result.stdout.toString('utf8')).toBe('fenced-output')
    expect(result.exitCode).toBe(0)
    const fallback = calls[1]!
    expect(fallback[0]).toBe('sh')
    expect(fallback[1]).toBe('-lc')
    // The path is quoted, never interpolated.
    expect(fallback[2]).toContain("'/home/u/r'")
  })

  it('retries in the login shell when direct-git reports "not found"', async () => {
    let directCalls = 0
    const { runner, calls } = runnerFor((guest) => {
      if (guest[1] === '-lc' && guest[2]?.includes('command -v git')) {
        return ok(probeBody('/usr/bin', '/usr/bin/git', '/home/u'))
      }
      if (guest[0] === '/usr/bin/env') {
        directCalls += 1
        return {
          code: 127,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from('env: /usr/bin/git: No such file or directory'),
          timedOut: false
        }
      }
      return ok(
        Buffer.concat([
          Buffer.from(LOGIN_FENCE_START),
          Buffer.from('from-shell'),
          Buffer.from(LOGIN_FENCE_END),
          Buffer.from(`${LOGIN_FENCE_STATUS}0`)
        ])
      )
    })
    const result = await runGuestGit(
      runner,
      { distro: 'd', cwd: '/r', args: ['status'] },
      { environments: createGuestGitEnvironmentCache(runner) }
    )
    expect(directCalls).toBe(1)
    expect(result.stdout.toString('utf8')).toBe('from-shell')
    expect(calls.some((guest) => guest[1] === '-lc' && !guest[2]?.includes('command -v git'))).toBe(
      true
    )
  })

  it('preserves a Git failure exit code and stderr through direct-git', async () => {
    const { runner } = runnerFor((guest) => {
      if (guest[1] === '-lc') return ok(probeBody('/usr/bin', '/usr/bin/git', '/home/u'))
      return {
        code: 128,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('fatal: not a git repository'),
        timedOut: false
      }
    })
    const result = await runGuestGit(
      runner,
      { distro: 'd', cwd: '/r', args: ['status'] },
      { environments: createGuestGitEnvironmentCache(runner) }
    )
    // 128 is a Git verdict, not a missing binary: no shell fallback.
    expect(result.exitCode).toBe(128)
    expect(result.stderr.toString('utf8')).toContain('fatal')
  })

  it('keeps binary output byte-exact through the direct path', async () => {
    const payload = Buffer.from([0x00, 0xff, 0x41, 0x00])
    const { runner } = runnerFor((guest) => {
      if (guest[1] === '-lc') return ok(probeBody('/usr/bin', '/usr/bin/git', '/home/u'))
      return ok(payload)
    })
    const result = await runGuestGit(
      runner,
      { distro: 'd', cwd: '/r', args: ['cat-file', 'blob', 'o'] },
      { environments: createGuestGitEnvironmentCache(runner) }
    )
    expect(result.stdout.equals(payload)).toBe(true)
  })

  it('keeps binary output byte-exact through the fenced fallback', async () => {
    const payload = Buffer.from([0x00, 0xff, 0x41])
    const { runner } = runnerFor((guest) => {
      if (guest[1] === '-lc' && guest[2]?.includes('command -v git')) return ok(Buffer.alloc(0), 127)
      return ok(
        Buffer.concat([
          Buffer.from('banner\n'),
          Buffer.from(LOGIN_FENCE_START),
          payload,
          Buffer.from(LOGIN_FENCE_END),
          Buffer.from(`${LOGIN_FENCE_STATUS}0`)
        ])
      )
    })
    const result = await runGuestGit(
      runner,
      { distro: 'd', cwd: '/r', args: ['cat-file', 'blob', 'o'] },
      { environments: createGuestGitEnvironmentCache(runner) }
    )
    expect(result.stdout.equals(payload)).toBe(true)
  })

  it('reports a timeout as a timeout, not as a Git verdict', async () => {
    const { runner } = runnerFor((guest) => {
      if (guest[1] === '-lc') return ok(probeBody('/usr/bin', '/usr/bin/git', '/home/u'))
      return { code: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: true }
    })
    const result = await runGuestGit(
      runner,
      { distro: 'd', cwd: '/r', args: ['status'], timeoutMs: 50 },
      { environments: createGuestGitEnvironmentCache(runner) }
    )
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('raises unavailable when wsl.exe cannot start', async () => {
    const runner = new WslCommandRunner({
      platform: 'win32',
      byteLauncher: async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      }
    })
    await expect(
      runGuestGit(
        runner,
        { distro: 'd', cwd: '/r', args: ['status'] },
        { environments: createGuestGitEnvironmentCache(runner) }
      )
    ).rejects.toMatchObject({ reason: 'wsl_missing' })
  })

  it('does not leak a cached route between test cases', () => {
    // The cache is per-process by design; this guards the reset seam itself.
    resetGuestGitEnvironments()
  })
})

describe('shell quoting', () => {
  it('single-quotes every word so no path becomes syntax', async () => {
    const { quoteForShell } = await import('./guest-git')
    expect(quoteForShell('/home/u/a b')).toBe("'/home/u/a b'")
    expect(quoteForShell("a'b")).toBe(`'a'\\''b'`)
    expect(quoteForShell('$(rm -rf /)')).toBe("'$(rm -rf /)'")
    expect(quoteForShell('a; rm -rf /')).toBe("'a; rm -rf /'")
  })
})

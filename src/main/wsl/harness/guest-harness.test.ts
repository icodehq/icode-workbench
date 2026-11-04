import { describe, expect, it } from 'vitest'
import { WslCommandRunner, type WslByteResult } from '../exec'
import {
  AGENT_PATH_PREFIX,
  GUEST_PATH_LOOKUP_BATCH_SCRIPT,
  guestLaunchSpec,
  parseGuestExecutableMap,
  resolveGuestExecutable,
  resolveGuestLoginPath,
  resolveGuestShell,
  shellModeFor
} from './guest-harness'

function ok(stdout: string, code = 0): WslByteResult {
  return { code, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false }
}

/** A guest whose login shell exposes one harness and whose `/bin/sh` exposes none. */
function guest(handlers: {
  shell?: string
  find?: (name: string, viaLogin: boolean) => string | null
  loginPath?: string
}) {
  const calls: { shell: string; mode: string; name: string | null }[] = []
  const runner = new WslCommandRunner({
    platform: 'win32',
    byteLauncher: async (spec): Promise<WslByteResult> => {
      const args = [...spec.args]
      const argv = args.slice(args.indexOf('--exec') + 1)
      const [shell, mode, script, , ...names] = argv
      const viaLogin = mode !== '-c'
      calls.push({ shell: shell ?? '', mode: mode ?? '', name: names[0] ?? null })

      if (script === 'printf %s "${SHELL:-}"') return ok(`${handlers.shell ?? '/bin/bash'}\n`)
      if (script === 'printf %s "$PATH"') {
        return ok(`${handlers.loginPath ?? '/home/u/.nvm/bin:/usr/bin'}${'\n'}`)
      }
      if (script === GUEST_PATH_LOOKUP_BATCH_SCRIPT) {
        // The batch script answers one line per name it can resolve.
        const lines = names.flatMap((name) => {
          const found = handlers.find?.(name, viaLogin) ?? null
          return found === null ? [] : [`${AGENT_PATH_PREFIX}${name}=${found}`]
        })
        return ok(lines.length === 0 ? '' : `${lines.join('\n')}\n`)
      }
      return ok('')
    }
  })
  return { runner, calls }
}

describe('shell selection', () => {
  it('uses an interactive login shell for bash/zsh/fish', () => {
    expect(shellModeFor('/bin/bash')).toBe('-ilc')
    expect(shellModeFor('/usr/bin/zsh')).toBe('-ilc')
    expect(shellModeFor('/usr/bin/fish')).toBe('-ilc')
  })

  it('uses a plain login shell for sh/dash, which may not accept -i with -c', () => {
    expect(shellModeFor('/bin/sh')).toBe('-lc')
    expect(shellModeFor('/bin/dash')).toBe('-lc')
  })

  it('reads $SHELL from the guest', async () => {
    const { runner, calls } = guest({ shell: '/usr/bin/zsh' })
    await expect(resolveGuestShell({ runner, distro: 'd' })).resolves.toEqual({
      shell: '/usr/bin/zsh',
      mode: '-ilc'
    })
    // The shell probe itself must not be a login shell: it must not run profiles.
    expect(calls[0]).toMatchObject({ shell: '/bin/sh', mode: '-c' })
  })

  it('falls back to /bin/sh for an unsupported or non-absolute shell', async () => {
    for (const shell of ['/usr/bin/tcsh', 'bash', '']) {
      const { runner } = guest({ shell })
      await expect(resolveGuestShell({ runner, distro: 'd' })).resolves.toEqual({
        shell: '/bin/sh',
        mode: '-lc'
      })
    }
  })
})

describe('guest path lookup', () => {
  it('accepts only an absolute, prefixed path', () => {
    expect(
      parseGuestExecutableMap(`${AGENT_PATH_PREFIX}claude=/home/u/.nvm/bin/claude\n`).get('claude')
    ).toBe('/home/u/.nvm/bin/claude')
    expect(parseGuestExecutableMap('claude\n').size).toBe(0)
    expect(parseGuestExecutableMap(`${AGENT_PATH_PREFIX}claude=claude\n`).size).toBe(0)
    expect(parseGuestExecutableMap('Welcome to Ubuntu\n').size).toBe(0)
  })

  it('ignores a banner printed before the resolved path', () => {
    const stdout = `3 updates available\n${AGENT_PATH_PREFIX}codex=/usr/bin/codex\n`
    expect(parseGuestExecutableMap(stdout).get('codex')).toBe('/usr/bin/codex')
  })

  it('skips Windows mount entries — the point of the whole walk', () => {
    // Measured on this machine: `command -v claude` resolves to
    // /mnt/c/nvm4w/nodejs/claude, a Windows shim, not a guest install.
    expect(GUEST_PATH_LOOKUP_BATCH_SCRIPT).toContain(
      'case "$__icode_dir" in /mnt/*|/mnt) continue ;; esac'
    )
    expect(GUEST_PATH_LOOKUP_BATCH_SCRIPT).toContain('[ -f "$__icode_dir/$__icode_name" ]')
    expect(GUEST_PATH_LOOKUP_BATCH_SCRIPT).toContain('[ -x "$__icode_dir/$__icode_name" ]')
  })

  it('takes the command names as argv, never interpolated into the script', () => {
    expect(GUEST_PATH_LOOKUP_BATCH_SCRIPT).toContain('"$@"')
    expect(GUEST_PATH_LOOKUP_BATCH_SCRIPT).not.toContain('$(dirname')
  })

  it('finds a harness through the login shell', async () => {
    const { runner, calls } = guest({
      find: (name, viaLogin) => (viaLogin && name === 'claude' ? '/home/u/.nvm/bin/claude' : null)
    })
    await expect(
      resolveGuestExecutable({ runner, distro: 'd', name: 'claude' })
    ).resolves.toBe('/home/u/.nvm/bin/claude')
    // One shell read plus one lookup at most: no repeated probing.
    expect(calls.filter((call) => call.name === 'claude').length).toBeLessThanOrEqual(2)
  })

  it('falls back to /bin/sh when the login shell finds nothing', async () => {
    const { runner, calls } = guest({
      find: (name, viaLogin) => (!viaLogin && name === 'codex' ? '/usr/bin/codex' : null)
    })
    await expect(resolveGuestExecutable({ runner, distro: 'd', name: 'codex' })).resolves.toBe(
      '/usr/bin/codex'
    )
    expect(calls.some((call) => call.shell === '/bin/sh')).toBe(true)
  })

  it('reports a missing harness as null without inventing a path', async () => {
    const { runner } = guest({ find: () => null })
    await expect(resolveGuestExecutable({ runner, distro: 'd', name: 'opencode' })).resolves.toBeNull()
  })

  it('reads the login PATH, which is where a version manager puts its bins', async () => {
    const { runner } = guest({ loginPath: '/home/u/.nvm/versions/node/v24/bin:/usr/bin' })
    const shell = await resolveGuestShell({ runner, distro: 'd' })
    await expect(resolveGuestLoginPath({ runner, distro: 'd' }, shell)).resolves.toBe(
      '/home/u/.nvm/versions/node/v24/bin:/usr/bin'
    )
  })
})

describe('launch spec', () => {
  it('execs the resolved absolute path in the login shell', () => {
    // `exec` matters: the PTY's process becomes the harness, not a wrapper shell.
    expect(guestLaunchSpec({ shell: '/bin/bash', mode: '-ilc' }, '/home/u/.nvm/bin/claude')).toEqual({
      command: '/bin/bash',
      args: ['-ilc', "exec '/home/u/.nvm/bin/claude'"],
      // Declared so extra arguments go inside the script, not into the shell's
      // `$0`/`$1` (Work 71). See `harness/launch-command.test.ts`.
      shellWrapper: { scriptIndex: 1 }
    })
  })

  it('quotes the path so it cannot become shell syntax', () => {
    const spec = guestLaunchSpec({ shell: '/bin/sh', mode: '-lc' }, "/home/u/a b'; rm -rf /")
    expect(spec.args[1]).toBe("exec '/home/u/a b'\\''; rm -rf /'")
  })

  // A WSL shell is Path A (`wsl/terminal/path-a.ts`), so this module deliberately
  // has no shell launch spec of its own.
})

describe('batched lookup', () => {
  it('parses name=/path pairs and ignores malformed ones', async () => {
    const { parseGuestExecutableMap } = await import('./guest-harness')
    const map = parseGuestExecutableMap(
      [
        'Welcome to Ubuntu',
        `${AGENT_PATH_PREFIX}claude=/home/u/.nvm/bin/claude`,
        `${AGENT_PATH_PREFIX}codex=codex`,
        `${AGENT_PATH_PREFIX}=/usr/bin/x`,
        `${AGENT_PATH_PREFIX}opencode=/usr/bin/opencode`
      ].join('\n')
    )
    expect([...map.entries()]).toEqual([
      ['claude', '/home/u/.nvm/bin/claude'],
      ['opencode', '/usr/bin/opencode']
    ])
  })

  it('resolves every name in a single login-shell call', async () => {
    const calls: string[][] = []
    const runner = new WslCommandRunner({
      platform: 'win32',
      byteLauncher: async (spec): Promise<WslByteResult> => {
        const args = [...spec.args]
        const argv = args.slice(args.indexOf('--exec') + 1)
        calls.push(argv)
        if (argv[2] === 'printf %s "${SHELL:-}"') return ok('/bin/bash\n')
        if (argv[2] === 'printf %s "$PATH"') return ok('/home/u/.nvm/bin:/usr/bin\n')
        return ok(
          `${AGENT_PATH_PREFIX}claude=/home/u/.nvm/bin/claude\n${AGENT_PATH_PREFIX}codex=/usr/bin/codex\n`
        )
      }
    })
    const { resolveGuestExecutables } = await import('./guest-harness')
    const map = await resolveGuestExecutables({
      runner,
      distro: 'd',
      names: ['claude', 'codex', 'opencode']
    })
    expect(map.get('claude')).toBe('/home/u/.nvm/bin/claude')
    expect(map.get('codex')).toBe('/usr/bin/codex')
    expect(map.has('opencode')).toBe(false)
    // One lookup call per shell phase, carrying every name as argv. `opencode`
    // was not found by the login shell, so `/bin/sh` gets a second look at it.
    const { GUEST_PATH_LOOKUP_BATCH_SCRIPT } = await import('./guest-harness')
    const lookups = calls.filter((argv) => argv[2] === GUEST_PATH_LOOKUP_BATCH_SCRIPT)
    expect(lookups.length).toBeLessThanOrEqual(2)
    expect(lookups[0]).toEqual(expect.arrayContaining(['claude', 'codex', 'opencode']))
    // The retry asks only for what is still missing.
    if (lookups.length === 2) expect(lookups[1]).toEqual(expect.arrayContaining(['opencode']))
  })
})

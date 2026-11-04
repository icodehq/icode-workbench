import { describe, expect, it } from 'vitest'
import { makeAppError } from '../../../shared/domain/errors'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import { WslCommandRunner, type WslByteResult } from '../exec'
import { RepositoryTargetError } from '../repository-target'
import {
  buildWslTerminalArgs,
  hostTargetFor,
  isPathATerminal,
  resolvePathATerminal,
  WSL_INTERACTIVE_LOGIN_SHELL_SCRIPT
} from './path-a'

const WSL: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
}
const GUEST_CWD = '/home/u/src/atlas'
const PTY_CWD = '/home/u/.config/iCode'

function harness(options: {
  guestIsDirectory?: (distro: string, path: string) => Promise<boolean | null>
  validate?: (target: ExecutionTarget) => Promise<ExecutionTarget>
} = {}) {
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
  return resolvePathATerminal(WSL, GUEST_CWD, {
    runner,
    validateTarget: options.validate ?? (async (target) => target),
    ptyCwd: PTY_CWD,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    ...(options.guestIsDirectory ? { guestIsDirectory: options.guestIsDirectory } : {})
  })
}

describe('Path A argv', () => {
  it('enters the distro with --exec, never --', () => {
    // `--` makes wsl.exe expand `$name` in arguments before the guest runs.
    const args = buildWslTerminalArgs('Ubuntu-26.04', GUEST_CWD)
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu-26.04', '--exec', 'sh'])
    expect(args).not.toContain('--')
    expect(args[4]).toBe('-c')
  })

  it('passes the guest cwd as a positional argument, not inside the script', () => {
    const hostile = "/home/u/a b'; rm -rf /"
    const args = buildWslTerminalArgs('d', hostile)
    const script = args[5]!
    expect(script).not.toContain(hostile)
    expect(args.at(-1)).toBe(hostile)
    // `$1` is the only variable the script trusts for a path.
    expect(script).toContain('__icode_cwd="$1"')
  })

  it('names the distro explicitly so the default one can never be used', () => {
    expect(buildWslTerminalArgs('Ubuntu-26.04', '/x')).toContain('Ubuntu-26.04')
  })

  it('fails loudly when the guest directory cannot be entered', () => {
    // Without this the shell would silently start somewhere else.
    expect(WSL_INTERACTIVE_LOGIN_SHELL_SCRIPT).toContain('exit 1')
    expect(WSL_INTERACTIVE_LOGIN_SHELL_SCRIPT).toContain('cannot enter')
  })

  it('prepends ~/.local/bin, as Orca does for a WSL pane', () => {
    expect(WSL_INTERACTIVE_LOGIN_SHELL_SCRIPT).toContain(
      'export PATH="$HOME/.local/bin:$PATH"'
    )
  })

  it('resolves the login shell inside the guest and execs it', () => {
    const script = WSL_INTERACTIVE_LOGIN_SHELL_SCRIPT
    // getent → $SHELL → /bin/sh, then exec so the PTY's child is the shell.
    expect(script).toContain('getent passwd')
    expect(script).toContain('SHELL:-/bin/bash')
    expect(script).toContain('__icode_shell=/bin/sh')
    expect(script).toContain('exec "$__icode_shell" -il')
    // sh/dash must not get `-il`, which some builds reject.
    expect(script).toContain('sh|dash) exec "$__icode_shell" -l ;;')
  })
})

describe('Path A resolution', () => {
  it('is not a WSL target for a local repository', async () => {
    const runner = new WslCommandRunner({ platform: 'win32' })
    await expect(
      resolvePathATerminal({ kind: 'local' }, GUEST_CWD, {
        runner,
        validateTarget: async (target) => target,
        ptyCwd: PTY_CWD
      })
    ).resolves.toEqual({ status: 'not_wsl' })
  })

  it('returns a ready launch with a machine-local PTY cwd', async () => {
    const outcome = await harness({ guestIsDirectory: async () => true })
    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') return
    // The PTY must not start in a Linux directory: ConPTY cannot chdir there.
    expect(outcome.launch.ptyCwd).toBe(PTY_CWD)
    expect(outcome.launch.ptyCwd.startsWith('/home/u/src')).toBe(false)
    expect(outcome.launch.guestCwd).toBe(GUEST_CWD)
    expect(outcome.launch.distro).toBe('Ubuntu-26.04')
    expect(outcome.launch.command).toContain('wsl.exe')
    expect(outcome.launch.args.at(-1)).toBe(GUEST_CWD)
  })

  it('refuses a guest directory that does not exist', async () => {
    const outcome = await harness({ guestIsDirectory: async () => false })
    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { code: 'NOT_A_DIRECTORY' }
    })
  })

  it('refuses when the distro cannot answer, instead of launching anyway', async () => {
    const outcome = await harness({ guestIsDirectory: async () => null })
    expect(outcome).toMatchObject({ status: 'failed', failure: { code: 'WSL_UNAVAILABLE' } })
  })

  it('surfaces a replaced registration before anything is launched', async () => {
    const outcome = await harness({
      guestIsDirectory: async () => true,
      validate: async () => {
        throw new RepositoryTargetError(
          makeAppError('WSL_DISTRO_NOT_FOUND', 'The distro is a different installation.')
        )
      }
    })
    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { code: 'WSL_DISTRO_NOT_FOUND' }
    })
    if (outcome.status === 'failed') {
      expect(outcome.failure.error.message).toContain('different installation')
    }
  })

  it('refuses a relative guest cwd without touching the distro', async () => {
    let probed = false
    const runner = new WslCommandRunner({ platform: 'win32' })
    const outcome = await resolvePathATerminal(WSL, 'src/atlas', {
      runner,
      validateTarget: async (target) => target,
      ptyCwd: PTY_CWD,
      guestIsDirectory: async () => {
        probed = true
        return true
      }
    })
    expect(outcome).toMatchObject({ status: 'failed', failure: { code: 'PATH_NOT_FOUND' } })
    expect(probed).toBe(false)
  })
})

describe('which host owns the PTY', () => {
  it('gives a WSL shell to the desktop host', () => {
    expect(hostTargetFor('shell', WSL)).toEqual({ kind: 'local' })
    expect(isPathATerminal('shell', WSL)).toBe(true)
  })

  it('keeps a WSL coding Agent on the managed host', () => {
    // Path B: the distro's host owns this PTY, as W7 wired it.
    expect(hostTargetFor('claude', WSL)).toEqual(WSL)
    expect(isPathATerminal('claude', WSL)).toBe(false)
  })

  it('leaves a local repository alone', () => {
    const local = { kind: 'local' } as const
    expect(hostTargetFor('shell', local)).toEqual(local)
    expect(hostTargetFor('claude', local)).toEqual(local)
    expect(isPathATerminal('shell', local)).toBe(false)
  })
})

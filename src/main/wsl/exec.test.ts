import { describe, expect, it } from 'vitest'
import {
  WSL_DEFAULT_TIMEOUT_MS,
  WSL_TIMEOUT_SCALE_ENV,
  WslCommandRunner,
  decodeWslOutput,
  resolveWslExecutablePath,
  resolveWslTimeoutScale,
  type WslProcessLauncher,
  type WslProcessResult
} from './exec'

function result(overrides: Partial<WslProcessResult> = {}): WslProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

/** Records the spec each call received and answers from a queue. */
function launcherReturning(...results: Array<WslProcessResult | Error>) {
  const calls: Array<Parameters<WslProcessLauncher>[0]> = []
  const launcher: WslProcessLauncher = async (spec) => {
    calls.push(spec)
    const next = results.shift()
    if (next instanceof Error) throw next
    return next ?? result()
  }
  return { launcher, calls }
}

describe('wsl executable resolution', () => {
  it('prefers System32 on Windows and falls back to the bare name', () => {
    // The fixture path does not exist here, so the fallback branch is what runs;
    // both outcomes are absolute-or-bare and never a shell string.
    const resolved = resolveWslExecutablePath({ SystemRoot: 'C:\\Windows' }, 'win32')
    expect(resolved === 'wsl.exe' || resolved.endsWith('wsl.exe')).toBe(true)
  })

  it('does not invent a Windows path on other platforms', () => {
    expect(resolveWslExecutablePath({}, 'linux')).toBe('wsl.exe')
  })
})

describe('argv construction', () => {
  it('passes the distro and the guest argv as separate elements', () => {
    const runner = new WslCommandRunner({ platform: 'win32' })
    expect(
      runner.buildArgs({ scope: 'guest', distro: 'Ubuntu-26.04', argv: ['sh', '-c', 'echo hi'] })
    ).toEqual(['-d', 'Ubuntu-26.04', '--exec', 'sh', '-c', 'echo hi'])
  })

  it('never routes a wsl.exe option through --exec', () => {
    // `--list` is a wsl.exe option, not a guest program. Sending it after
    // `--exec` would ask the distro to run a file named `--list`.
    const runner = new WslCommandRunner({ platform: 'win32' })
    const args = runner.buildArgs({ scope: 'host', argv: ['--list', '--running'] })
    expect(args).toEqual(['--list', '--running'])
    expect(args).not.toContain('--exec')
  })

  it('refuses a guest command that names no distro', () => {
    const runner = new WslCommandRunner({ platform: 'win32' })
    expect(() => runner.buildArgs({ scope: 'guest', distro: '   ', argv: ['true'] })).toThrow(
      /must name a distro/
    )
  })

  it('keeps a distro name containing spaces as one argument', () => {
    const runner = new WslCommandRunner({ platform: 'win32' })
    const args = runner.buildArgs({ scope: 'guest', distro: 'Ubuntu 24.04 LTS', argv: ['true'] })
    expect(args).toContain('Ubuntu 24.04 LTS')
    // Nothing was joined into a single command string.
    expect(args.some((arg) => arg.includes(' && ') || arg.includes(' | '))).toBe(false)
  })
})

describe('execution outcomes', () => {
  it('reports success with stdout', async () => {
    const { launcher } = launcherReturning(result({ stdout: 'ok\n' }))
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    await expect(runner.run({ scope: 'guest', distro: 'd', argv: ['true'] })).resolves.toEqual({
      status: 'ok',
      stdout: 'ok\n',
      stderr: ''
    })
  })

  it('distinguishes a failing command from a missing distro', async () => {
    const { launcher } = launcherReturning(
      result({ code: 1, stderr: 'There is no distribution with the supplied name.' })
    )
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    const outcome = await runner.run({ scope: 'guest', distro: 'nope', argv: ['true'] })
    expect(outcome.status).toBe('exit_failure')
    if (outcome.status === 'exit_failure') {
      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toContain('no distribution')
    }
  })

  it('reports a timeout as its own outcome', async () => {
    const { launcher } = launcherReturning(result({ timedOut: true, code: null }))
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    await expect(runner.run({ scope: 'guest', distro: 'd', argv: ['sleep', '999'] })).resolves.toEqual({
      status: 'timed_out'
    })
  })

  it('reports a missing wsl.exe rather than a command failure', async () => {
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const { launcher } = launcherReturning(missing)
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    const outcome = await runner.run({ scope: 'guest', distro: 'd', argv: ['true'] })
    expect(outcome.status).toBe('wsl_missing')
  })

  it('does not spawn at all for a pre-aborted signal', async () => {
    const { launcher, calls } = launcherReturning(result())
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      runner.run({ scope: 'guest', distro: 'd', argv: ['true'], signal: controller.signal })
    ).resolves.toEqual({ status: 'cancelled' })
    expect(calls).toHaveLength(0)
  })

  it('reports an abort that lands mid-flight as cancelled, not as a failed command', async () => {
    const controller = new AbortController()
    // Abort while the child runs, then answer the way Node does on cancellation:
    // a signal-terminated exit that is not a timeout.
    const launcher: WslProcessLauncher = async () => {
      controller.abort()
      return { code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: false }
    }
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    const outcome = await runner.run({
      scope: 'guest',
      distro: 'd',
      argv: ['true'],
      signal: controller.signal
    })
    expect(outcome.status).toBe('cancelled')
  })

  it('sets WSL_UTF8 and uses a Windows cwd, not the inherited one', async () => {
    const { launcher, calls } = launcherReturning(result())
    const runner = new WslCommandRunner({
      launcher,
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' }
    })
    await runner.run({ scope: 'guest', distro: 'd', argv: ['true'] })
    expect(calls[0]!.env.WSL_UTF8).toBe('1')
    expect(calls[0]!.cwd).toBe('C:\\Windows')
  })

  it('applies the default timeout when the caller does not set one', async () => {
    const { launcher, calls } = launcherReturning(result())
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    await runner.run({ scope: 'guest', distro: 'd', argv: ['true'] })
    expect(calls[0]!.timeoutMs).toBe(WSL_DEFAULT_TIMEOUT_MS)
  })

  it('refuses an empty argv instead of spawning wsl.exe with nothing to run', async () => {
    const { launcher, calls } = launcherReturning(result())
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    await expect(runner.run({ scope: 'guest', distro: 'd', argv: [] })).rejects.toThrow(
      /argv must name a program/
    )
    expect(calls).toHaveLength(0)
  })
})

describe('spawn diagnostics', () => {
  function recorder(): { lines: string[]; logSpawn: (line: string) => void } {
    const lines: string[] = []
    return { lines, logSpawn: (line) => lines.push(line) }
  }

  it('is silent by default', async () => {
    const { launcher, calls } = launcherReturning(result())
    const { lines, logSpawn } = recorder()
    const runner = new WslCommandRunner({ launcher, platform: 'win32', env: {}, logSpawn })
    await runner.run({ scope: 'guest', distro: 'd', argv: ['true'] })
    expect(calls).toHaveLength(1)
    expect(lines).toHaveLength(0)
  })

  it('logs one line per actual spawn with label, distro and status', async () => {
    const { launcher } = launcherReturning(result({ stdout: 'ok\n' }))
    const { lines, logSpawn } = recorder()
    const runner = new WslCommandRunner({
      launcher,
      platform: 'win32',
      env: {},
      debugSpawns: true,
      logSpawn
    })
    await runner.run({
      scope: 'guest',
      distro: 'Ubuntu-26.04',
      label: 'inspect-create',
      argv: ['sh', '-c', 'echo hi']
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[icode:wsl-spawn\] /u)
    expect(lines[0]).toContain('label=inspect-create')
    expect(lines[0]).toContain('distro=Ubuntu-26.04')
    expect(lines[0]).toContain('program=sh')
    expect(lines[0]).toContain('status=ok')
    expect(lines[0]).toMatch(/elapsedMs=\d+/u)
  })

  it('distinguishes timeout, wsl_missing and a failing exit', async () => {
    const { launcher } = launcherReturning(
      result({ timedOut: true, code: null }),
      Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
      result({ code: 7 })
    )
    const { lines, logSpawn } = recorder()
    const runner = new WslCommandRunner({
      launcher,
      platform: 'win32',
      env: {},
      debugSpawns: true,
      logSpawn
    })
    await runner.run({ scope: 'guest', distro: 'd', argv: ['true'] })
    await runner.run({ scope: 'guest', distro: 'd', argv: ['true'] })
    await runner.run({ scope: 'guest', distro: 'd', argv: ['true'] })
    expect(lines.map((line) => line.match(/status=(\S+)/u)?.[1])).toEqual([
      'timed_out',
      'wsl_missing',
      'exit_7'
    ])
  })

  it('logs runBytes once and never logs a pre-aborted call', async () => {
    const { lines, logSpawn } = recorder()
    const byteLauncher = async () => ({
      code: 0,
      signal: null,
      stdout: Buffer.from('ok'),
      stderr: Buffer.alloc(0),
      timedOut: false
    })
    const runner = new WslCommandRunner({
      byteLauncher,
      platform: 'win32',
      env: {},
      debugSpawns: true,
      logSpawn
    })
    await runner.runBytes({ scope: 'guest', distro: 'd', label: 'git-env-probe', argv: ['sh'] })
    const controller = new AbortController()
    controller.abort()
    await runner.runBytes({
      scope: 'guest',
      distro: 'd',
      argv: ['sh'],
      signal: controller.signal
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('label=git-env-probe')
    expect(lines[0]).toContain('status=ok')
  })

  it('can be enabled by the environment variable', async () => {
    const { launcher } = launcherReturning(result())
    const { lines, logSpawn } = recorder()
    const runner = new WslCommandRunner({
      launcher,
      platform: 'win32',
      env: { ICODE_DEBUG_WSL_SPAWNS: '1' },
      logSpawn
    })
    await runner.run({ scope: 'host', argv: ['--list', '--quiet'] })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('distro=-')
    expect(lines[0]).toContain('program=--list')
  })
})

describe('output decoding', () => {
  it('decodes the UTF-16LE that a distro listing actually returns', () => {
    // Measured: `wsl --list --quiet` yields `U\0b\0u\0n\0t\0u\0-\0…`.
    const buffer = Buffer.from('Ubuntu-26.04\r\n', 'utf16le')
    expect(decodeWslOutput(buffer)).toBe('Ubuntu-26.04\r\n')
  })

  it('keeps a non-ASCII distro name readable', () => {
    const buffer = Buffer.from('Ubuntu-开发版\r\n', 'utf16le')
    expect(decodeWslOutput(buffer)).toBe('Ubuntu-开发版\r\n')
  })

  it('honours an explicit UTF-16LE BOM', () => {
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu', 'utf16le')])
    expect(decodeWslOutput(buffer)).toBe('Ubuntu')
  })

  it('decodes ordinary UTF-8 guest output unchanged', () => {
    expect(decodeWslOutput(Buffer.from('os_id=ubuntu\n', 'utf8'))).toBe('os_id=ubuntu\n')
  })

  it('decodes non-ASCII UTF-8 without mangling it', () => {
    expect(decodeWslOutput(Buffer.from('glibc=2.43 版本\n', 'utf8'))).toBe('glibc=2.43 版本\n')
  })

  it('handles empty output', () => {
    expect(decodeWslOutput(Buffer.alloc(0))).toBe('')
  })
})

describe('timeout scale', () => {
  it('defaults to 1 and rejects nonsense', () => {
    expect(resolveWslTimeoutScale({})).toBe(1)
    expect(resolveWslTimeoutScale({ [WSL_TIMEOUT_SCALE_ENV]: '4' })).toBe(4)
    expect(resolveWslTimeoutScale({ [WSL_TIMEOUT_SCALE_ENV]: '0' })).toBe(1)
    expect(resolveWslTimeoutScale({ [WSL_TIMEOUT_SCALE_ENV]: '-2' })).toBe(1)
    expect(resolveWslTimeoutScale({ [WSL_TIMEOUT_SCALE_ENV]: 'fast' })).toBe(1)
  })

  it('multiplies the budget the runner actually applies', async () => {
    const { launcher, calls } = launcherReturning(result())
    const runner = new WslCommandRunner({
      platform: 'win32',
      env: {},
      program: 'wsl.exe',
      launcher,
      // Production default is 1; this only proves the knob reaches the process.
      timeoutScale: 5
    })
    await runner.run({ scope: 'guest', distro: 'Ubuntu', argv: ['true'], timeoutMs: 1_000 })
    expect(calls[0]?.timeoutMs).toBe(5_000)
  })

  it('leaves the default budget untouched when unset', async () => {
    const { launcher, calls } = launcherReturning(result())
    const runner = new WslCommandRunner({
      platform: 'win32',
      env: {},
      program: 'wsl.exe',
      launcher
    })
    await runner.run({ scope: 'guest', distro: 'Ubuntu', argv: ['true'] })
    expect(calls[0]?.timeoutMs).toBe(WSL_DEFAULT_TIMEOUT_MS)
  })
})

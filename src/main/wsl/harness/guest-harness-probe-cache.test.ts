import { describe, expect, it } from 'vitest'
import {
  WslCommandRunner,
  type WslProcessLauncher,
  type WslProcessResult
} from '../exec'
import {
  GUEST_PATH_LOOKUP_BATCH_SCRIPT,
  type GuestHarnessSnapshot
} from './guest-harness'
import { createGuestHarnessDetector } from './guest-harness-detector'
import { createGuestHarnessProbeCache } from './guest-harness-probe-cache'

function result(stdout = '', overrides: Partial<WslProcessResult> = {}): WslProcessResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false, ...overrides }
}

function guestOf(spec: Parameters<WslProcessLauncher>[0]): string[] {
  const args = [...spec.args]
  return args.slice(args.indexOf('--exec') + 1)
}

/**
 * A fake distro whose shell and PATH are stable. Missing codex/opencode exercise
 * the `/bin/sh` fallback, which is part of a real snapshot.
 */
function harnessRunner(overrides: { version?: WslProcessResult } = {}) {
  const calls: string[][] = []
  const answer = (guest: string[]): WslProcessResult => {
    if (guest[0] === '/bin/sh' && guest[2] === 'printf %s "${SHELL:-}"') {
      return result('/bin/bash')
    }
    if (guest[0] === '/bin/bash' && guest[2] === 'printf %s "$PATH"') {
      return result('/usr/local/bin:/usr/bin:/bin')
    }
    if (guest[0] === '/bin/bash' && guest[2] === GUEST_PATH_LOOKUP_BATCH_SCRIPT) {
      return result('__ICODE_AGENT_PATH__claude=/usr/local/bin/claude\n')
    }
    if (guest[0] === '/bin/sh' && guest[2] === GUEST_PATH_LOOKUP_BATCH_SCRIPT) {
      return result('')
    }
    if (guest[0] === 'env') {
      return overrides.version ?? result('1.2.3\n')
    }
    return result('')
  }
  const launcher: WslProcessLauncher = async (spec) => {
    const guest = guestOf(spec)
    calls.push(guest)
    return answer(guest)
  }
  const byteLauncher = async (spec: Parameters<WslProcessLauncher>[0]) => {
    const guest = guestOf(spec)
    calls.push(guest)
    const text = answer(guest)
    return {
      ...text,
      stdout: Buffer.from(text.stdout, 'utf8'),
      stderr: Buffer.from(text.stderr, 'utf8')
    }
  }
  return {
    runner: new WslCommandRunner({ launcher, byteLauncher, platform: 'win32', env: {} }),
    calls
  }
}

describe('guest harness probe cache', () => {
  it('answers a second read from the snapshot without another spawn', async () => {
    const { runner, calls } = harnessRunner()
    const cache = createGuestHarnessProbeCache(runner, { now: () => 0 })
    const first = await cache.get('Ubuntu-26.04')
    const afterFirst = calls.length
    expect(first.snapshot.executables.get('claude')).toBe('/usr/local/bin/claude')
    expect(first.snapshot.shell.shell).toBe('/bin/bash')
    expect(first.transient).toBe(false)

    await cache.get('ubuntu-26.04')
    expect(calls.length).toBe(afterFirst)
    expect(afterFirst).toBeGreaterThan(0)
  })

  it('shares one in-flight probe between concurrent callers', async () => {
    const single = harnessRunner()
    const singleCache = createGuestHarnessProbeCache(single.runner)
    await singleCache.get('Ubuntu')
    const oneSequence = single.calls.length

    const concurrent = harnessRunner()
    const cache = createGuestHarnessProbeCache(concurrent.runner)
    await Promise.all([cache.get('Ubuntu'), cache.get('Ubuntu')])
    expect(concurrent.calls.length).toBe(oneSequence)
  })

  it('reprobes after the TTL', async () => {
    let now = 0
    const { runner, calls } = harnessRunner()
    const cache = createGuestHarnessProbeCache(runner, { ttlMs: 100, now: () => now })
    await cache.get('Ubuntu')
    const afterFirst = calls.length
    now = 99
    await cache.get('Ubuntu')
    expect(calls.length).toBe(afterFirst)
    now = 100
    await cache.get('Ubuntu')
    expect(calls.length).toBeGreaterThan(afterFirst)
  })

  it('does not settle a transient answer', async () => {
    let attempts = 0
    const byteLauncher = async (spec: Parameters<WslProcessLauncher>[0]) => {
      const guest = guestOf(spec)
      const ans =
        guest[0] === '/bin/sh' && guest[2] === 'printf %s "${SHELL:-}"'
          ? (() => {
              attempts += 1
              return attempts === 1
                ? result('', { timedOut: true, code: null })
                : result('/bin/sh')
            })()
          : result('')
      return {
        ...ans,
        stdout: Buffer.from(ans.stdout, 'utf8'),
        stderr: Buffer.from(ans.stderr, 'utf8')
      }
    }
    const runner = new WslCommandRunner({ byteLauncher, platform: 'win32', env: {} })
    const cache = createGuestHarnessProbeCache(runner)
    const first = await cache.get('Ubuntu')
    expect(first.transient).toBe(true)
    const second = await cache.get('Ubuntu')
    expect(second.transient).toBe(false)
    expect(attempts).toBe(2)
  })

  it('invalidates one distro or everything', async () => {
    const { runner, calls } = harnessRunner()
    const cache = createGuestHarnessProbeCache(runner)
    await cache.get('Ubuntu')
    const afterFirst = calls.length
    cache.invalidate('ubuntu')
    await cache.get('Ubuntu')
    expect(calls.length).toBeGreaterThan(afterFirst)
    cache.invalidate()
    const afterSecond = calls.length
    await cache.get('Ubuntu')
    expect(calls.length).toBeGreaterThan(afterSecond)
  })
})

describe('detector with a supplied snapshot', () => {
  it('runs only the version probe and returns the context', async () => {
    const { runner, calls } = harnessRunner()
    const snapshot: GuestHarnessSnapshot = {
      shell: { shell: '/bin/bash', mode: '-ilc' },
      loginPath: '/usr/local/bin:/usr/bin:/bin',
      executables: new Map([['claude', '/usr/local/bin/claude']]),
      transient: false
    }
    const { detector, context } = await createGuestHarnessDetector({
      runner,
      distro: 'Ubuntu',
      probe: snapshot
    })
    expect(context).toEqual({
      shell: snapshot.shell,
      loginPath: snapshot.loginPath
    })
    const detection = await detector.detectOne('claude')
    expect(detection.state).toBe('available')
    expect(detection.command?.command).toBe('/usr/local/bin/claude')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      'env',
      'PATH=/usr/local/bin:/usr/local/bin:/usr/bin:/bin',
      'NO_COLOR=1',
      'CI=1',
      '/usr/local/bin/claude',
      '--version'
    ])
  })
})

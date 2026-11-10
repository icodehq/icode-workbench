import { describe, expect, it } from 'vitest'
import { WslCommandRunner, type WslProcessLauncher, type WslProcessResult } from '../exec'
import { createGuestHomeCache } from './guest-home-cache'

function result(overrides: Partial<WslProcessResult> = {}): WslProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: '/home/olive\n',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

function runnerReturning(...results: Array<WslProcessResult | Error>): {
  runner: WslCommandRunner
  calls: number
} {
  let calls = 0
  const launcher: WslProcessLauncher = async () => {
    calls += 1
    const next = results.shift()
    if (next instanceof Error) throw next
    return next ?? result()
  }
  return {
    runner: new WslCommandRunner({ launcher, platform: 'win32', env: {} }),
    get calls() {
      return calls
    }
  }
}

describe('guest home cache', () => {
  it('answers two reads with one guest probe', async () => {
    const probe = runnerReturning(result())
    const cache = createGuestHomeCache(probe.runner, { now: () => 0 })
    await expect(cache.read('Ubuntu-26.04')).resolves.toBe('/home/olive')
    await expect(cache.read('ubuntu-26.04')).resolves.toBe('/home/olive')
    expect(probe.calls).toBe(1)
  })

  it('shares one in-flight probe between concurrent readers', async () => {
    let resolve!: (value: WslProcessResult) => void
    let calls = 0
    const launcher: WslProcessLauncher = () => {
      calls += 1
      return new Promise((done) => {
        resolve = done
      })
    }
    const runner = new WslCommandRunner({ launcher, platform: 'win32', env: {} })
    const cache = createGuestHomeCache(runner)
    const first = cache.read('Ubuntu')
    const second = cache.read('Ubuntu')
    resolve(result())
    await expect(Promise.all([first, second])).resolves.toEqual(['/home/olive', '/home/olive'])
    expect(calls).toBe(1)
  })

  it('reprobes after the TTL and keeps the cached answer before it', async () => {
    let now = 1_000
    const probe = runnerReturning(result(), result({ stdout: '/home/next\n' }))
    const cache = createGuestHomeCache(probe.runner, { ttlMs: 100, now: () => now })
    await expect(cache.read('Ubuntu')).resolves.toBe('/home/olive')
    now = 1_099
    await expect(cache.read('Ubuntu')).resolves.toBe('/home/olive')
    expect(probe.calls).toBe(1)
    now = 1_100
    await expect(cache.read('Ubuntu')).resolves.toBe('/home/next')
    expect(probe.calls).toBe(2)
  })

  it('does not cache a failed probe', async () => {
    const probe = runnerReturning(
      result({ code: 1, stdout: '', stderr: 'no answer' }),
      result()
    )
    const cache = createGuestHomeCache(probe.runner)
    await expect(cache.read('Ubuntu')).resolves.toBeNull()
    await expect(cache.read('Ubuntu')).resolves.toBe('/home/olive')
    expect(probe.calls).toBe(2)
  })

  it('invalidates one distro or everything', async () => {
    const probe = runnerReturning(result(), result(), result(), result())
    const cache = createGuestHomeCache(probe.runner)
    await cache.read('Ubuntu')
    cache.invalidate('ubuntu')
    await cache.read('Ubuntu')
    expect(probe.calls).toBe(2)
    cache.invalidate()
    await cache.read('Ubuntu')
    expect(probe.calls).toBe(3)
    cache.reset()
    await cache.read('Ubuntu')
    expect(probe.calls).toBe(4)
  })
})

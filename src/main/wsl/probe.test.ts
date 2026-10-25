import { describe, expect, it } from 'vitest'
import { WslCommandRunner, type WslByteLauncher, type WslByteResult } from './exec'
import {
  isTransportFailure,
  isWslServiceFailure,
  runIdempotentGuest,
  type GuestProbeResult
} from './probe'

function bytes(overrides: Partial<WslByteResult> = {}): WslByteResult {
  return {
    code: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    timedOut: false,
    ...overrides
  }
}

/**
 * `wsl.exe`'s own failure message is UTF-16LE, and `WSL_UTF8=1` does not apply to
 * it because it comes from the service rather than the guest program.
 */
const SERVICE_FAILURE_UTF16 = Buffer.from(
  'Wsl/Service/WSAETIMEDOUT\r\n',
  'utf16le'
)

function runnerReturning(...results: Array<GuestProbeResult>) {
  const calls: string[] = []
  const byteLauncher: WslByteLauncher = async (spec) => {
    calls.push(spec.args.join(' '))
    const next = results.shift()
    if (next === undefined) throw new Error('unexpected call')
    return next as WslByteResult
  }
  return {
    calls,
    runner: new WslCommandRunner({
      platform: 'win32',
      env: {},
      program: 'wsl.exe',
      byteLauncher
    })
  }
}

const COMMAND = { scope: 'guest' as const, distro: 'Ubuntu-26.04', argv: ['true'] }

describe('transport failure detection', () => {
  it('recognises the UTF-16LE service message', () => {
    expect(isWslServiceFailure(bytes({ code: 255, stdout: SERVICE_FAILURE_UTF16 }))).toBe(true)
  })

  it('treats exit 255 as transport, even without the marker', () => {
    // A one-line `test -d` script exits 0 or 1; 255 can only be wsl.exe itself.
    expect(isTransportFailure(bytes({ code: 255 }))).toBe(true)
  })

  it('does not treat a guest answer as transport', () => {
    expect(isTransportFailure(bytes({ code: 1 }))).toBe(false)
    expect(isTransportFailure(bytes({ code: 0 }))).toBe(false)
  })

  it('treats a timeout as transport', () => {
    expect(isTransportFailure(bytes({ code: null, timedOut: true }))).toBe(true)
  })
})

describe('idempotent guest retry', () => {
  it('retries once after a timeout, then returns the answer', async () => {
    const { calls, runner } = runnerReturning(
      bytes({ code: null, timedOut: true }),
      bytes({ code: 0 })
    )
    const result = await runIdempotentGuest(runner, COMMAND)
    expect(calls).toHaveLength(2)
    expect('timedOut' in result && result.timedOut).toBe(false)
  })

  it('retries a service failure', async () => {
    const { calls, runner } = runnerReturning(
      bytes({ code: 255, stdout: SERVICE_FAILURE_UTF16 }),
      bytes({ code: 0 })
    )
    const result = await runIdempotentGuest(runner, COMMAND)
    expect(calls).toHaveLength(2)
    expect('code' in result && result.code).toBe(0)
  })

  it('does not re-ask when the guest answered "no"', async () => {
    const { calls, runner } = runnerReturning(bytes({ code: 1 }))
    const result = await runIdempotentGuest(runner, COMMAND)
    expect(calls).toHaveLength(1)
    expect('code' in result && result.code).toBe(1)
  })

  it('does not retry a missing wsl.exe', async () => {
    const { calls, runner } = runnerReturning({ status: 'wsl_missing' })
    await runIdempotentGuest(runner, COMMAND)
    expect(calls).toHaveLength(1)
  })

  it('gives up after the bounded retry', async () => {
    const { calls, runner } = runnerReturning(
      bytes({ code: null, timedOut: true }),
      bytes({ code: null, timedOut: true })
    )
    const result = await runIdempotentGuest(runner, COMMAND)
    expect(calls).toHaveLength(2)
    expect('timedOut' in result && result.timedOut).toBe(true)
  })
})

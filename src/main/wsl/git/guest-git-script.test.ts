import { beforeEach, describe, expect, it } from 'vitest'
import {
  WslCommandRunner,
  type WslByteResult
} from '../exec'
import {
  createGuestGitScriptRunner,
  type GuestGitScriptRequest
} from './guest-git-script'
import { GUEST_GIT_ENV, resetGuestGitEnvironments } from './guest-git'

function bytes(stdout = '', overrides: Partial<WslByteResult> = {}): WslByteResult {
  return {
    code: 0,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    timedOut: false,
    ...overrides
  }
}

function probeAnswer(): WslByteResult {
  return bytes(
    '__ICODE_GIT_OUT_START__/usr/local/bin:/usr/bin:/bin\u0000/usr/bin/git\u0000/home/u' +
      '__ICODE_GIT_OUT_END____ICODE_GIT_STATUS__0'
  )
}

function scriptedRunner(options: {
  direct?: WslByteResult[]
  fallback?: WslByteResult[]
  noDirectRoute?: boolean
}) {
  const directCalls: string[][] = []
  const fallbackCalls: string[][] = []
  const byteLauncher = async (spec: {
    args: readonly string[]
  }): Promise<WslByteResult> => {
    const args = [...spec.args]
    const guest = args.slice(args.indexOf('--exec') + 1)
    if (guest[0] === 'sh' && guest[1] === '-lc' && (guest[2] ?? '').includes('command -v git')) {
      return options.noDirectRoute === true
        ? bytes('', { code: 127, stderr: Buffer.from('git: not found') })
        : probeAnswer()
    }
    if (guest[0] === '/usr/bin/env') {
      directCalls.push(guest)
      return options.direct?.shift() ?? bytes('ok')
    }
    if (guest[0] === '/bin/sh' && guest[1] === '-lc') {
      fallbackCalls.push(guest)
      return options.fallback?.shift() ?? bytes('fallback-ok')
    }
    return bytes('')
  }
  return {
    runner: new WslCommandRunner({ byteLauncher, platform: 'win32', env: {} }),
    directCalls,
    fallbackCalls
  }
}

function request(overrides: Partial<GuestGitScriptRequest> = {}): GuestGitScriptRequest {
  return {
    distro: 'Ubuntu-26.04',
    label: 'inspect-create',
    script: '__SCRIPT__',
    args: ['/home/u/src', '/home/u/repo'],
    timeoutMs: 20_000,
    mutation: false,
    ...overrides
  }
}

beforeEach(() => {
  resetGuestGitEnvironments()
})

describe('guest git script runner', () => {
  it('runs the script through the resolved direct environment', async () => {
    const fake = scriptedRunner({})
    const run = createGuestGitScriptRunner(fake.runner)
    const outcome = await run(request())
    expect(outcome.status).toBe('ok')
    expect(fake.directCalls).toHaveLength(1)
    expect(fake.directCalls[0]).toEqual([
      '/usr/bin/env',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'HOME=/home/u',
      ...GUEST_GIT_ENV,
      '/bin/sh',
      '-c',
      '__SCRIPT__',
      'icode-guest-script',
      '/usr/bin/git',
      '/home/u/src',
      '/home/u/repo'
    ])
  })

  it('retries a read once when the transport fails', async () => {
    const fake = scriptedRunner({
      direct: [bytes('', { timedOut: true, code: null }), bytes('ok')]
    })
    const run = createGuestGitScriptRunner(fake.runner)
    const outcome = await run(request())
    expect(outcome).toMatchObject({ status: 'ok', stdout: 'ok' })
    expect(fake.directCalls).toHaveLength(2)
  })

  it('never retries a mutation after a transport failure', async () => {
    const fake = scriptedRunner({
      direct: [bytes('', { timedOut: true, code: null }), bytes('ok')]
    })
    const run = createGuestGitScriptRunner(fake.runner)
    const outcome = await run(request({ mutation: true, label: 'worktree-create' }))
    expect(outcome).toMatchObject({ status: 'transport', timedOut: true })
    expect(fake.directCalls).toHaveLength(1)
  })

  it('falls back to the login shell when the cached Git path is stale', async () => {
    const fake = scriptedRunner({
      direct: [bytes('', { code: 127, stderr: Buffer.from('git: not found') })]
    })
    const run = createGuestGitScriptRunner(fake.runner)
    const outcome = await run(request())
    expect(outcome).toMatchObject({ status: 'ok', stdout: 'fallback-ok' })
    expect(fake.directCalls).toHaveLength(1)
    expect(fake.fallbackCalls).toHaveLength(1)
    expect(fake.fallbackCalls[0]?.[0]).toBe('/bin/sh')
    expect(fake.fallbackCalls[0]?.[1]).toBe('-lc')
  })

  it('uses the login shell directly when no direct route was resolved', async () => {
    const fake = scriptedRunner({ noDirectRoute: true })
    const run = createGuestGitScriptRunner(fake.runner)
    const outcome = await run(request({ mutation: true }))
    expect(outcome).toMatchObject({ status: 'ok', stdout: 'fallback-ok' })
    expect(fake.directCalls).toHaveLength(0)
    expect(fake.fallbackCalls).toHaveLength(1)
  })
})

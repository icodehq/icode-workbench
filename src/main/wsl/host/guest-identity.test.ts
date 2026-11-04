import { describe, expect, it } from 'vitest'
import type { WslExecOutcome, WslProcessLauncher } from '../exec'
import { WslCommandRunner } from '../exec'
import {
  buildHostIdentityArgs,
  guestHostIsOurs,
  GUEST_HOST_IDENTITY_SCRIPT,
  parseGuestHostIdentity,
  readGuestHostIdentity
} from './guest-identity'

const BOOT = 'fde34a6a-a6bf-46a0-8563-9a249cd0f8ad'
const INIT = '1 (systemd) S 0 1 1 0 -1 4194560 518526 430560449 78785 884748 1717 76692 1546580 26640 20 0 1 0 145 25223168 2400 0 0'
const HOST_STAT = '991 (node) S 1 991 991 0 -1 4194560 100 0 0 0 1 5 0 0 20 0 1 0 52397645 0 0'
const ENTRY = '/home/u/.icode/host/scope/v24.21.0/host/index.js'
const META = JSON.stringify(
  {
    pid: 991,
    startedAt: 1_729_000_001_000,
    protocolVersion: 1,
    hostVersion: '0.1.0-icode1',
    socket: '/home/u/.icode/host/scope/v24.21.0/run/host.sock',
    tokenFile: '/home/u/.icode/host/scope/v24.21.0/run/token'
  },
  null,
  2
)

/** Frames output the way the guest script does. */
function frame(sections: {
  boot?: string
  init?: string
  hostStat?: string
  cmdline?: string
  meta?: string
}): string {
  return [
    '',
    sections.boot ?? `${BOOT}\n`,
    sections.init ?? `${INIT}\n`,
    sections.hostStat ?? '',
    sections.cmdline ?? '',
    sections.meta ?? '',
    ''
  ].join('__ICODE_HOST_ID__')
}

describe('guest identity parsing', () => {
  it('reads boot, PID 1, Host pid, start ticks, command line and meta together', () => {
    const identity = parseGuestHostIdentity(
      frame({
        hostStat: `host_pid=991\n${HOST_STAT}\n`,
        cmdline: `/home/u/.icode/host/scope/v24.21.0/node/bin/node ${ENTRY} \n`,
        meta: META
      })
    )
    expect(identity).not.toBeNull()
    expect(identity!.distroInstance).toBe(`${BOOT}:145`)
    expect(identity!.hostPid).toBe(991)
    expect(identity!.hostStartTicks).toBe('52397645')
    expect(identity!.hostCommandLine).toContain(ENTRY)
    expect(identity!.meta?.protocolVersion).toBe(1)
  })

  it('reports no Host pid as a valid answer, not a failure', () => {
    const identity = parseGuestHostIdentity(frame({ hostStat: 'host_pid=\n' }))
    expect(identity?.hostPid).toBeNull()
    expect(identity?.distroInstance).toBe(`${BOOT}:145`)
  })

  it('returns null without a boot id', () => {
    expect(parseGuestHostIdentity(frame({ boot: 'not-a-guid\n' }))).toBeNull()
    expect(parseGuestHostIdentity('garbage')).toBeNull()
  })

  it('returns null without a PID 1 start time', () => {
    expect(parseGuestHostIdentity(frame({ init: '' }))).toBeNull()
  })

  it('normalizes the boot id case', () => {
    expect(parseGuestHostIdentity(frame({ boot: `${BOOT.toUpperCase()}\n` }))?.bootId).toBe(BOOT)
  })

  it('keeps a missing command line as null rather than empty', () => {
    const identity = parseGuestHostIdentity(frame({ hostStat: 'host_pid=991\n' }))
    expect(identity?.hostCommandLine).toBeNull()
  })

  it('tolerates a login banner before the first marker', () => {
    const noisy = `Welcome to Ubuntu\n${frame({ hostStat: 'host_pid=991\n' })}`
    expect(parseGuestHostIdentity(noisy)?.bootId).toBe(BOOT)
  })
})

describe('Host ownership', () => {
  function identityWith(overrides: Partial<Parameters<typeof guestHostIsOurs>[0]> = {}) {
    return {
      bootId: BOOT,
      initTicks: '145',
      distroInstance: `${BOOT}:145`,
      hostPid: 991,
      hostStartTicks: '52397645',
      hostCommandLine: `/home/u/.icode/host/.../node/bin/node ${ENTRY}`,
      meta: { pid: 991, startedAt: 1, protocolVersion: 1, hostVersion: 'v', socket: '/s' },
      ...overrides
    }
  }

  it('accepts a process whose command line names our entry', () => {
    expect(guestHostIsOurs(identityWith(), { entryPath: ENTRY })).toBe(true)
  })

  it('rejects a process running a different entry', () => {
    expect(
      guestHostIsOurs(identityWith({ hostCommandLine: '/usr/bin/node /other/index.js' }), {
        entryPath: ENTRY
      })
    ).toBe(false)
  })

  it('rejects when the pid is unknown', () => {
    expect(guestHostIsOurs(identityWith({ hostPid: null }), { entryPath: ENTRY })).toBe(false)
  })

  it('rejects when the meta names a different pid than the pid file', () => {
    // Two incarnations must never be mixed into one identity.
    expect(
      guestHostIsOurs(
        identityWith({
          meta: { pid: 992, startedAt: 1, protocolVersion: 1, hostVersion: 'v', socket: '/s' }
        }),
        { entryPath: ENTRY }
      )
    ).toBe(false)
  })

  it('rejects a pid whose start ticks differ from the record — PID reuse', () => {
    expect(
      guestHostIsOurs(identityWith(), { entryPath: ENTRY, recordedStartTicks: '111' })
    ).toBe(false)
  })

  it('rejects a pid that differs from the record', () => {
    expect(guestHostIsOurs(identityWith(), { entryPath: ENTRY, recordedPid: 5 })).toBe(false)
  })
})

describe('identity read', () => {
  function runner(outcome: WslExecOutcome, calls: string[][] = []): WslCommandRunner {
    const launcher: WslProcessLauncher = async (spec) => {
      calls.push([...spec.args])
      if (outcome.status === 'ok') {
        return { code: 0, signal: null, stdout: outcome.stdout, stderr: '', timedOut: false }
      }
      if (outcome.status === 'timed_out') {
        return { code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true }
      }
      return { code: 1, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    return new WslCommandRunner({ launcher, platform: 'win32' })
  }

  it('performs exactly one guest execution', async () => {
    const calls: string[][] = []
    const framed = frame({ hostStat: 'host_pid=991\n', meta: META })
    const read = await readGuestHostIdentity(
      runner({ status: 'ok', stdout: framed, stderr: '' }, calls),
      'Ubuntu-26.04',
      { pidFile: '/run/host.pid', metaPath: '/run/meta.json' }
    )
    expect(read.status).toBe('ok')
    expect(calls).toHaveLength(1)
    // Both paths travelled as argv, never as shell syntax.
    expect(calls[0]).toContain('/run/host.pid')
    expect(calls[0]).toContain('/run/meta.json')
  })

  it('reports a timeout as unavailable, never as a changed identity', async () => {
    const read = await readGuestHostIdentity(
      runner({ status: 'timed_out' }),
      'Ubuntu-26.04',
      { pidFile: '/run/host.pid', metaPath: '/run/meta.json' }
    )
    expect(read).toEqual({ status: 'unavailable', reason: 'timed_out' })
  })

  it('reports unparseable output as such', async () => {
    const read = await readGuestHostIdentity(
      runner({ status: 'ok', stdout: 'nothing useful', stderr: '' }),
      'Ubuntu-26.04',
      { pidFile: '/run/host.pid', metaPath: '/run/meta.json' }
    )
    expect(read.status).toBe('unparseable')
  })

  it('builds argv with the constant script and the paths as positional arguments', () => {
    const args = buildHostIdentityArgs('/a/pid', '/b/meta.json')
    expect(args[0]).toBe('sh')
    expect(args[1]).toBe('-c')
    expect(args[2]).toBe(GUEST_HOST_IDENTITY_SCRIPT)
    expect(args.slice(3)).toEqual(['icode-host-identity', '/a/pid', '/b/meta.json'])
  })

  it('reads the pid file inside the guest, so no controller-side pid races the read', () => {
    expect(GUEST_HOST_IDENTITY_SCRIPT).toContain('cat "$1"')
    expect(GUEST_HOST_IDENTITY_SCRIPT).toContain('/proc/$__icode_pid/stat')
    expect(GUEST_HOST_IDENTITY_SCRIPT).not.toMatch(/\$\{?PWD/)
  })
})

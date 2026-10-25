import { describe, expect, it } from 'vitest'
import type { WslProcessLauncher } from './exec'
import { WslCommandRunner } from './exec'
import {
  GUEST_IDENTITY_SCRIPT,
  parseGuestIdentity,
  procStatStartTicks,
  readGuestIdentity
} from './identity'

const BOOT_ID = 'fde34a6a-1b2c-4d3e-8f90-0123456789ab'
/** `/proc/1/stat` as the kernel prints it: field 2 is parenthesised and may hold spaces. */
const INIT_STAT = '1 (systemd) S 0 1 1 0 -1 4194560 100 0 0 0 1 5 0 0 20 0 1 0 145 0 0'

/** Frames a payload the way the guest script does. */
function framed(...sections: string[]): string {
  return sections.map((section) => `__ADE_IDENTITY__\n${section}`).join('') + '__ADE_IDENTITY__\n'
}

function runnerReturning(stdout: string, status: 'ok' | 'timed_out' = 'ok'): WslCommandRunner {
  const launcher: WslProcessLauncher = async () =>
    status === 'ok'
      ? { code: 0, signal: null, stdout, stderr: '', timedOut: false }
      : { code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true }
  return new WslCommandRunner({ launcher, platform: 'win32' })
}

describe('proc stat parsing', () => {
  it('reads field 22 after the parenthesised command name', () => {
    expect(procStatStartTicks(INIT_STAT)).toBe('145')
  })

  it('handles a command name containing spaces and parentheses', () => {
    const stat = '1 (my (odd) init) S 0 1 1 0 -1 4194560 100 0 0 0 1 5 0 0 20 0 1 0 777 0 0'
    expect(procStatStartTicks(stat)).toBe('777')
  })

  it('refuses a truncated or non-numeric field', () => {
    expect(procStatStartTicks('1 (init) S 0')).toBeNull()
    expect(procStatStartTicks('not a stat line')).toBeNull()
  })
})

describe('guest identity parsing', () => {
  it('derives one boot instance from the boot id and PID 1 ticks', () => {
    const identity = parseGuestIdentity(framed(`${BOOT_ID}\n`, `${INIT_STAT}\n`))
    expect(identity).toEqual({
      bootId: BOOT_ID,
      initStartTicks: '145',
      distroInstance: `${BOOT_ID}:145`
    })
  })

  it('lowercases the boot id so two spellings are one identity', () => {
    const identity = parseGuestIdentity(framed(`${BOOT_ID.toUpperCase()}\n`, `${INIT_STAT}\n`))
    expect(identity?.bootId).toBe(BOOT_ID)
  })

  it('ignores a login banner printed before the first marker', () => {
    const noisy = `Welcome to Ubuntu 26.04 LTS\nLast login: Thu Oct 23\n${framed(
      `${BOOT_ID}\n`,
      `${INIT_STAT}\n`
    )}`
    expect(parseGuestIdentity(noisy)?.distroInstance).toBe(`${BOOT_ID}:145`)
  })

  it('gives one distro two different identities across two boots', () => {
    // A restart changes the boot id, so a Host identity from the previous boot
    // cannot look current.
    const first = parseGuestIdentity(framed(`${BOOT_ID}\n`, `${INIT_STAT}\n`))
    const second = parseGuestIdentity(
      framed(`00000000-1111-2222-3333-444455556666\n`, `${INIT_STAT}\n`)
    )
    expect(first?.distroInstance).not.toBe(second?.distroInstance)
  })

  it('rejects output with no markers instead of guessing', () => {
    expect(parseGuestIdentity(`${BOOT_ID}\n${INIT_STAT}\n`)).toBeNull()
  })

  it('rejects a malformed boot id', () => {
    expect(parseGuestIdentity(framed('not-a-guid\n', `${INIT_STAT}\n`))).toBeNull()
  })

  it('rejects a missing PID 1 line', () => {
    expect(parseGuestIdentity(framed(`${BOOT_ID}\n`, ''))).toBeNull()
  })
})

describe('identity reads', () => {
  it('returns the identity on a clean run', async () => {
    const read = await readGuestIdentity(
      runnerReturning(framed(`${BOOT_ID}\n`, `${INIT_STAT}\n`)),
      'Ubuntu-26.04'
    )
    expect(read.status).toBe('ok')
    if (read.status === 'ok') expect(read.identity.initStartTicks).toBe('145')
  })

  it('reports unparseable rather than an identity when the guest says nothing useful', async () => {
    const read = await readGuestIdentity(runnerReturning('garbage\n'), 'Ubuntu-26.04')
    expect(read.status).toBe('unparseable')
  })

  it('reports a timeout as unavailable, never as a changed identity', async () => {
    const read = await readGuestIdentity(runnerReturning('', 'timed_out'), 'Ubuntu-26.04')
    expect(read.status).toBe('unavailable')
    if (read.status === 'unavailable') expect(read.reason).toBe('timed_out')
  })

  it('uses a constant script that no caller value can enter', () => {
    // Guards the invariant behind AC-06: the script is a literal.
    expect(GUEST_IDENTITY_SCRIPT).toContain('/proc/sys/kernel/random/boot_id')
    expect(GUEST_IDENTITY_SCRIPT).toContain('/proc/1/stat')
    expect(GUEST_IDENTITY_SCRIPT).not.toContain('$1')
  })
})

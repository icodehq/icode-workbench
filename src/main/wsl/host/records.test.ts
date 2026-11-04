import { describe, expect, it } from 'vitest'
import {
  guestRecordMatchesBoot,
  parseGuestHostMeta,
  parseWslGuestHostRecord,
  parseWslHolderRecord,
  type WslGuestHostRecord
} from './records'

const HOLDER = {
  version: 1,
  distro: 'Ubuntu-26.04',
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73',
  windowsPid: 4242,
  creationTimeMs: 1_729_000_000_000,
  startedAtMs: 1_729_000_000_100
}

const GUEST: WslGuestHostRecord = {
  version: 1,
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73',
  distroInstance: 'fde34a6a-a6bf-46a0-8563-9a249cd0f8ad:145',
  pid: 991,
  startTicks: '52397645',
  hostDir: '/home/u/.icode/host/scope/v24.21.0-node-pty-1.1.0-linux-x64-glibc2.35',
  socket: '/home/u/.icode/host/scope/v24.21.0-node-pty-1.1.0-linux-x64-glibc2.35/run/host.sock',
  protocolVersion: 1,
  hostVersion: '0.1.0-icode1',
  buildFingerprint: 'v24.21.0-node-pty-1.1.0-linux-x64-glibc2.35:04a46ad2702cf99a',
  artifactVersion: 'v24.21.0-node-pty-1.1.0-linux-x64-glibc2.35',
  recordedAtMs: 1_729_000_001_000
}

describe('holder record parsing', () => {
  it('round-trips a complete record', () => {
    expect(parseWslHolderRecord(JSON.stringify(HOLDER))).toEqual(HOLDER)
  })

  it('accepts a record whose creation time was unavailable', () => {
    const parsed = parseWslHolderRecord(JSON.stringify({ ...HOLDER, creationTimeMs: null }))
    expect(parsed?.creationTimeMs).toBeNull()
  })

  it('rejects a truncated record rather than repairing it', () => {
    const { windowsPid: _omitted, ...missingPid } = HOLDER
    expect(parseWslHolderRecord(JSON.stringify(missingPid))).toBeNull()
  })

  it('rejects an unknown version', () => {
    expect(parseWslHolderRecord(JSON.stringify({ ...HOLDER, version: 2 }))).toBeNull()
  })

  it('rejects a non-positive or fractional pid', () => {
    expect(parseWslHolderRecord(JSON.stringify({ ...HOLDER, windowsPid: 0 }))).toBeNull()
    expect(parseWslHolderRecord(JSON.stringify({ ...HOLDER, windowsPid: 42.5 }))).toBeNull()
  })

  it('rejects non-JSON without throwing', () => {
    expect(parseWslHolderRecord('{not json')).toBeNull()
    expect(parseWslHolderRecord('')).toBeNull()
  })
})

describe('guest Host record parsing', () => {
  it('round-trips a complete record', () => {
    expect(parseWslGuestHostRecord(JSON.stringify(GUEST))).toEqual(GUEST)
  })

  it('rejects a record whose start ticks are not numeric', () => {
    expect(parseWslGuestHostRecord(JSON.stringify({ ...GUEST, startTicks: 'abc' }))).toBeNull()
  })

  it('rejects a record with no build fingerprint', () => {
    const { buildFingerprint: _omitted, ...rest } = GUEST
    expect(parseWslGuestHostRecord(JSON.stringify(rest))).toBeNull()
  })
})

describe('Host meta parsing', () => {
  it('reads the fields the existing Host writes', () => {
    const meta = parseGuestHostMeta(
      JSON.stringify({
        pid: 991,
        startedAt: 1_729_000_001_000,
        protocolVersion: 1,
        hostVersion: '0.1.0-icode1',
        socket: '/run/host.sock',
        tokenFile: '/run/token',
        tokenMode: '600'
      })
    )
    expect(meta).toEqual({
      pid: 991,
      startedAt: 1_729_000_001_000,
      protocolVersion: 1,
      hostVersion: '0.1.0-icode1',
      socket: '/run/host.sock'
    })
  })

  it('rejects a meta without a pid or protocol version', () => {
    expect(parseGuestHostMeta(JSON.stringify({ socket: '/x' }))).toBeNull()
    expect(
      parseGuestHostMeta(JSON.stringify({ pid: 1, startedAt: 1, socket: '/x', hostVersion: 'v' }))
    ).toBeNull()
  })
})

describe('boot scoping', () => {
  it('matches a record to the boot it was written in', () => {
    expect(
      guestRecordMatchesBoot(GUEST, {
        distroInstance: GUEST.distroInstance,
        distroId: GUEST.distroId
      })
    ).toBe(true)
  })

  it('refuses a record from another boot', () => {
    expect(
      guestRecordMatchesBoot(GUEST, {
        distroInstance: '00000000-1111-2222-3333-444455556666:145',
        distroId: GUEST.distroId
      })
    ).toBe(false)
  })

  it('refuses a record from another registration with the same boot shape', () => {
    expect(
      guestRecordMatchesBoot(GUEST, {
        distroInstance: GUEST.distroInstance,
        distroId: 'ffffffff-1111-2222-3333-444455556666'
      })
    ).toBe(false)
  })
})

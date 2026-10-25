import { describe, expect, it } from 'vitest'
import { wslDistroListPayloadSchema } from '../../shared/schemas/ipc'
import type { WslDistroDiscovery } from './distros'
import { toWslDistroListPayload } from './distro-list'

describe('distro list payload', () => {
  it('carries every field the dialog offers, and validates on the wire', () => {
    const discovery: WslDistroDiscovery = {
      status: 'ok',
      distros: [
        { name: 'Ubuntu-26.04', registrationId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73', version: 2, running: true },
        { name: 'Debian', registrationId: 'ffffffff-2b9e-49bf-940e-0c19a6caef73', version: 1, running: null }
      ],
      defaultRegistrationId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
    }
    const payload = toWslDistroListPayload(discovery)
    expect(wslDistroListPayloadSchema.parse(payload)).toEqual(payload)
    // `running: null` must survive: unknown is not "stopped".
    if (payload.status !== 'ok') throw new Error('unreachable')
    expect(payload.distros[1]).toEqual({
      name: 'Debian',
      registrationId: 'ffffffff-2b9e-49bf-940e-0c19a6caef73',
      version: 1,
      running: null
    })
  })

  it('keeps "unavailable" distinct from an empty list', () => {
    const payload = toWslDistroListPayload({
      status: 'unavailable',
      reason: 'registry_unreadable',
      detail: 'reg.exe failed'
    })
    expect(wslDistroListPayloadSchema.parse(payload)).toEqual({
      status: 'unavailable',
      reason: 'registry_unreadable',
      detail: 'reg.exe failed'
    })
    // An empty `ok` list means "no distros installed" — a different answer.
    expect(payload.status).not.toBe('ok')
  })

  it('passes an empty ok list through unchanged', () => {
    const payload = toWslDistroListPayload({
      status: 'ok',
      distros: [],
      defaultRegistrationId: null
    })
    expect(payload).toEqual({ status: 'ok', distros: [], defaultRegistrationId: null })
  })

  it('drops nothing a caller needs, and adds nothing private', () => {
    const payload = toWslDistroListPayload({
      status: 'ok',
      distros: [{ name: 'Ubuntu', registrationId: 'abc', version: 2, running: false }],
      defaultRegistrationId: null
    })
    expect(Object.keys(payload)).toEqual(['status', 'distros', 'defaultRegistrationId'])
    if (payload.status !== 'ok') throw new Error('unreachable')
    expect(Object.keys(payload.distros[0]!)).toEqual([
      'name',
      'registrationId',
      'version',
      'running'
    ])
  })
})

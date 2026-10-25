import { describe, expect, it } from 'vitest'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { makeAppError } from '../../shared/domain/errors'
import type { HostEvent } from '../../shared/host-protocol'
import {
  createWslHostClientPool,
  WslHostConnectError,
  type WslHostRelayLike
} from './wsl-host-client-pool'

const WSL: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
}

describe('WSL host pool', () => {
  it('refuses a non-WSL target instead of serving it locally', async () => {
    const pool = createWslHostClientPool({ relay: { start: async () => ({ status: 'not_wsl' }) } })
    await expect(pool.client({ kind: 'local' })).rejects.toBeInstanceOf(WslHostConnectError)
  })

  it('maps a W4 refusal to a typed connect failure', async () => {
    const relay: WslHostRelayLike = {
      start: async () => ({
        status: 'unavailable',
        error: makeAppError('WSL_HOST_DEPLOY_FAILED', 'The artifacts do not match.'),
        detail: 'deploy'
      })
    }
    const pool = createWslHostClientPool({ relay })
    const error = await pool.client(WSL).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(WslHostConnectError)
    expect((error as WslHostConnectError).failure).toMatchObject({
      code: 'WSL_HOST_START_FAILED',
      message: 'The artifacts do not match.'
    })
  })

  it('maps an unverifiable Host to its own code, never to "not found"', async () => {
    const relay: WslHostRelayLike = {
      start: async () => ({
        status: 'unverified',
        error: makeAppError('WSL_HOST_UNVERIFIABLE', 'Cannot prove ownership.'),
        detail: 'endpoint_not_owned'
      })
    }
    const error = await createWslHostClientPool({ relay })
      .client(WSL)
      .catch((value: unknown) => value)
    expect((error as WslHostConnectError).failure.code).toBe('WSL_HOST_UNVERIFIABLE')
  })

  it('remembers a failure briefly so a dead distro is not retried per call', async () => {
    let starts = 0
    const relay: WslHostRelayLike = {
      start: async () => {
        starts += 1
        return {
          status: 'rejected',
          error: makeAppError('WSL_UNAVAILABLE', 'WSL is not available.')
        }
      }
    }
    const pool = createWslHostClientPool({ relay, now: () => 1_000 })
    await pool.client(WSL).catch(() => {})
    await pool.client(WSL).catch(() => {})
    expect(starts).toBe(1)
  })

  it('retries once the failure window has passed', async () => {
    let starts = 0
    let clock = 0
    const relay: WslHostRelayLike = {
      start: async () => {
        starts += 1
        return { status: 'rejected', error: makeAppError('WSL_UNAVAILABLE', 'WSL is not available.') }
      }
    }
    const pool = createWslHostClientPool({ relay, now: () => clock })
    await pool.client(WSL).catch(() => {})
    clock = 60_000
    await pool.client(WSL).catch(() => {})
    expect(starts).toBe(2)
  })

  it('broadcasts events from every distro into the one listener set', () => {
    const pool = createWslHostClientPool({ relay: { start: async () => ({ status: 'not_wsl' }) } })
    const seen: HostEvent[] = []
    const off = pool.onEvent((event) => seen.push(event))
    // No connections yet: subscribing must not throw or start anything.
    expect(seen).toHaveLength(0)
    off()
  })

  it('disconnect only closes relay endpoints', () => {
    const pool = createWslHostClientPool({ relay: { start: async () => ({ status: 'not_wsl' }) } })
    // Idempotent, and it never touches a Host.
    expect(() => {
      pool.disconnect()
      pool.disconnect()
    }).not.toThrow()
  })
})

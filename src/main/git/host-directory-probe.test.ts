import { describe, expect, it, vi } from 'vitest'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { createHostDirectoryProbe } from './host-directory-probe'

const WSL: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
}

describe('host directory probe', () => {
  it('shares one in-flight WSL probe and reuses it inside the window', async () => {
    let now = 0
    let release: (exists: boolean) => void = () => undefined
    const isDirectory = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    const probe = createHostDirectoryProbe({
      hostFsFor: async () => ({ isDirectory }),
      ttlMs: 100,
      now: () => now
    })

    const first = probe.isDirectory(WSL, '/home/u/wt')
    const second = probe.isDirectory(WSL, '/home/u/wt')
    await vi.waitFor(() => expect(isDirectory).toHaveBeenCalledTimes(1))
    release(true)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])

    now = 50
    await expect(probe.isDirectory(WSL, '/home/u/wt')).resolves.toBe(true)
    expect(isDirectory).toHaveBeenCalledTimes(1)

    now = 101
    const third = probe.isDirectory(WSL, '/home/u/wt')
    await vi.waitFor(() => expect(isDirectory).toHaveBeenCalledTimes(2))
    release(false)
    await expect(third).resolves.toBe(false)
  })

  it('never caches a transport failure', async () => {
    let attempts = 0
    const probe = createHostDirectoryProbe({
      hostFsFor: async () => ({
        isDirectory: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('the distro did not answer')
          return true
        }
      }),
      ttlMs: 5_000
    })

    await expect(probe.isDirectory(WSL, '/home/u/wt')).rejects.toThrow('did not answer')
    await expect(probe.isDirectory(WSL, '/home/u/wt')).resolves.toBe(true)
    expect(attempts).toBe(2)
  })

  it('does not cache a local stat', async () => {
    const isDirectory = vi.fn(async () => true)
    const probe = createHostDirectoryProbe({
      hostFsFor: async () => ({ isDirectory }),
      ttlMs: 5_000
    })
    await probe.isDirectory({ kind: 'local' }, '/repo')
    await probe.isDirectory({ kind: 'local' }, '/repo')
    expect(isDirectory).toHaveBeenCalledTimes(2)
  })

  it('keys the cache by target and path', async () => {
    const isDirectory = vi.fn(async (path: string) => path.endsWith('/present'))
    const probe = createHostDirectoryProbe({
      hostFsFor: async () => ({ isDirectory }),
      ttlMs: 5_000
    })
    await expect(probe.isDirectory(WSL, '/home/u/present')).resolves.toBe(true)
    await expect(probe.isDirectory(WSL, '/home/u/missing')).resolves.toBe(false)
    expect(isDirectory).toHaveBeenCalledTimes(2)
  })
})

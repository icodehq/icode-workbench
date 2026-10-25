import { describe, expect, it } from 'vitest'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { WslDistroDiscoveryDeps } from './distros'
import type { WslProcessLauncher } from './exec'
import { WslCommandRunner } from './exec'
import {
  RepositoryTargetError,
  createTargetValidator,
  revalidateRepositoryTarget
} from './repository-target'

const UBUNTU_ID = 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
const OTHER_ID = 'ffffffff-1111-2222-3333-444455556666'

/** A registry holding one WSL 2 distro, and one WSL 1 distro. */
const REGISTRY = [
  `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{${UBUNTU_ID}}`,
  '    DistributionName    REG_SZ    Ubuntu-26.04',
  '    Version    REG_DWORD    0x2',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{cccccccc-1111-2222-3333-444455556666}',
  '    DistributionName    REG_SZ    Legacy-Distro',
  '    Version    REG_DWORD    0x1'
].join('\r\n')

function deps(
  options: {
    runningStdout?: string
    registry?: string | null
  } = {}
): WslDistroDiscoveryDeps {
  const launcher: WslProcessLauncher = async () => ({
    code: 0,
    signal: null,
    stdout: options.runningStdout ?? '',
    stderr: '',
    timedOut: false
  })
  return {
    runner: new WslCommandRunner({ launcher, platform: 'win32' }),
    platform: 'win32',
    queryRegistry: async () => (options.registry === undefined ? REGISTRY : options.registry)
  }
}

async function rejection(promise: Promise<unknown>): Promise<RepositoryTargetError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RepositoryTargetError) return error
    throw error
  }
  throw new Error('expected a RepositoryTargetError')
}

describe('local targets', () => {
  it('pass through unchanged without touching the OS', async () => {
    let discovered = 0
    const validate = createTargetValidator({
      runner: new WslCommandRunner({
        launcher: async () => {
          discovered += 1
          return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
        },
        platform: 'win32'
      }),
      platform: 'win32',
      queryRegistry: async () => {
        discovered += 1
        return REGISTRY
      }
    })
    const local: ExecutionTarget = { kind: 'local' }
    await expect(validate(local)).resolves.toBe(local)
    expect(discovered).toBe(0)
  })

  it('is never turned into a WSL target by revalidation', async () => {
    const validate = createTargetValidator(deps())
    await expect(revalidateRepositoryTarget({ kind: 'local' }, validate)).resolves.toBeNull()
  })

})

describe('accepted WSL targets', () => {
  it('returns the proven target, filling the registration id when it was absent', async () => {
    const validate = createTargetValidator(deps())
    await expect(validate({ kind: 'wsl', distro: 'Ubuntu-26.04', distroId: null })).resolves.toEqual(
      { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: UBUNTU_ID }
    )
  })

  it('reports the registry spelling when the caller used different casing', async () => {
    const validate = createTargetValidator(deps())
    const canonical = await validate({ kind: 'wsl', distro: 'ubuntu-26.04', distroId: UBUNTU_ID })
    expect(canonical).toEqual({ kind: 'wsl', distro: 'Ubuntu-26.04', distroId: UBUNTU_ID })
  })

  it('keeps the target usable for launch revalidation', async () => {
    const validate = createTargetValidator(deps())
    const target = await revalidateRepositoryTarget(
      { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: UBUNTU_ID },
      validate
    )
    expect(target).toEqual({ kind: 'wsl', distro: 'Ubuntu-26.04', distroId: UBUNTU_ID })
  })
})

describe('rejected WSL targets', () => {
  it('names the missing distro and never falls back to local', async () => {
    const error = await rejection(
      createTargetValidator(deps())({ kind: 'wsl', distro: 'Ubuntu-99.99', distroId: null })
    )
    expect(error.appError.code).toBe('WSL_DISTRO_NOT_FOUND')
    expect(error.appError.message).toContain('Ubuntu-99.99')
    expect(error.appError.retryable).toBe(false)
    // The error itself carries the app error, which is what the IPC dispatcher
    // forwards; there is no message parsing anywhere on this path.
    expect(error.appError.message).toContain('gone')
  })

  it('rejects a replaced registration instead of adopting the same name', async () => {
    const error = await rejection(
      createTargetValidator(deps())({ kind: 'wsl', distro: 'Ubuntu-26.04', distroId: OTHER_ID })
    )
    expect(error.appError.code).toBe('WSL_DISTRO_NOT_FOUND')
    expect(error.appError.detail).toContain(OTHER_ID)
    expect(error.appError.detail).toContain(UBUNTU_ID)
  })

  it('rejects WSL 1 with the conversion remedy', async () => {
    const error = await rejection(
      createTargetValidator(deps())({ kind: 'wsl', distro: 'Legacy-Distro', distroId: null })
    )
    expect(error.appError.code).toBe('WSL_DISTRO_NOT_FOUND')
    expect(error.appError.detail).toContain('--set-version')
  })

  it('reports WSL unavailability as a retryable failure, not a missing distro', async () => {
    const error = await rejection(
      createTargetValidator(deps({ registry: null }))({
        kind: 'wsl',
        distro: 'Ubuntu-26.04',
        distroId: null
      })
    )
    expect(error.appError.code).toBe('WSL_UNAVAILABLE')
    expect(error.appError.retryable).toBe(true)
  })

  it('rejects every distro when the machine is not Windows', async () => {
    const validate = createTargetValidator({
      runner: new WslCommandRunner({
        launcher: async () => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false }),
        platform: 'linux'
      }),
      platform: 'linux',
      queryRegistry: async () => REGISTRY
    })
    const error = await rejection(validate({ kind: 'wsl', distro: 'Ubuntu-26.04', distroId: null }))
    expect(error.appError.code).toBe('WSL_UNAVAILABLE')
  })
})

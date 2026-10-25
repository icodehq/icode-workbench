import { describe, expect, it } from 'vitest'
import type { WslExecOutcome, WslProcessLauncher } from './exec'
import { WslCommandRunner } from './exec'
import type { WslDistroDiscovery } from './distros'
import {
  validateWslTarget,
  validateWslTargetAgainst,
  wslTargetProblemToAppError,
  type WslTargetValidation
} from './target-validation'

const UBUNTU_ID = 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
const REPLACED_ID = 'ffffffff-1111-2222-3333-444455556666'

const DISCOVERED: WslDistroDiscovery = {
  status: 'ok',
  defaultRegistrationId: UBUNTU_ID,
  distros: [
    { name: 'Ubuntu 24.04 LTS', registrationId: 'cccccccc-1111-2222-3333-444455556666', version: 1, running: false },
    { name: 'Ubuntu-26.04', registrationId: UBUNTU_ID, version: 2, running: true }
  ]
}

function expectProblem(validation: WslTargetValidation) {
  if (validation.ok) throw new Error('expected a problem')
  return validation.problem
}

describe('target validation against a discovered list', () => {
  it('accepts a WSL 2 distro whose registration id still matches', () => {
    const validation = validateWslTargetAgainst(
      { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: UBUNTU_ID },
      DISCOVERED
    )
    expect(validation.ok).toBe(true)
    if (validation.ok) {
      expect(validation.target.distroId).toBe(UBUNTU_ID)
      expect(validation.distro.running).toBe(true)
    }
  })

  it('accepts a distro matched case-insensitively and reports the registry spelling', () => {
    const validation = validateWslTargetAgainst(
      { kind: 'wsl', distro: 'ubuntu-26.04', distroId: UBUNTU_ID },
      DISCOVERED
    )
    expect(validation.ok).toBe(true)
    if (validation.ok) expect(validation.target.distro).toBe('Ubuntu-26.04')
  })

  it('accepts a name with spaces', () => {
    const validation = validateWslTargetAgainst(
      { kind: 'wsl', distro: 'Ubuntu 24.04 LTS', distroId: null },
      DISCOVERED
    )
    // Valid by name only, but WSL 1 is refused separately.
    expect(expectProblem(validation).kind).toBe('unsupported_wsl1')
  })

  it('rejects a distro that no longer exists and lists what does', () => {
    const problem = expectProblem(
      validateWslTargetAgainst({ kind: 'wsl', distro: 'Ubuntu-22.04', distroId: null }, DISCOVERED)
    )
    expect(problem.kind).toBe('distro_not_found')
    if (problem.kind === 'distro_not_found') {
      expect(problem.available).toEqual(['Ubuntu 24.04 LTS', 'Ubuntu-26.04'])
    }
  })

  it('rejects a name that now belongs to a different registration', () => {
    const problem = expectProblem(
      validateWslTargetAgainst({ kind: 'wsl', distro: 'Ubuntu-26.04', distroId: REPLACED_ID }, DISCOVERED)
    )
    expect(problem.kind).toBe('registration_replaced')
    if (problem.kind === 'registration_replaced') {
      expect(problem.expected).toBe(REPLACED_ID)
      expect(problem.actual).toBe(UBUNTU_ID)
    }
  })

  it('accepts a registration-id-less target by name, the documented weaker match', () => {
    const validation = validateWslTargetAgainst(
      { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: null },
      DISCOVERED
    )
    expect(validation.ok).toBe(true)
    // The stored target still gains the id it can now prove.
    if (validation.ok) expect(validation.target.distroId).toBe(UBUNTU_ID)
  })

  it('refuses a local target', () => {
    expect(expectProblem(validateWslTargetAgainst({ kind: 'local' }, DISCOVERED)).kind).toBe(
      'not_wsl_target'
    )
  })

  it('reports WSL unavailability without pretending the distro is missing', () => {
    const problem = expectProblem(
      validateWslTargetAgainst(
        { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: null },
        { status: 'unavailable', reason: 'registry_unreadable', detail: 'nope' }
      )
    )
    expect(problem.kind).toBe('wsl_unavailable')
  })
})

describe('target validation end to end', () => {
  it('discovers then validates through the runner', async () => {
    const launcher: WslProcessLauncher = async () => ({
      code: 0,
      signal: null,
      stdout: 'Ubuntu-26.04\n',
      stderr: '',
      timedOut: false
    })
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    const validation = await validateWslTarget(
      { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: null },
      {
        runner,
        platform: 'win32',
        queryRegistry: async () =>
          [
            'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\' + `{${UBUNTU_ID}}`,
            '    DistributionName    REG_SZ    Ubuntu-26.04',
            '    Version    REG_DWORD    0x2'
          ].join('\r\n')
      }
    )
    expect(validation.ok).toBe(true)
  })

  it('does not throw when the registry is unreadable', async () => {
    const outcome: WslExecOutcome = { status: 'ok', stdout: '', stderr: '' }
    const launcher: WslProcessLauncher = async () => ({
      code: 0,
      signal: null,
      stdout: outcome.status === 'ok' ? outcome.stdout : '',
      stderr: '',
      timedOut: false
    })
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    const validation = await validateWslTarget(
      { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: null },
      { runner, platform: 'win32', queryRegistry: async () => null }
    )
    expect(validation.ok).toBe(false)
  })
})

describe('problem to app error mapping', () => {
  it('gives each problem its own code and remedy text', () => {
    expect(wslTargetProblemToAppError({ kind: 'not_wsl_target' }).code).toBe('INVALID_ARGUMENT')
    expect(
      wslTargetProblemToAppError({ kind: 'wsl_unavailable', detail: 'no registry' }).code
    ).toBe('WSL_UNAVAILABLE')
    expect(
      wslTargetProblemToAppError({ kind: 'distro_not_found', distro: 'X', available: ['Y'] }).code
    ).toBe('WSL_DISTRO_NOT_FOUND')
    expect(
      wslTargetProblemToAppError({
        kind: 'registration_replaced',
        distro: 'X',
        expected: 'a',
        actual: 'b'
      }).code
    ).toBe('WSL_DISTRO_NOT_FOUND')
    expect(
      wslTargetProblemToAppError({ kind: 'unsupported_wsl1', distro: 'X' }).detail
    ).toContain('--set-version')
  })

  it('marks only the transient failures as retryable', () => {
    expect(wslTargetProblemToAppError({ kind: 'wsl_unavailable', detail: '' }).retryable).toBe(true)
    expect(
      wslTargetProblemToAppError({ kind: 'distro_not_found', distro: 'X', available: [] }).retryable
    ).toBe(false)
  })
})

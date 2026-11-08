import { describe, expect, it } from 'vitest'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import { makeAppError } from '../../../shared/domain/errors'
import type { WslProcessLauncher } from '../exec'
import { WslCommandRunner } from '../exec'
import { RepositoryTargetError } from '../repository-target'
import { buildFingerprint, type DeployOutcome, type HostArtifactManifest } from './deploy'
import type { GuestHostIdentityRead } from './guest-identity'
import type { GuestHostStore } from './guest-store'
import type { HolderEnsureOutcome, HolderReleaseOutcome, WslHolder } from './holder'
import { WslHostLifecycle, readGuestHome, type WslHostLifecycleDeps } from './lifecycle'
import type { WslGuestHostRecord } from './records'

const DISTRO = 'Ubuntu-26.04'
const ID = 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
const BOOT = 'fde34a6a-a6bf-46a0-8563-9a249cd0f8ad'
const BOOT_2 = '00000000-1111-2222-3333-444455556666'
const WSL_TARGET: ExecutionTarget = { kind: 'wsl', distro: DISTRO, distroId: ID }

const MANIFEST: HostArtifactManifest = {
  artifactVersion: 'v-test',
  architecture: 'x64',
  glibcBaseline: '2.35',
  node: { version: 'v24.21.0', sha256: 'a'.repeat(64) },
  native: { package: 'node-pty', version: '1.1.0', sha256: 'b'.repeat(64) },
  host: { bundle: 'host/index.js', sha256: 'c'.repeat(64) },
  files: { 'host/index.js': 'c'.repeat(64) }
}
const FINGERPRINT = buildFingerprint(MANIFEST)
const ENTRY = '/home/u/.icode/host/scope/v-test/host/index.js'

function identity(overrides: Partial<{
  distroInstance: string
  hostPid: number | null
  hostStartTicks: string | null
  hostCommandLine: string | null
  /** A pid file left behind by a process that no longer exists. */
  pidFileStale: boolean
  meta: { pid: number; startedAt: number; protocolVersion: number; hostVersion: string; socket: string } | null
}> = {}): GuestHostIdentityRead {
  const hostPid = overrides.hostPid === undefined ? null : overrides.hostPid
  return {
    status: 'ok',
    identity: {
      bootId: BOOT,
      initTicks: '145',
      distroInstance: overrides.distroInstance ?? `${BOOT}:145`,
      hostPid,
      hostStartTicks:
        overrides.pidFileStale === true
          ? null
          : (overrides.hostStartTicks ?? (hostPid === null ? null : '52397645')),
      hostCommandLine:
        overrides.pidFileStale === true
          ? null
          : (overrides.hostCommandLine ??
            (hostPid === null ? null : `/home/u/.icode/host/scope/v-test/node/bin/node ${ENTRY}`)),
      meta:
        overrides.meta === undefined
          ? hostPid === null
            ? null
            : {
                pid: hostPid,
                startedAt: 1,
                protocolVersion: 1,
                hostVersion: '0.1.0-icode1',
                socket: '/home/u/.icode/host/scope/v-test/run/host.sock'
              }
          : overrides.meta
    }
  }
}

function memoryStore(initial: WslGuestHostRecord | null = null) {
  let record = initial
  const store: GuestHostStore & { current: () => WslGuestHostRecord | null; writes: number } = {
    read: () => record,
    write: (next) => {
      record = next
      store.writes += 1
    },
    remove: () => {
      record = null
    },
    current: () => record,
    writes: 0
  }
  return store
}

const LIVE_HOLDER: HolderEnsureOutcome = {
  outcome: 'adopted',
  record: {
    version: 1,
    distro: DISTRO,
    distroId: ID,
    windowsPid: 4242,
    creationTimeMs: 1,
    startedAtMs: 1
  },
  state: 'live',
  reason: 'verified'
}

type HarnessOptions = {
  identities?: GuestHostIdentityRead[]
  holderEnsure?: HolderEnsureOutcome
  holderRelease?: HolderReleaseOutcome
  deploy?: DeployOutcome
  stored?: WslGuestHostRecord | null
  validate?: (target: ExecutionTarget) => Promise<ExecutionTarget>
  launchExit?: 'ok' | 'exit3'
  killResult?: boolean
  aliveResults?: Array<boolean | null>
  signal?: AbortSignal
}

function harness(options: HarnessOptions = {}) {
  const identities = [...(options.identities ?? [identity()])]
  const store = memoryStore(options.stored ?? null)
  const launches: string[][] = []
  const killed: number[] = []

  const launcher: WslProcessLauncher = async (spec): Promise<WslProcessOutcome> => {
    const guest = spec.args.slice(spec.args.indexOf('--exec') + 1)
    launches.push([...guest])
    if (guest.includes('icode-start') && options.launchExit === 'exit3') {
      return { code: 3, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
  }
  type WslProcessOutcome = Awaited<ReturnType<WslProcessLauncher>>

  const holder: WslHolder = {
    ensure: async () => options.holderEnsure ?? LIVE_HOLDER,
    state: async () => ({ state: 'live', record: null }),
    release: async () => options.holderRelease ?? { outcome: 'released', previous: 'live' }
  }

  let aliveIndex = 0
  const deps: WslHostLifecycleDeps = {
    runner: new WslCommandRunner({ launcher, platform: 'win32' }),
    validateTarget: options.validate ?? (async (target) => target),
    holder,
    store,
    artifactRoot: '/artifacts',
    manifest: MANIFEST,
    hostRoot: '/home/u/.icode/host/scope',
    now: (() => {
      let t = 1_000
      return () => (t += 500)
    })(),
    sleep: async () => {},
    readIdentity: async () => identities.shift() ?? identity(),
    deploy: async () => options.deploy ?? { status: 'deployed', paths: {} as never, fingerprint: FINGERPRINT, uploaded: 1, reused: false },
    killGuest: async (_distro, pid) => {
      killed.push(pid)
      return options.killResult ?? true
    },
    guestAlive: async () => {
      if (!options.aliveResults) return false
      // `null` must survive: "could not ask" is not "gone".
      const value = options.aliveResults[Math.min(aliveIndex, options.aliveResults.length - 1)]
      aliveIndex += 1
      return value === undefined ? null : value
    },
    ...(options.signal ? { signal: options.signal } : {})
  }

  return {
    lifecycle: new WslHostLifecycle(deps),
    store,
    launches,
    killed,
    deps
  }
}

const RECORD: WslGuestHostRecord = {
  version: 1,
  distroId: ID,
  distroInstance: `${BOOT}:145`,
  pid: 991,
  startTicks: '52397645',
  hostDir: '/home/u/.icode/host/scope/v-test',
  socket: '/home/u/.icode/host/scope/v-test/run/host.sock',
  protocolVersion: 1,
  hostVersion: '0.1.0-icode1',
  buildFingerprint: FINGERPRINT,
  artifactVersion: 'v-test',
  recordedAtMs: 1
}

describe('local targets stay local', () => {
  it('reports not_wsl without touching the holder or the guest', async () => {
    const h = harness()
    await expect(h.lifecycle.ensure({ kind: 'local' })).resolves.toEqual({ status: 'not_wsl' })
    expect(h.launches).toHaveLength(0)
  })

  it('reports not_wsl on stop as well', async () => {
    const h = harness()
    await expect(h.lifecycle.stop({ kind: 'local' })).resolves.toEqual({ status: 'not_wsl' })
  })
})

describe('target revalidation', () => {
  it('surfaces the W57 rejection and never reaches the holder', async () => {
    const h = harness({
      validate: async () => {
        throw new RepositoryTargetError(
          makeAppError('WSL_DISTRO_NOT_FOUND', 'The WSL distro "Ubuntu-26.04" is gone.')
        )
      }
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(outcome.error.code).toBe('WSL_DISTRO_NOT_FOUND')
    expect(h.launches).toHaveLength(0)
  })

  it('refuses a target that resolves without a registration id', async () => {
    const h = harness({
      validate: async () => ({ kind: 'wsl', distro: DISTRO, distroId: null })
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(outcome.error.code).toBe('WSL_HOST_UNVERIFIABLE')
  })
})

describe('holder outcomes', () => {
  it('refuses when the recorded holder cannot be classified', async () => {
    const h = harness({
      holderEnsure: {
        outcome: 'refused_unverifiable',
        record: { version: 1, distro: DISTRO, distroId: ID, windowsPid: 4242, creationTimeMs: null, startedAtMs: 1 },
        reason: 'evidence_unavailable'
      }
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('unverifiable')
    expect(h.launches).toHaveLength(0)
  })

  it('reports a holder spawn failure at its own stage', async () => {
    const h = harness({
      holderEnsure: {
        outcome: 'failed',
        error: makeAppError('WSL_HOST_START_FAILED', 'no holder')
      }
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.stage).toBe('holder')
  })
})

describe('adoption', () => {
  it('adopts a proven Host that matches the deployed build', async () => {
    const h = harness({ stored: RECORD, identities: [identity({ hostPid: 991 })] })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('ready')
    if (outcome.status === 'ready') {
      expect(outcome.adopted).toBe(true)
      expect(outcome.host.pid).toBe(991)
    }
    expect(h.launches).toHaveLength(0)
  })

  it('adopts a proven Host even when the record was lost, instead of restarting it', async () => {
    // Losing a record must not cost live sessions.
    const h = harness({ stored: null, identities: [identity({ hostPid: 991 })] })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('ready')
    if (outcome.status === 'ready') expect(outcome.adopted).toBe(true)
    expect(h.launches).toHaveLength(0)
    expect(h.store.current()?.pid).toBe(991)
  })

  it('rewrites a record that describes another boot, keeping the live Host', async () => {
    const otherBoot = { ...RECORD, distroInstance: `${BOOT_2}:999`, pid: 12345 }
    const h = harness({ stored: otherBoot, identities: [identity({ hostPid: 991 })] })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('ready')
    expect(h.store.current()?.distroInstance).toBe(`${BOOT}:145`)
    expect(h.launches).toHaveLength(0)
  })

  it('refuses to adopt a Host it cannot prove, and never kills or replaces it', async () => {
    const h = harness({
      identities: [
        identity({ hostPid: 991, hostCommandLine: '/usr/bin/node /somewhere/else/index.js' })
      ]
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('unverifiable')
    expect(h.killed).toEqual([])
    expect(h.launches).toHaveLength(0)
  })
})

describe('protocol and build mismatch', () => {
  it('replaces an incompatible Host it proved it owns', async () => {
    const h = harness({
      stored: RECORD,
      identities: [
        identity({ hostPid: 991, meta: { pid: 991, startedAt: 1, protocolVersion: 9, hostVersion: 'old', socket: '/s' } }),
        identity({ hostPid: 991, meta: { pid: 991, startedAt: 2, protocolVersion: 1, hostVersion: '0.1.0-icode1', socket: '/s' } }),
        identity({ hostPid: 991, meta: { pid: 991, startedAt: 2, protocolVersion: 1, hostVersion: '0.1.0-icode1', socket: '/s' } })
      ],
      aliveResults: [false]
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(h.killed).toEqual([991])
    expect(outcome.status).toBe('ready')
    if (outcome.status === 'ready') expect(outcome.adopted).toBe(false)
  })

  it('does not replace when the stop of the incumbent cannot be proven', async () => {
    const h = harness({
      stored: { ...RECORD, buildFingerprint: 'old-build:deadbeef' },
      identities: [identity({ hostPid: 991 })],
      aliveResults: [true]
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('protocol_mismatch')
    if (outcome.status === 'protocol_mismatch') {
      expect(outcome.error.code).toBe('WSL_HOST_PROTOCOL_MISMATCH')
    }
    // It was never replaced.
    expect(h.launches).toHaveLength(0)
  })

  it('rejects a freshly launched Host that speaks the wrong protocol', async () => {
    const h = harness({
      identities: [
        identity(),
        identity({
          hostPid: 991,
          meta: { pid: 991, startedAt: 1, protocolVersion: 9, hostVersion: 'x', socket: '/s' }
        })
      ],
      aliveResults: [false]
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('protocol_mismatch')
    expect(h.killed).toEqual([991])
  })
})

describe('deployment', () => {
  it('reports a deployment failure at its own stage', async () => {
    const h = harness({
      deploy: {
        status: 'invalid_artifacts',
        failure: { ok: false, kind: 'mismatch', path: 'host/index.js', expected: 'a', actual: 'b' },
        error: makeAppError('WSL_HOST_DEPLOY_FAILED', 'bad artifacts')
      }
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('deploy')
      expect(outcome.error.code).toBe('WSL_HOST_DEPLOY_FAILED')
    }
    expect(h.launches).toHaveLength(0)
  })

  it('does not launch when the distro becomes unavailable during deployment', async () => {
    const h = harness({
      deploy: {
        status: 'unavailable',
        reason: 'timed_out',
        error: makeAppError('WSL_HOST_DEPLOY_FAILED', 'x')
      }
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.error.code).toBe('WSL_UNAVAILABLE')
  })
})

describe('startup', () => {
  it('launches, proves the process, and records the identity from that one read', async () => {
    const h = harness({
      identities: [identity(), identity({ hostPid: 991 })],
      deploy: { status: 'deployed', paths: {} as never, fingerprint: FINGERPRINT, uploaded: 3, reused: false }
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('ready')
    if (outcome.status === 'ready') {
      expect(outcome.adopted).toBe(false)
      expect(outcome.host.pid).toBe(991)
      expect(outcome.host.distroInstance).toBe(`${BOOT}:145`)
      expect(outcome.host.startTicks).toBe('52397645')
      expect(outcome.host.buildFingerprint).toBe(FINGERPRINT)
    }
    expect(h.launches).toHaveLength(1)
    const launch = h.launches[0]!
    expect(launch).toContain(ENTRY)
  })

  it('bounds retries and never leaves an unbounded spawn loop', async () => {
    // Every read says "no Host": each attempt fails, and there are only two.
    const h = harness({ identities: [identity(), identity(), identity(), identity()] })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.stage).toBe('start')
    expect(h.launches).toHaveLength(2)
  })

  it('does not claim a process whose command line is another program', async () => {
    const h = harness({
      identities: [
        identity(),
        identity({ hostPid: 991, hostCommandLine: '/usr/bin/node /other/index.js' })
      ]
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('failed')
    expect(h.store.current()).toBeNull()
  })

  it('reports cancellation without a Host record', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness({ signal: controller.signal })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('cancelled')
    expect(h.launches).toHaveLength(0)
  })
})

describe('launch reporting is not liveness (measured on a real distro)', () => {
  it('adopts the Host when the launch exited non-zero but the process is running', async () => {
    // Measured: `setsid -f` returns before the pid file exists, so the launch
    // script exits 3 while the Host is fine. Retrying would spawn a duplicate.
    const h = harness({
      launchExit: 'exit3',
      identities: [identity(), identity({ hostPid: 991 })]
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('ready')
    if (outcome.status === 'ready') expect(outcome.host.pid).toBe(991)
    expect(h.launches).toHaveLength(1)
  })

  it('treats a pid file with no /proc entry as stale, not as an unproven process', async () => {
    // Measured: the Host's own cleanup removes meta and the socket but leaves the
    // pid file, so every read after a good stop still named a dead pid.
    const h = harness({
      identities: [identity({ hostPid: 991, pidFileStale: true }), identity({ hostPid: 991 })]
    })
    const outcome = await h.lifecycle.ensure(WSL_TARGET)
    expect(outcome.status).toBe('ready')
    // A stale file must not block the start, and must be removed first.
    expect(h.launches.filter((guest) => guest.includes('icode-rm-pid'))).toHaveLength(1)
    expect(h.launches.filter((guest) => guest.includes('icode-start'))).toHaveLength(1)
  })

  it('treats a stale pid file as already stopped and removes it', async () => {
    const h = harness({
      stored: RECORD,
      identities: [identity({ hostPid: 991, pidFileStale: true })]
    })
    const outcome = await h.lifecycle.stop(WSL_TARGET)
    expect(outcome).toEqual({ status: 'stopped', host: 'already_stopped', holder: 'released' })
    expect(h.killed).toEqual([])
    expect(h.launches[0]!.some((arg) => arg === 'icode-rm-pid')).toBe(true)
  })
})

describe('guest home', () => {
  it('reads $HOME from the distro and rejects a non-absolute answer', async () => {
    let stdout = '/home/u\n'
    const runner = new WslCommandRunner({
      launcher: async () => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false }),
      platform: 'win32'
    })
    const lifecycle = new WslHostLifecycle({
      runner,
      validateTarget: async (t) => t,
      holder: { ensure: async () => LIVE_HOLDER, state: async () => ({ state: 'live', record: null }), release: async () => ({ outcome: 'released', previous: 'exited' }) },
      store: memoryStore(null),
      artifactRoot: '/a',
      manifest: MANIFEST,
      hostRoot: '/home/u/.icode/host/scope'
    })
    await expect(lifecycle.guestHome(DISTRO)).resolves.toBe('/home/u')
    stdout = 'not-a-path\n'
    await expect(lifecycle.guestHome(DISTRO)).resolves.toBeNull()
  })
})

describe('shutdown', () => {
  it('stops a proven Host and releases the holder', async () => {
    const h = harness({
      stored: RECORD,
      identities: [identity({ hostPid: 991 })],
      aliveResults: [false]
    })
    const outcome = await h.lifecycle.stop(WSL_TARGET)
    expect(outcome).toEqual({ status: 'stopped', host: 'stopped', holder: 'released' })
    expect(h.killed).toEqual([991])
    expect(h.store.current()).toBeNull()
  })

  it('reports already_stopped when no Host pid is recorded', async () => {
    const h = harness({ stored: RECORD, identities: [identity()] })
    const outcome = await h.lifecycle.stop(WSL_TARGET)
    expect(outcome).toEqual({ status: 'stopped', host: 'already_stopped', holder: 'released' })
    expect(h.killed).toEqual([])
  })

  it('treats a reused pid as our Host being gone, and signals nothing', async () => {
    const h = harness({
      stored: RECORD,
      identities: [identity({ hostPid: 991, hostStartTicks: '999999' })]
    })
    const outcome = await h.lifecycle.stop(WSL_TARGET)
    expect(outcome.status).toBe('stopped')
    expect(h.killed).toEqual([])
  })

  it('refuses to signal a process it cannot prove', async () => {
    const h = harness({
      stored: RECORD,
      identities: [
        identity({ hostPid: 991, hostStartTicks: '52397645', hostCommandLine: '/usr/bin/node /other/index.js' })
      ]
    })
    const outcome = await h.lifecycle.stop(WSL_TARGET)
    expect(outcome.status).toBe('unverifiable')
    expect(h.killed).toEqual([])
  })

  it('reports still_running rather than claiming a stop it did not observe', async () => {
    const h = harness({
      stored: RECORD,
      identities: [identity({ hostPid: 991 })],
      aliveResults: [true]
    })
    const outcome = await h.lifecycle.stop(WSL_TARGET)
    expect(outcome.status).toBe('still_running')
    if (outcome.status === 'still_running') expect(outcome.error.code).toBe('WSL_HOST_STOP_FAILED')
  })

  it('reports an unconfirmed stop when the guest cannot answer', async () => {
    const h = harness({
      stored: RECORD,
      identities: [identity({ hostPid: 991 })],
      aliveResults: [null]
    })
    const outcome = await h.lifecycle.stop(WSL_TARGET)
    expect(outcome.status).toBe('unverifiable')
  })

  it('surfaces a holder that would not release', async () => {
    const h = harness({
      stored: RECORD,
      identities: [identity({ hostPid: 991 })],
      aliveResults: [false],
      holderRelease: {
        outcome: 'still_running',
        record: { version: 1, distro: DISTRO, distroId: ID, windowsPid: 4242, creationTimeMs: 1, startedAtMs: 1 }
      }
    })
    const outcome = await h.lifecycle.stop(WSL_TARGET)
    expect(outcome).toEqual({ status: 'stopped', host: 'stopped', holder: 'still_running' })
  })

  it('reports unverifiable when the guest identity cannot be read', async () => {
    const h = harness({
      stored: RECORD,
      identities: [{ status: 'unavailable', reason: 'timed_out' }]
    })
    const outcome = await h.lifecycle.stop(WSL_TARGET)
    expect(outcome.status).toBe('unverifiable')
  })
})

/**
 * The worktree root depends on `$HOME`, so a stall here used to fail an entire
 * session launch. A stall is retried once; a malformed answer is not.
 */
describe('guest home probe', () => {
  function runner(outcomes: Array<{ status: 'ok'; stdout: string; stderr: string } | { status: 'timed_out' }>) {
    let calls = 0
    const queue = [...outcomes]
    return {
      calls: () => calls,
      runner: {
        run: async () => {
          calls += 1
          return queue.shift() ?? { status: 'timed_out' }
        }
      } as unknown as Parameters<typeof readGuestHome>[0]
    }
  }

  it('retries a timeout and returns the home directory', async () => {
    const { runner: fake, calls } = runner([
      { status: 'timed_out' },
      { status: 'ok', stdout: '/home/example\n', stderr: '' }
    ])
    await expect(readGuestHome(fake, 'Ubuntu-26.04')).resolves.toBe('/home/example')
    expect(calls()).toBe(2)
  })

  it('does not retry a malformed answer', async () => {
    const { runner: fake, calls } = runner([{ status: 'ok', stdout: 'not-a-path', stderr: '' }])
    await expect(readGuestHome(fake, 'Ubuntu-26.04')).resolves.toBeNull()
    expect(calls()).toBe(1)
  })

  it('gives up after two timeouts', async () => {
    const { runner: fake, calls } = runner([{ status: 'timed_out' }, { status: 'timed_out' }])
    await expect(readGuestHome(fake, 'Ubuntu-26.04')).resolves.toBeNull()
    expect(calls()).toBe(2)
  })
})

describe('guest home probe and the cold-start failure', () => {
  it('retries a WSL service failure (exit 255), not only a timeout', async () => {
    // Measured: the first call after idle exits 255 with Wsl/Service/WSAETIMEDOUT.
    let calls = 0
    const fake = {
      run: async () => {
        calls += 1
        return calls === 1
          ? {
              status: 'exit_failure' as const,
              code: 255,
              signal: null,
              stdout: '错误代码: Wsl/Service/WSAETIMEDOUT\r\n',
              stderr: ''
            }
          : { status: 'ok' as const, stdout: '/home/example', stderr: '' }
      }
    } as unknown as Parameters<typeof readGuestHome>[0]
    await expect(readGuestHome(fake, 'Ubuntu-26.04')).resolves.toBe('/home/example')
    expect(calls).toBe(2)
  })
})

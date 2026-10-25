import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { makeAppError } from '../../../shared/domain/errors'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import { WslCommandRunner } from '../exec'
import { buildFingerprint, deployPathsFor, type HostArtifactManifest } from '../host/deploy'
import type { WslHostLifecycle } from '../host/lifecycle'
import type { WslGuestHostRecord } from '../host/records'
import { RepositoryTargetError } from '../repository-target'
import type { BridgeChild } from './bridge'
import { BRIDGE_READY } from './bridge-protocol'
import {
  readHostToken,
  WslHostRelay,
  wslHostRoot,
  type WslRelayEndpoint
} from './endpoint'

const DISTRO = 'Ubuntu-26.04'
const ID = 'a5489bf0-2b9e-49bf-940e-0c19a6caef73'
const PROFILE_A = '/home/u/.config/ADE'
const PROFILE_B = '/home/u/.config/ADE-work'
const TOKEN = 'a'.repeat(64)
const MANIFEST: HostArtifactManifest = {
  artifactVersion: 'v-test',
  architecture: 'x64',
  glibcBaseline: '2.35',
  node: { version: 'v24.21.0', sha256: 'b'.repeat(64) },
  native: { package: 'node-pty', version: '1.1.0', sha256: 'c'.repeat(64) },
  host: { bundle: 'host/index.js', sha256: 'd'.repeat(64) },
  files: { 'host/index.js': 'd'.repeat(64) }
}
const TARGET: ExecutionTarget = { kind: 'wsl', distro: DISTRO, distroId: ID }

function recordFor(hostRoot: string): WslGuestHostRecord {
  const paths = deployPathsFor(hostRoot, MANIFEST.artifactVersion)
  return {
    version: 1,
    distroId: ID,
    distroInstance: 'fde34a6a-a6bf-46a0-8563-9a249cd0f8ad:145',
    pid: 991,
    startTicks: '52397645',
    hostDir: paths.root,
    socket: paths.socket,
    protocolVersion: 1,
    hostVersion: '0.1.0-work4',
    buildFingerprint: buildFingerprint(MANIFEST),
    artifactVersion: MANIFEST.artifactVersion,
    recordedAtMs: 1
  }
}

function fakeChild(): BridgeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdout.write(`${BRIDGE_READY}\n`)
  stdin.on('data', () => {})
  return {
    stdin,
    stdout,
    stderr,
    pid: 1234,
    kill: () => {
      stdin.end()
      stdout.end()
    },
    exited: new Promise(() => {})
  }
}

type Options = {
  ensure?: Awaited<ReturnType<WslHostLifecycle['ensure']>>
  token?: string | null
  home?: string | null
  validate?: (target: ExecutionTarget) => Promise<ExecutionTarget>
  probe?: (endpoint: WslRelayEndpoint) => Promise<void>
  profileDir?: string
}

function harness(options: Options = {}) {
  const roots: string[] = []
  const stops: string[] = []
  const lifecycle = {
    guestHome: async () => (options.home === undefined ? '/home/u' : options.home),
    ensure: async () => {
      const root = roots.at(-1) ?? wslHostRoot('/home/u', options.profileDir ?? PROFILE_A)
      return options.ensure ?? { status: 'ready', host: recordFor(root), adopted: false, holder: 'spawned', treeReused: true }
    },
    stop: async () => {
      stops.push(roots.at(-1) ?? '')
      return { status: 'stopped', host: 'stopped', holder: 'released' }
    }
  }

  const launcher = async (spec: { args: readonly string[] }) => {
    const args = [...spec.args]
    if (args.some((arg) => arg === 'ade-home')) {
      return {
        code: 0,
        signal: null,
        stdout: options.home === undefined ? '/home/u' : (options.home ?? ''),
        stderr: '',
        timedOut: false
      }
    }
    if (args.some((arg) => arg === 'ade-token')) {
      const token = options.token === undefined ? TOKEN : options.token
      return { code: token === null ? 1 : 0, signal: null, stdout: token ?? '', stderr: '', timedOut: false }
    }
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
  }

  const deps = {
    runner: new WslCommandRunner({ launcher, platform: 'win32' }),
    validateTarget: options.validate ?? (async (target: ExecutionTarget) => target),
    openLifecycle: (hostRoot: string) => {
      roots.push(hostRoot)
      return lifecycle as unknown as WslHostLifecycle
    },
    store: {
      read: () => null,
      write: () => {},
      remove: () => {}
    },
    artifactRoot: '/artifacts',
    manifest: MANIFEST,
    profileDir: options.profileDir ?? PROFILE_A,
    spawnBridge: () => fakeChild(),
    ...(options.probe ? { probe: options.probe } : { probe: async () => {} })
  }
  return { relay: new WslHostRelay(deps), roots, stops }
}

describe('target validation before any endpoint exists', () => {
  it('returns not_wsl for a local repository and opens no lifecycle', async () => {
    const h = harness()
    await expect(h.relay.start({ kind: 'local' })).resolves.toEqual({ status: 'not_wsl' })
    expect(h.roots).toHaveLength(0)
  })

  it('surfaces a replaced registration as a typed rejection', async () => {
    const h = harness({
      validate: async () => {
        throw new RepositoryTargetError(
          makeAppError('WSL_DISTRO_NOT_FOUND', 'The distro is a different installation.')
        )
      }
    })
    const outcome = await h.relay.start(TARGET)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(outcome.error.code).toBe('WSL_DISTRO_NOT_FOUND')
    expect(h.roots).toHaveLength(0)
  })

  it('refuses a target with no registration id', async () => {
    const h = harness({
      validate: async () => ({ kind: 'wsl', distro: DISTRO, distroId: null })
    })
    const outcome = await h.relay.start(TARGET)
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(outcome.error.code).toBe('WSL_HOST_UNVERIFIABLE')
  })

  it('fails without an endpoint when the guest home cannot be resolved', async () => {
    const h = harness({ home: null })
    const outcome = await h.relay.start(TARGET)
    expect(outcome.status).toBe('unavailable')
    expect(h.roots).toHaveLength(0)
  })
})

describe('profile scope', () => {
  it('derives a distinct Host root per profile on one distro', () => {
    const a = wslHostRoot('/home/u', PROFILE_A)
    const b = wslHostRoot('/home/u', PROFILE_B)
    expect(a).not.toBe(b)
    expect(a).toContain('/.ade/host/')
    expect(a.startsWith('/home/u')).toBe(true)
  })

  it('gives two profiles different sockets, so neither can reach the other Host', () => {
    const a = deployPathsFor(wslHostRoot('/home/u', PROFILE_A), MANIFEST.artifactVersion)
    const b = deployPathsFor(wslHostRoot('/home/u', PROFILE_B), MANIFEST.artifactVersion)
    expect(a.socket).not.toBe(b.socket)
    expect(a.root).not.toBe(b.root)
  })

  it('opens its lifecycle with the scoped root, not the profile directory', async () => {
    const h = harness()
    const outcome = await h.relay.start(TARGET)
    expect(outcome.status).toBe('ready')
    expect(h.roots).toHaveLength(1)
    expect(h.roots[0]).toBe(wslHostRoot('/home/u', PROFILE_A))
    expect(h.roots[0]).not.toContain(PROFILE_A)
  })

  it('reports the scope on the endpoint so a caller can compare profiles', async () => {
    const a = harness({ profileDir: PROFILE_A })
    const b = harness({ profileDir: PROFILE_B })
    const first = await a.relay.start(TARGET)
    const second = await b.relay.start(TARGET)
    if (first.status !== 'ready' || second.status !== 'ready') throw new Error('expected ready')
    expect(first.endpoint.profileScope).not.toBe(second.endpoint.profileScope)
    expect(first.endpoint.socketPath).not.toBe(second.endpoint.socketPath)
    await first.close()
    await second.close()
  })
})

describe('endpoint ownership', () => {
  it('refuses a record that names an endpoint outside this profile', async () => {
    const foreign = recordFor(wslHostRoot('/home/u', PROFILE_B))
    const h = harness({
      ensure: { status: 'ready', host: foreign, adopted: true, holder: 'adopted', treeReused: true }
    })
    const outcome = await h.relay.start(TARGET)
    expect(outcome.status).toBe('unverified')
    if (outcome.status === 'unverified') expect(outcome.detail).toBe('endpoint_not_owned')
  })

  it('refuses a record whose socket is not the one this scope deploys', async () => {
    const root = wslHostRoot('/home/u', PROFILE_A)
    const tampered = { ...recordFor(root), socket: '/tmp/somebody-elses.sock' }
    const h = harness({
      ensure: { status: 'ready', host: tampered, adopted: true, holder: 'adopted', treeReused: true }
    })
    expect((await h.relay.start(TARGET)).status).toBe('unverified')
  })

  it('refuses when the Host token cannot be read', async () => {
    const h = harness({ token: null })
    const outcome = await h.relay.start(TARGET)
    expect(outcome.status).toBe('unverified')
    if (outcome.status === 'unverified') expect(outcome.detail).toBe('token_unreadable')
  })
})

describe('proof of listening', () => {
  it('offers no endpoint when the handshake fails', async () => {
    // `meta.json` existing is not proof: only a completed handshake is.
    const h = harness({
      probe: async () => {
        throw new Error('handshake timed out')
      }
    })
    const outcome = await h.relay.start(TARGET)
    expect(outcome.status).toBe('unverified')
    if (outcome.status === 'unverified') {
      expect(outcome.error.code).toBe('WSL_HOST_PROTOCOL_MISMATCH')
      expect(outcome.error.detail).toContain('handshake')
    }
  })

  it('returns a loopback endpoint with a real port and the proven identity', async () => {
    const h = harness()
    const outcome = await h.relay.start(TARGET)
    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') return
    expect(outcome.endpoint.host).toBe('127.0.0.1')
    expect(outcome.endpoint.port).toBeGreaterThan(0)
    expect(outcome.endpoint.token).toBe(TOKEN)
    expect(outcome.endpoint.distroInstance).toContain(':145')
    expect(outcome.endpoint.hostPid).toBe(991)
    expect(outcome.endpoint.hostStartTicks).toBe('52397645')
    await outcome.close()
  })

  it('reflects a lifecycle that could not start a Host', async () => {
    const h = harness({
      ensure: {
        status: 'failed',
        stage: 'deploy',
        error: makeAppError('WSL_HOST_DEPLOY_FAILED', 'artifacts do not match'),
        pid: null
      }
    })
    const outcome = await h.relay.start(TARGET)
    expect(outcome.status).toBe('unavailable')
    if (outcome.status === 'unavailable') {
      expect(outcome.error.code).toBe('WSL_HOST_DEPLOY_FAILED')
      expect(outcome.detail).toBe('deploy')
    }
  })

  it('reports an unverifiable lifecycle refusal without spawning anything', async () => {
    const h = harness({
      ensure: {
        status: 'unverifiable',
        error: makeAppError('WSL_HOST_UNVERIFIABLE', 'unproven'),
        detail: 'guest_pid_unproven'
      }
    })
    const outcome = await h.relay.start(TARGET)
    expect(outcome.status).toBe('unavailable')
    if (outcome.status === 'unavailable') expect(outcome.error.code).toBe('WSL_HOST_UNVERIFIABLE')
  })
})

describe('Host persistence across client loss', () => {
  it('closing the endpoint never stops the Host', async () => {
    const h = harness()
    const outcome = await h.relay.start(TARGET)
    if (outcome.status !== 'ready') throw new Error('expected ready')
    await outcome.close()
    expect(h.stops).toEqual([])
  })

  it('only an explicit stop releases the Host', async () => {
    const h = harness()
    const outcome = await h.relay.start(TARGET)
    if (outcome.status !== 'ready') throw new Error('expected ready')
    await outcome.stop()
    expect(h.stops).toHaveLength(1)
  })

  it('reuses the Host on reconnect rather than starting another', async () => {
    const h = harness()
    const first = await h.relay.start(TARGET)
    const second = await h.relay.start(TARGET)
    if (first.status !== 'ready' || second.status !== 'ready') throw new Error('expected ready')
    expect(second.endpoint.hostPid).toBe(first.endpoint.hostPid)
    expect(second.endpoint.distroInstance).toBe(first.endpoint.distroInstance)
    // Reconnecting opened a second listener, but stopped nothing.
    expect(h.stops).toEqual([])
    await first.close()
    await second.close()
  })
})

describe('token location', () => {
  it('reads the token from ADE_HOST_DIR, which is the run directory', () => {
    // Measured the hard way: the Host writes to `<runDir>/token`, and looking in
    // the deployment root reported a healthy Host as unverified.
    const paths = deployPathsFor(wslHostRoot('/home/u', PROFILE_A), MANIFEST.artifactVersion)
    expect(paths.tokenPath).toBe(`${paths.runDir}/token`)
    expect(paths.tokenPath).not.toBe(`${paths.root}/token`)
  })

  it('reads the token from the path the lifecycle starts the Host with', async () => {
    const requested: string[] = []
    const runner = new WslCommandRunner({
      launcher: async (spec) => {
        const args = [...spec.args]
        const tokenIndex = args.indexOf('ade-token')
        if (tokenIndex !== -1) requested.push(args[tokenIndex + 1] ?? '')
        return { code: 0, signal: null, stdout: `${TOKEN}\n`, stderr: '', timedOut: false }
      },
      platform: 'win32'
    })
    const paths = deployPathsFor(wslHostRoot('/home/u', PROFILE_A), MANIFEST.artifactVersion)
    await readHostToken(runner, DISTRO, paths.runDir)
    expect(requested).toEqual([paths.tokenPath])
  })
})

describe('token read', () => {
  it('accepts a hex token', async () => {
    const runner = new WslCommandRunner({
      launcher: async () => ({ code: 0, signal: null, stdout: `${TOKEN}\n`, stderr: '', timedOut: false }),
      platform: 'win32'
    })
    await expect(readHostToken(runner, DISTRO, '/home/u/.ade/host/scope/v-test')).resolves.toBe(TOKEN)
  })

  it('rejects a token that is not plausibly one', async () => {
    const runner = new WslCommandRunner({
      launcher: async () => ({ code: 0, signal: null, stdout: 'not a token\n', stderr: '', timedOut: false }),
      platform: 'win32'
    })
    await expect(readHostToken(runner, DISTRO, '/x')).resolves.toBeNull()
  })

  it('rejects an empty token', async () => {
    const runner = new WslCommandRunner({
      launcher: async () => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false }),
      platform: 'win32'
    })
    await expect(readHostToken(runner, DISTRO, '/x')).resolves.toBeNull()
  })
})

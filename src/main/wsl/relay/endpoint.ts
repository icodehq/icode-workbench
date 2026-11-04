/**
 * The managed Host's Windows-side endpoint: one loopback listener per
 * (profile, repository target), and the validation that must pass before it exists.
 *
 * The order is the contract:
 *
 *   1. **Target** — W57's `revalidateRepositoryTarget`. A replaced registration
 *      fails here, before anything is spawned.
 *   2. **Scope** — the profile's `hostRoot` comes from the profile directory, so
 *      two profiles can never share a deployment, a socket, or a record store.
 *   3. **Lifecycle** — W58's `ensure` deploys, starts, adopts or refuses. Nothing
 *      about Host start/stop or ownership is reimplemented here.
 *   4. **Endpoint identity** — the socket the bridge will dial must be the one this
 *      scope deploys. An arbitrary path is never accepted.
 *   5. **Proof of listening** — a real handshake and `ping` through a real bridge.
 *      A `meta.json` says a process wrote a file; only a completed handshake says
 *      the Host is accepting connections.
 *
 * Client disconnects close a bridge and nothing else: `stop` is a separate,
 * explicit call, which is why losing a window cannot take a Host down.
 */

import type { AppError } from '../../../shared/domain/errors'
import { makeAppError } from '../../../shared/domain/errors'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import { profileSocketScope } from '../../../host/paths'
import type { WslCommandRunner } from '../exec'
import {
  RepositoryTargetError,
  revalidateRepositoryTarget,
  type TargetValidator
} from '../repository-target'
import { deployPathsFor, type HostArtifactManifest } from '../host/deploy'
import type { GuestHostStore } from '../host/guest-store'
import { readGuestHome, type WslHostLifecycle } from '../host/lifecycle'
import type { WslGuestHostRecord } from '../host/records'
import { spawnBridgeChild, type BridgeChild, type BridgeChildDeps } from './bridge'
import { startRelayListener, type RelayListener } from './listener'

/** `<guestHome>/.icode/host/<scope>`: the only place a profile's Host may live. */
export const WSL_HOST_ROOT_DIRNAME = '.icode/host'

export function wslHostRoot(guestHome: string, profileDir: string): string {
  return `${guestHome.replace(/\/+$/u, '')}/${WSL_HOST_ROOT_DIRNAME}/${profileSocketScope(profileDir)}`
}

export type WslRelayEndpoint = {
  /** Always loopback; peers off-machine are refused by the kernel. */
  host: string
  port: number
  token: string
  distro: string
  distroId: string
  /** Boot instance this endpoint's Host belongs to. */
  distroInstance: string
  hostPid: number
  hostStartTicks: string
  hostDir: string
  socketPath: string
  buildFingerprint: string
  profileScope: string
}

export type WslRelayStartOutcome =
  | { status: 'ready'; endpoint: WslRelayEndpoint; close(): Promise<void>; stop(): Promise<void> }
  /** The repository is local; the caller keeps its existing Host path untouched. */
  | { status: 'not_wsl' }
  | { status: 'rejected'; error: AppError }
  /** W4 could not produce a Host (deploy/start/holder). */
  | { status: 'unavailable'; error: AppError; detail: string }
  /** A Host record exists but the endpoint could not be proven, so none is offered. */
  | { status: 'unverified'; error: AppError; detail: string }

export type WslHostRelayDeps = {
  runner: WslCommandRunner
  validateTarget: TargetValidator
  /** One lifecycle per `hostRoot`, which is per profile. W4 owns it. */
  openLifecycle: (hostRoot: string) => WslHostLifecycle
  store: GuestHostStore
  artifactRoot: string
  manifest: HostArtifactManifest
  profileDir: string
  /** Test seam: a bridge child without a real `wsl.exe`. */
  spawnBridge?: (spec: { distro: string; nodePath: string; socketPath: string }) => BridgeChild
  bridgeChildDeps?: BridgeChildDeps
  /** Test seam: proves the endpoint. */
  probe?: (endpoint: WslRelayEndpoint) => Promise<void>
  listener?: { maxChannels?: number; queueTimeoutMs?: number; closeTimeoutMs?: number }
}

const TOKEN_READ_SCRIPT = 'cat "$1" 2>/dev/null'
const TOKEN_PATTERN = /^[0-9a-f]{32,128}$/iu

function unavailable(error: AppError, detail: string): WslRelayStartOutcome {
  return { status: 'unavailable', error, detail }
}

/**
 * Reads the Host token from the guest. It never leaves the machine — it is the
 * same secret the Host wrote to its own run directory — and it is read per start
 * so a restarted Host's rotated token is the one used.
 */
export async function readHostToken(
  runner: WslCommandRunner,
  distro: string,
  hostDir: string,
  options: { signal?: AbortSignal } = {}
): Promise<string | null> {
  const outcome = await runner.run({
    scope: 'guest',
    distro,
    argv: ['sh', '-c', TOKEN_READ_SCRIPT, 'icode-token', `${hostDir}/token`],
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (outcome.status !== 'ok') return null
  const token = outcome.stdout.trim()
  return TOKEN_PATTERN.test(token) ? token : null
}

export class WslHostRelay {
  constructor(private readonly deps: WslHostRelayDeps) {}

  /**
   * Whether this relay can actually open a bridge.
   *
   * A missing spawner is a composition bug, and offering an endpoint anyway is
   * worse than refusing: every connection would be accepted by the listener and
   * dropped milliseconds later, which reads as "the Host died". Measured exactly
   * that way during W7 integration.
   */
  private get canOpenBridges(): boolean {
    return this.deps.spawnBridge !== undefined || this.deps.bridgeChildDeps !== undefined
  }

  private defaultSpawn(spec: {
    distro: string
    nodePath: string
    socketPath: string
  }): BridgeChild {
    const childDeps = this.deps.bridgeChildDeps
    if (!childDeps) {
      throw new Error('A default bridge needs explicit child spawn parameters.')
    }
    return spawnBridgeChild(spec, childDeps)
  }

  private bridgeSpawner(): (spec: {
    distro: string
    nodePath: string
    socketPath: string
  }) => BridgeChild {
    return this.deps.spawnBridge ?? ((spec) => this.defaultSpawn(spec))
  }

  async start(target: ExecutionTarget, options: { signal?: AbortSignal } = {}): Promise<WslRelayStartOutcome> {
    if (!this.canOpenBridges) {
      return {
        status: 'unverified',
        error: makeAppError(
          'WSL_HOST_UNVERIFIABLE',
          'This build cannot open a bridge to the WSL Host.',
          { detail: 'The relay was constructed without bridge spawn parameters.' }
        ),
        detail: 'bridge_spawner_missing'
      }
    }
    let distro: string
    let distroId: string
    try {
      const wsl = await revalidateRepositoryTarget(target, this.deps.validateTarget)
      if (wsl === null) return { status: 'not_wsl' }
      if (wsl.distroId === null) {
        return {
          status: 'rejected',
          error: makeAppError(
            'WSL_HOST_UNVERIFIABLE',
            'That distro has no registration id, so its Host endpoint cannot be scoped.'
          )
        }
      }
      distro = wsl.distro
      distroId = wsl.distroId
    } catch (error) {
      if (error instanceof RepositoryTargetError) {
        return { status: 'rejected', error: error.appError }
      }
      throw error
    }

    const home = await readGuestHome(this.deps.runner, distro, options)
    if (home === null) {
      return unavailable(
        makeAppError('WSL_UNAVAILABLE', 'Could not resolve the guest home directory.'),
        'guest_home'
      )
    }

    // The scope is derived only from the profile directory, so two profiles on one
    // distro get different roots, sockets and record files.
    const hostRoot = wslHostRoot(home, this.deps.profileDir)
    const scoped = this.deps.openLifecycle(hostRoot)

    const ensured = await scoped.ensure(target)
    if (ensured.status === 'not_wsl') return { status: 'not_wsl' }
    if (ensured.status === 'rejected') return { status: 'rejected', error: ensured.error }
    if (ensured.status !== 'ready') {
      const detail = 'detail' in ensured ? ensured.detail : ensured.stage
      const error =
        'error' in ensured
          ? ensured.error
          : makeAppError('WSL_HOST_START_FAILED', 'The iCode Host is not ready.')
      return unavailable(error, detail)
    }

    const record: WslGuestHostRecord = ensured.host
    const paths = deployPathsFor(hostRoot, this.deps.manifest.artifactVersion)

    // The bridge may only dial what this scope deploys. A record naming any other
    // directory is refused rather than trusted.
    if (record.hostDir !== paths.root || record.socket !== paths.socket) {
      return {
        status: 'unverified',
        error: makeAppError(
          'WSL_HOST_UNVERIFIABLE',
          'The Host record names an endpoint this profile does not own.',
          { detail: `recorded ${record.hostDir}; expected ${paths.root}` }
        ),
        detail: 'endpoint_not_owned'
      }
    }

    // The token lives in `ICODE_HOST_DIR`, which is the run directory — not the
    // deployment root. Reading the wrong one made a healthy Host look unverified.
    const token = await readHostToken(this.deps.runner, distro, paths.runDir, options)
    if (token === null) {
      return {
        status: 'unverified',
        error: makeAppError('WSL_HOST_UNVERIFIABLE', 'The Host token could not be read.', {
          detail: paths.tokenPath
        }),
        detail: 'token_unreadable'
      }
    }

    const spawnBridge = this.bridgeSpawner()
    const listener: RelayListener = await startRelayListener(
      async () =>
        spawnBridge({
          distro,
          nodePath: paths.node,
          socketPath: record.socket
        }),
      {
        host: '127.0.0.1',
        port: 0,
        ...(this.deps.listener?.maxChannels !== undefined
          ? { maxChannels: this.deps.listener.maxChannels }
          : {}),
        ...(this.deps.listener?.queueTimeoutMs !== undefined
          ? { queueTimeoutMs: this.deps.listener.queueTimeoutMs }
          : {}),
        ...(this.deps.listener?.closeTimeoutMs !== undefined
          ? { closeTimeoutMs: this.deps.listener.closeTimeoutMs }
          : {})
      }
    )

    const endpoint: WslRelayEndpoint = {
      host: listener.host,
      port: listener.port,
      token,
      distro,
      distroId,
      distroInstance: record.distroInstance,
      hostPid: record.pid,
      hostStartTicks: record.startTicks,
      hostDir: record.hostDir,
      socketPath: record.socket,
      buildFingerprint: record.buildFingerprint,
      profileScope: profileSocketScope(this.deps.profileDir)
    }

    // Proof that the endpoint really reaches a Host: a handshake and a ping over a
    // real bridge. `meta.json` alone would only prove a file was written.
    try {
      if (this.deps.probe) await this.deps.probe(endpoint)
    } catch (error) {
      await listener.close()
      return {
        status: 'unverified',
        error: makeAppError(
          'WSL_HOST_PROTOCOL_MISMATCH',
          'The Host endpoint did not complete a handshake.',
          { detail: error instanceof Error ? error.message : String(error) }
        ),
        detail: 'probe_failed'
      }
    }

    return {
      status: 'ready',
      endpoint,
      close: () => listener.close(),
      // Deliberately separate from `close`: a window closing must never stop a Host.
      stop: async () => {
        await listener.close()
        await scoped.stop(target)
      }
    }
  }
}

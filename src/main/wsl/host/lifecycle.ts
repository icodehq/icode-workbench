/**
 * Ensuring, adopting and stopping one managed Host per WSL distro.
 *
 * The order of operations is the safety model, and it is deliberate:
 *
 *   1. Revalidate the persisted target (W57). A repository whose distro was
 *      replaced must fail here, before a holder is spawned or a byte uploaded.
 *   2. Ensure the Windows holder. It is the lifetime anchor; without it WSL may
 *      idle the distro out mid-deployment.
 *   3. Read the guest identity **once**: which boot, which Host process. A later
 *      read could describe a different boot.
 *   4. Adopt only what is provably ours in **this** boot and compatible with the
 *      deployed build. Everything else is either provably gone (start) or
 *      unprovable (refuse, and never kill).
 *   5. Deploy (idempotent by fingerprint), then launch through the guest's own
 *      `setsid`, and prove the new process by identity, not by exit code.
 *
 * Nothing here reaches a Windows process API with a Guest PID, and nothing kills
 * a process it cannot prove it owns.
 */

import type { AppError } from '../../../shared/domain/errors'
import { makeAppError } from '../../../shared/domain/errors'
import { HOST_PROTOCOL_VERSION } from '../../../shared/host-protocol'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import type { WslCommandRunner } from '../exec'
import { isTransportOutcome } from '../probe'
import {
  RepositoryTargetError,
  revalidateRepositoryTarget,
  type TargetValidator
} from '../repository-target'
import { deployHost, buildFingerprint, deployPathsFor, type DeployOutcome } from './deploy'
import type { HostArtifactManifest } from './deploy'
import {
  guestHostIsOurs,
  readGuestHostIdentity,
  type GuestHostIdentity,
  type GuestHostIdentityRead
} from './guest-identity'
import type { GuestHostStore } from './guest-store'
import type { WslHolder } from './holder'
import type { WslGuestHostRecord } from './records'

const START_POLL_MS = 200
const START_DEADLINE_MS = 20_000
const STOP_POLL_MS = 100
const STOP_DEADLINE_MS = 10_000
const DEFAULT_MAX_START_ATTEMPTS = 2

/** Constant scripts. Paths and pids arrive as argv and are always quoted. */
export const GUEST_START_SCRIPT = `umask 077
command -v setsid >/dev/null 2>&1 || exit 4
rm -f "$5"
: > "$6"
setsid -f sh -c 'echo $$ > "$1"; shift; exec "$@"' icode-host-launch "$5" env ICODE_HOST_DIR="$3" ICODE_HOST_SOCKET="$4" "$1" "$2" >> "$6" 2>&1 < /dev/null || exit 3
exit 0`

const GUEST_KILL_SCRIPT = 'kill -TERM "$1" 2>/dev/null || exit 1'
const GUEST_ALIVE_SCRIPT = 'kill -0 "$1" 2>/dev/null || exit 1'
const GUEST_HOME_SCRIPT = 'printf %s "$HOME"'

/**
 * Reads the guest's `$HOME`.
 *
 * Standalone so a caller that must derive a path *before* it can construct a
 * lifecycle (W5 derives `hostRoot` from it) does not need a throwaway instance —
 * and so there remains exactly one implementation of the probe.
 */
export async function readGuestHome(
  runner: WslCommandRunner,
  distro: string,
  options: { signal?: AbortSignal } = {}
): Promise<string | null> {
  const attempt = (): ReturnType<WslCommandRunner['run']> =>
    runner.run({
      scope: 'guest',
      label: 'guest-home',
      distro,
      argv: ['sh', '-c', GUEST_HOME_SCRIPT, 'icode-home'],
      ...(options.signal ? { signal: options.signal } : {})
    })

  /**
   * One retry, and only when the distro did not answer.
   *
   * This value decides the worktree root, so a transient stall used to fail a
   * whole session launch — reported as "the session process could not be started"
   * when in truth nothing had been attempted inside the guest. An answer of "no"
   * (a malformed `$HOME`) is not retried: asking again cannot change it.
   */
  let outcome = await attempt()
  // A cold distro answers the first call with `Wsl/Service/WSAETIMEDOUT` (exit
  // 255), not a timeout; either way it produced no answer and is asked again.
  if (isTransportOutcome(outcome) && !options.signal?.aborted) {
    outcome = await attempt()
  }
  if (outcome.status !== 'ok') {
    /**
     * Say *why*. This value decides the worktree root, so a bare `null` used to
     * surface as "the session process could not be started", which names neither
     * the guest nor the cause.
     */
    const reason =
      outcome.status === 'exit_failure'
        ? `exit ${String(outcome.code)}: ${`${outcome.stdout}${outcome.stderr}`.trim().slice(0, 200)}`
        : outcome.status
    process.stderr.write(`[icode] guest home probe failed in ${distro}: ${reason}\n`)
    return null
  }
  const home = outcome.stdout.trim()
  if (!home.startsWith('/')) {
    process.stderr.write(`[icode] guest home probe returned a non-path in ${distro}: ${home.slice(0, 120)}\n`)
    return null
  }
  return home
}

export type WslHostEnsureOutcome =
  | {
      status: 'ready'
      host: WslGuestHostRecord
      adopted: boolean
      holder: 'adopted' | 'spawned'
      /** True when the deployment marker proved the tree was already in place. */
      treeReused: boolean
    }
  /** The repository is local; the caller keeps its existing Host path untouched. */
  | { status: 'not_wsl' }
  | { status: 'rejected'; error: AppError }
  | { status: 'unverifiable'; error: AppError; detail: string }
  | { status: 'protocol_mismatch'; error: AppError; detail: string }
  | { status: 'cancelled'; detail: string }
  | {
      status: 'failed'
      stage: 'holder' | 'deploy' | 'start' | 'identity'
      error: AppError
      /** The Guest Host pid, when a launch produced one before failing. */
      pid: number | null
    }

export type WslHostStopOutcome =
  | {
      status: 'stopped'
      /** `stopped` when this call ended it; `already_stopped` when it was gone. */
      host: 'stopped' | 'already_stopped'
      holder: 'released' | 'still_running' | 'unverifiable'
    }
  | { status: 'still_running'; error: AppError; detail: string }
  | { status: 'unverifiable'; error: AppError; detail: string }
  | { status: 'not_wsl' }
  | { status: 'rejected'; error: AppError }
  | { status: 'cancelled'; detail: string }

export type WslHostLifecycleDeps = {
  runner: WslCommandRunner
  validateTarget: TargetValidator
  holder: WslHolder
  store: GuestHostStore
  artifactRoot: string
  manifest: HostArtifactManifest
  /**
   * Guest directory holding every build for this iCode profile. Scoped by the
   * caller so two profiles in one distro cannot adopt each other's Host.
   */
  hostRoot: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
  maxStartAttempts?: number
  /** Test seams. */
  deploy?: (deps: Parameters<typeof deployHost>[0]) => Promise<DeployOutcome>
  readIdentity?: typeof readGuestHostIdentity
  /** Injected so a test can model a guest-side kill without a distro. */
  killGuest?: (distro: string, pid: number, signal?: AbortSignal) => Promise<boolean>
  guestAlive?: (distro: string, pid: number, signal?: AbortSignal) => Promise<boolean | null>
}

function startError(detail: string): AppError {
  return makeAppError('WSL_HOST_START_FAILED', 'The iCode Host did not start inside the distro.', {
    detail
  })
}

function unverifiableError(detail: string): AppError {
  return makeAppError(
    'WSL_HOST_UNVERIFIABLE',
    'iCode cannot prove which process is running in that distro.',
    { detail }
  )
}

export class WslHostLifecycle {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly readIdentity: typeof readGuestHostIdentity
  private readonly deploy: (deps: Parameters<typeof deployHost>[0]) => Promise<DeployOutcome>
  private readonly killGuest: (distro: string, pid: number, signal?: AbortSignal) => Promise<boolean>
  private readonly guestAlive: (
    distro: string,
    pid: number,
    signal?: AbortSignal
  ) => Promise<boolean | null>

  constructor(private readonly deps: WslHostLifecycleDeps) {
    this.now = deps.now ?? Date.now
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.readIdentity = deps.readIdentity ?? readGuestHostIdentity
    this.deploy = deps.deploy ?? deployHost
    this.killGuest = deps.killGuest ?? ((distro, pid, signal) => this.defaultKill(distro, pid, signal))
    this.guestAlive =
      deps.guestAlive ?? ((distro, pid, signal) => this.defaultAlive(distro, pid, signal))
  }

  private get signal(): AbortSignal | undefined {
    return this.deps.signal
  }

  private async runGuest(distro: string, argv: readonly string[]) {
    return this.deps.runner.run({
      scope: 'guest',
      distro,
      argv,
      ...(this.signal ? { signal: this.signal } : {})
    })
  }

  /** Guest-side termination. A Guest PID travels to the guest, never to Windows. */
  private async defaultKill(distro: string, pid: number, signal?: AbortSignal): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    const outcome = await this.deps.runner.run({
      scope: 'guest',
      distro,
      argv: ['sh', '-c', GUEST_KILL_SCRIPT, 'icode-kill', String(pid)],
      ...(signal ? { signal } : {})
    })
    return outcome.status === 'ok'
  }

  /**
   * Guest-side liveness. `null` means the question could not be asked, which is
   * different from "gone".
   */
  /**
   * Removes a pid file whose process is gone. Guest-side and limited to a path
   * W4 owns: a stale pid file otherwise reports a dead Host as recorded forever.
   */
  private async clearPidFile(distro: string, pidFile: string): Promise<void> {
    await this.runGuest(distro, ['sh', '-c', 'rm -f "$1"', 'icode-rm-pid', pidFile])
  }

  private async defaultAlive(
    distro: string,
    pid: number,
    signal?: AbortSignal
  ): Promise<boolean | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    const outcome = await this.deps.runner.run({
      scope: 'guest',
      distro,
      argv: ['sh', '-c', GUEST_ALIVE_SCRIPT, 'icode-alive', String(pid)],
      ...(signal ? { signal } : {})
    })
    if (outcome.status === 'ok') return true
    if (outcome.status === 'exit_failure') return false
    return null
  }

  private cancelled(): boolean {
    return this.signal?.aborted === true
  }

  /**
   * Revalidates the target and resolves the paths. Every public entry point does
   * this first: a persisted target can outlive its registration, and a Host must
   * never be started against a distro that no longer exists.
   */
  private async resolve(
    target: ExecutionTarget
  ): Promise<
    | { ok: true; distro: string; distroId: string }
    | {
        ok: false
        outcome: Extract<WslHostEnsureOutcome, { status: 'not_wsl' | 'rejected' }>
      }
  > {
    try {
      const wsl = await revalidateRepositoryTarget(target, this.deps.validateTarget)
      if (wsl === null) return { ok: false, outcome: { status: 'not_wsl' } }
      // The validator always returns the registration it proved. A null id here
      // would mean "adoptable by name", which the model forbids, so it is refused
      // rather than silently downgraded.
      if (wsl.distroId === null) {
        return {
          ok: false,
          outcome: {
            status: 'rejected',
            error: makeAppError(
              'WSL_HOST_UNVERIFIABLE',
              'That distro has no registration id, so a Host cannot be scoped to it.'
            )
          }
        }
      }
      return { ok: true, distro: wsl.distro, distroId: wsl.distroId }
    } catch (error) {
      if (error instanceof RepositoryTargetError) {
        return { ok: false, outcome: { status: 'rejected', error: error.appError } }
      }
      throw error
    }
  }

  private async readOne(
    distro: string,
    paths: { pidFile: string; metaPath: string }
  ): Promise<GuestHostIdentityRead> {
    return this.readIdentity(this.deps.runner, distro, paths, {
      ...(this.signal ? { signal: this.signal } : {})
    })
  }

  async ensure(target: ExecutionTarget): Promise<WslHostEnsureOutcome> {
    const resolved = await this.resolve(target)
    if (!resolved.ok) return resolved.outcome
    const { distro, distroId } = resolved
    if (this.cancelled()) return { status: 'cancelled', detail: 'before holder' }

    const holder = await this.deps.holder.ensure(distro, distroId)
    if (holder.outcome === 'failed') {
      return { status: 'failed', stage: 'holder', error: holder.error, pid: null }
    }
    if (holder.outcome === 'refused_unverifiable') {
      return {
        status: 'unverifiable',
        error: unverifiableError(
          `The recorded WSL holder (Windows pid ${holder.record.windowsPid}) could not be classified: ${holder.reason}.`
        ),
        detail: holder.reason
      }
    }
    const holderOutcome = holder.outcome === 'adopted' ? 'adopted' : 'spawned'

    const paths = deployPathsFor(this.deps.hostRoot, this.deps.manifest.artifactVersion)
    const fingerprint = buildFingerprint(this.deps.manifest)

    const first = await this.readOne(distro, paths)
    if (first.status !== 'ok') {
      return {
        status: 'failed',
        stage: 'identity',
        error:
          first.status === 'unavailable'
            ? makeAppError('WSL_GUEST_PROBE_FAILED', 'Could not read the distro identity.', {
                detail: first.reason
              })
            : makeAppError('WSL_GUEST_PROBE_FAILED', 'The distro identity was not parseable.', {
                detail: first.detail
              }),
        pid: null
      }
    }

    const stored = this.deps.store.read(distroId)

    // A pid file outlives the process that wrote it. With no `/proc/<pid>/stat`
    // the file is stale — nothing is running under that pid — and treating it as
    // unproven would block every future start after a perfectly good stop.
    const pidFileStale =
      first.identity.hostPid !== null &&
      (first.identity.hostStartTicks === null || first.identity.hostCommandLine === null)

    if (
      first.identity.hostPid !== null &&
      !pidFileStale &&
      !guestHostIsOurs(first.identity, { entryPath: paths.entry })
    ) {
      // Something really is running under that pid and iCode cannot prove it started
      // it. Starting a second Host could collide on the socket, and killing is out
      // of the question, so the only honest answer is to refuse.
      return {
        status: 'unverifiable',
        error: unverifiableError(
          `Guest pid ${first.identity.hostPid} is recorded but its command line does not identify this iCode Host. iCode will not replace or stop it.`
        ),
        detail: 'guest_pid_unproven'
      }
    }

    if (guestHostIsOurs(first.identity, { entryPath: paths.entry })) {
      const meta = first.identity.meta
      const protocolOk = meta !== null && meta.protocolVersion === HOST_PROTOCOL_VERSION
      // A record is evidence, not a requirement: `buildOk` compares the deployed
      // build against the record when one exists, and trusts the versioned entry
      // path when it does not. Losing the record must not cost live sessions.
      const buildOk = stored === null || stored.buildFingerprint === fingerprint

      if (protocolOk && buildOk) {
        const identity = first.identity
        const record: WslGuestHostRecord = {
          version: 1,
          distroId,
          distroInstance: identity.distroInstance,
          pid: identity.hostPid!,
          startTicks: identity.hostStartTicks!,
          hostDir: paths.root,
          socket: meta.socket || paths.socket,
          protocolVersion: meta.protocolVersion,
          hostVersion: meta.hostVersion,
          buildFingerprint: stored?.buildFingerprint ?? fingerprint,
          artifactVersion: stored?.artifactVersion ?? this.deps.manifest.artifactVersion,
          recordedAtMs: this.now()
        }
        // Rewrite when the record was missing or described another boot: the
        // stored `distroInstance` is what later stops may rely on.
        if (
          stored === null ||
          stored.distroInstance !== identity.distroInstance ||
          stored.pid !== identity.hostPid ||
          stored.startTicks !== identity.hostStartTicks
        ) {
          this.deps.store.write(record)
        }
        return {
          status: 'ready',
          host: record,
          adopted: true,
          holder: holderOutcome,
          treeReused: true
        }
      }

      // An incumbent we own, but not the one we would run now (protocol or build).
      // Replace it only because the identity above proves it is ours.
      const previousPid = first.identity.hostPid
      const stopped = await this.stopProvenPid(distro, previousPid)
      if (stopped !== 'stopped') {
        return {
          status: 'protocol_mismatch',
          error: makeAppError(
            'WSL_HOST_PROTOCOL_MISMATCH',
            'An incompatible iCode Host is running and iCode could not stop it.',
            { detail: `guest pid ${previousPid}: ${stopped}` }
          ),
          detail: stopped
        }
      }
      this.deps.store.remove(distroId)
    } else {
      // No Host, or a pid file whose process is gone. Either way the record cannot
      // describe a live process in this boot, and the file must not survive to
      // mislead the next read.
      if (pidFileStale) await this.clearPidFile(distro, paths.pidFile)
      this.deps.store.remove(distroId)
    }

    if (this.cancelled()) return { status: 'cancelled', detail: 'before deploy' }

    const deployment = await this.deploy({
      runner: this.deps.runner,
      distro,
      artifactRoot: this.deps.artifactRoot,
      hostRoot: this.deps.hostRoot,
      manifest: this.deps.manifest,
      ...(this.signal ? { signal: this.signal } : {})
    })
    if (deployment.status !== 'deployed') {
      if (deployment.status === 'unavailable') {
        return {
          status: 'failed',
          stage: 'deploy',
          error: makeAppError('WSL_UNAVAILABLE', 'WSL became unavailable during deployment.', {
            detail: deployment.reason
          }),
          pid: null
        }
      }
      return { status: 'failed', stage: 'deploy', error: deployment.error, pid: null }
    }

    if (this.cancelled()) return { status: 'cancelled', detail: 'before start' }

    return this.startAndRecord({
      distro,
      distroId,
      paths,
      fingerprint,
      holder: holderOutcome,
      treeReused: deployment.reused
    })
  }

  private async startAndRecord(input: {
    distro: string
    distroId: string
    paths: ReturnType<typeof deployPathsFor>
    fingerprint: string
    holder: 'adopted' | 'spawned'
    treeReused: boolean
  }): Promise<WslHostEnsureOutcome> {
    const attempts = this.deps.maxStartAttempts ?? DEFAULT_MAX_START_ATTEMPTS
    let lastDetail = 'no attempt was made'

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.cancelled()) return { status: 'cancelled', detail: 'before launch' }

      // Wipe the pid file first: a launch that dies before writing its pid must
      // not leave the previous attempt's pid looking current.
      const launch = await this.runGuest(input.distro, [
        'sh',
        '-c',
        GUEST_START_SCRIPT,
        'icode-start',
        input.paths.node,
        input.paths.entry,
        input.paths.runDir,
        input.paths.socket,
        input.paths.pidFile,
        input.paths.logPath
      ])
      // The launch's exit code is *not* proof either way: `setsid -f` returns
      // before the pid file exists, and a launch can be reported failed while the
      // Host is running. Identity decides, and nothing is spawned twice.
      const identity = await this.awaitHost(input.distro, input.paths)
      if (identity.status !== 'ok') {
        lastDetail =
          identity.status === 'unavailable' ? identity.reason : 'the Host identity was unparseable'
        if (launch.status !== 'ok') lastDetail = `${lastDetail} (launch ${launch.status})`
        continue
      }
      const running = identity.identity
      if (!guestHostIsOurs(running, { entryPath: input.paths.entry })) {
        lastDetail = this.startedButUnproven(input, running)
        if (launch.status === 'exit_failure') {
          lastDetail += `; launch exited ${String(launch.code)}${
            launch.code === 4 ? ' (setsid is missing in this distro)' : ''
          }`
        }
        continue
      }
      if (running.meta === null) {
        // The Host writes meta.json before it listens; without it, startup did not
        // reach the point where a client could ever connect.
        lastDetail = 'the Host process exists but wrote no meta.json'
        await this.stopProvenPid(input.distro, running.hostPid)
        continue
      }
      if (running.meta.protocolVersion !== HOST_PROTOCOL_VERSION) {
        // We launched this process ourselves, so it is ours to stop; the mismatch
        // is a build problem, not an adoption question.
        await this.stopProvenPid(input.distro, running.hostPid)
        return {
          status: 'protocol_mismatch',
          error: makeAppError(
            'WSL_HOST_PROTOCOL_MISMATCH',
            'The deployed Host speaks a different protocol than this iCode build.',
            {
              detail: `deployed ${running.meta.protocolVersion}, expected ${HOST_PROTOCOL_VERSION}`
            }
          ),
          detail: 'launched_host_protocol'
        }
      }

      const record: WslGuestHostRecord = {
        version: 1,
        distroId: input.distroId,
        distroInstance: running.distroInstance,
        pid: running.hostPid,
        startTicks: running.hostStartTicks!,
        hostDir: input.paths.root,
        socket: running.meta.socket || input.paths.socket,
        protocolVersion: running.meta.protocolVersion,
        hostVersion: running.meta.hostVersion,
        buildFingerprint: input.fingerprint,
        artifactVersion: this.deps.manifest.artifactVersion,
        recordedAtMs: this.now()
      }
      this.deps.store.write(record)
      return {
        status: 'ready',
        host: record,
        adopted: false,
        holder: input.holder,
        treeReused: input.treeReused
      }
    }

    return {
      status: 'failed',
      stage: 'start',
      error: startError(lastDetail),
      pid: null
    }
  }

  /** Explains why a launched process cannot be claimed, without claiming it. */
  private startedButUnproven(
    input: { distro: string; paths: ReturnType<typeof deployPathsFor> },
    identity: GuestHostIdentity
  ): string {
    if (identity.hostPid === null) return 'no pid was recorded'
    if (identity.hostCommandLine === null) return `pid ${identity.hostPid} has no command line`
    if (!identity.hostCommandLine.includes(input.paths.entry)) {
      return `pid ${identity.hostPid} runs a different entry: ${identity.hostCommandLine.slice(0, 160)}`
    }
    return 'the Host process could not be confirmed'
  }

  /**
   * Polls the atomic identity read until the Host *proves itself* — ownership,
   * not merely a pid file — or time runs out.
   */
  private async awaitHost(
    distro: string,
    paths: ReturnType<typeof deployPathsFor>
  ): Promise<GuestHostIdentityRead> {
    const deadline = this.now() + START_DEADLINE_MS
    let last: GuestHostIdentityRead = { status: 'unavailable', reason: 'exit_failure' }
    while (this.now() < deadline) {
      if (this.cancelled()) return last
      last = await this.readOne(distro, paths)
      if (last.status === 'ok' && guestHostIsOurs(last.identity, { entryPath: paths.entry })) {
        return last
      }
      await this.sleep(START_POLL_MS)
    }
    return last
  }

  /**
   * Stops a Guest Host whose identity this call has already proven.
   * Guest-side signal, bounded wait, and a typed answer.
   */
  private async stopProvenPid(
    distro: string,
    pid: number
  ): Promise<'stopped' | 'still_running' | 'unverifiable'> {
    const killed = await this.killGuest(distro, pid, this.signal)
    if (!killed) return 'unverifiable'
    const deadline = this.now() + STOP_DEADLINE_MS
    while (this.now() < deadline) {
      const alive = await this.guestAlive(distro, pid, this.signal)
      if (alive === false) return 'stopped'
      if (alive === null) return 'unverifiable'
      await this.sleep(STOP_POLL_MS)
    }
    return 'still_running'
  }

  async stop(target: ExecutionTarget): Promise<WslHostStopOutcome> {
    const resolved = await this.resolve(target)
    if (!resolved.ok) {
      if (resolved.outcome.status === 'not_wsl') return { status: 'not_wsl' }
      return { status: 'rejected', error: resolved.outcome.error }
    }
    const { distro, distroId } = resolved

    const stored = this.deps.store.read(distroId)
    const paths = stored
      ? deployPathsFor(this.deps.hostRoot, stored.artifactVersion)
      : deployPathsFor(this.deps.hostRoot, this.deps.manifest.artifactVersion)

    const current = await this.readOne(distro, paths)
    if (current.status !== 'ok') {
      return {
        status: 'unverifiable',
        error: unverifiableError(
          current.status === 'unavailable'
            ? `the guest did not answer: ${current.reason}`
            : 'the guest identity was not parseable'
        ),
        detail: current.status
      }
    }

    const identity = current.identity
    let hostOutcome: 'stopped' | 'already_stopped' = 'already_stopped'

    if (identity.hostPid !== null) {
      const pidFileStale =
        identity.hostStartTicks === null || identity.hostCommandLine === null
      if (pidFileStale) {
        // The process that wrote the pid file is gone.
        this.deps.store.remove(distroId)
        await this.clearPidFile(distro, paths.pidFile)
      }
      const proven = pidFileStale ? false : guestHostIsOurs(identity, {
        entryPath: paths.entry,
        ...(stored ? { recordedPid: stored.pid, recordedStartTicks: stored.startTicks } : {})
      })
      if (!proven && !pidFileStale) {
        // A different process now holds the pid, or the file names something we
        // cannot identify. Our Host is gone if the ticks differ; otherwise refuse.
        const ticksDiffer =
          stored !== null &&
          identity.hostStartTicks !== null &&
          identity.hostStartTicks !== stored.startTicks
        if (!ticksDiffer) {
          return {
            status: 'unverifiable',
            error: unverifiableError(
              `Guest pid ${identity.hostPid} cannot be proven to be this iCode Host; iCode will not signal it.`
            ),
            detail: 'guest_pid_unproven'
          }
        }
        this.deps.store.remove(distroId)
        await this.clearPidFile(distro, paths.pidFile)
      } else if (proven) {
        const stopped = await this.stopProvenPid(distro, identity.hostPid)
        if (stopped === 'still_running') {
          return {
            status: 'still_running',
            error: makeAppError(
              'WSL_HOST_STOP_FAILED',
              'The iCode Host did not exit within the shutdown timeout.',
              { detail: `guest pid ${identity.hostPid} still answers` }
            ),
            detail: 'still_running'
          }
        }
        if (stopped === 'unverifiable') {
          return {
            status: 'unverifiable',
            error: makeAppError(
              'WSL_HOST_STOP_FAILED',
              'iCode could not confirm the iCode Host stopped.',
              { detail: `guest pid ${identity.hostPid}` }
            ),
            detail: 'stop_unconfirmed'
          }
        }
        this.deps.store.remove(distroId)
        await this.clearPidFile(distro, paths.pidFile)
        hostOutcome = 'stopped'
      }
    } else {
      // No process holds the pid file; nothing of ours is running in this boot.
      this.deps.store.remove(distroId)
    }

    const released = await this.deps.holder.release(distro)
    const holder: 'released' | 'still_running' | 'unverifiable' =
      released.outcome === 'released'
        ? 'released'
        : released.outcome === 'still_running'
          ? 'still_running'
          : 'unverifiable'

    return { status: 'stopped', host: hostOutcome, holder }
  }

  /** Guest `$HOME`, needed once per distro to place the deployment. */
  guestHome(distro: string): Promise<string | null> {
    return readGuestHome(this.deps.runner, distro, {
      ...(this.signal ? { signal: this.signal } : {})
    })
  }
}

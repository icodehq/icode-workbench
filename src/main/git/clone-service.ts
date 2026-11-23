/**
 * Cloning a remote into a new project folder.
 *
 * The clone runs in the background and reports progress over an event stream;
 * the request returns as soon as the destination has been validated. That is
 * what lets the Add project dialog stream progress and offer Cancel instead of
 * freezing on a multi-minute network operation.
 *
 * Scope rules for cleanup are deliberately conservative: only a destination
 * this service saw absent is ever removed, it must be a strict descendant of the
 * chosen parent, and a non-empty directory without a `.git` entry is preserved
 * and reported rather than deleted.
 */

import { posix, win32 } from 'node:path'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { ExecutionTarget } from '../../shared/domain/repository'
import {
  isCloneableRemoteInput,
  containsRedactionPlaceholder,
  parseRemoteUrl
} from '../../shared/domain/remote-url'
import { isValidCloneName, joinCloneDestination } from '../../shared/domain/clone'
import { MAX_PATH_LENGTH } from '../../shared/domain/paths'
import { quotePosixShell } from '../../shared/domain/shell-quote'
import type { MessageKey } from '../../shared/i18n/messages'
import type { CloneAuthPayload } from '../../shared/schemas/remotes'
import type { WslCommandRunner } from '../wsl/exec'
import { readGuestHome } from '../wsl/host/lifecycle'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { ProjectFolderService } from '../repositories/project-folder-service'
import { ProjectFolderError } from '../repositories/project-folder-service'
import { classifyCloneFailure, type CloneAuthHint } from './clone-failure'
import {
  CloneCredentialError,
  createGuestCredentialBundle,
  createLocalCredentialBundle,
  matchingInsteadOfPrefix,
  type CloneCredentialBundle
} from './clone-credentials'
import { runStreamingGuestClone } from './clone-guest'
import { ClonePersistenceError, type ClonePersistenceService } from './clone-persistence'
import {
  createCloneProgressReader,
  type ClonePhase,
  type CloneProgress
} from './clone-progress'
import { GitUnavailableError } from './executor'

const MAX_ACTIVE_CLONES = 3
const CLONE_TIMEOUT_MS = 30 * 60 * 1_000
const READ_TIMEOUT_MS = 10_000
const AUTH_VERIFY_TIMEOUT_MS = 20_000
const THROTTLE_MS = 100

export type CloneCleanup = 'removed' | 'failed' | 'not-needed'

export type CloneCredentialOutcome = {
  used: boolean
  persistence: 'stored' | 'no-helper' | 'failed' | 'not-applicable'
}

export type CloneEvent =
  | ({
      type: 'progress'
      requestId: string
    } & CloneProgress)
  | {
      type: 'done'
      requestId: string
      destination: string
      unborn: boolean
      credential?: CloneCredentialOutcome
    }
  | {
      type: 'cancelled'
      requestId: string
      destination: string
      cleanup: CloneCleanup
    }
  | {
      type: 'failed'
      requestId: string
      destination: string
      error: AppError
      cleanup: CloneCleanup
    }

export type CloneStartInput = {
  requestId: string
  url: string
  target: ExecutionTarget
  parentPath: string
  name: string
  auth?: CloneAuthPayload
}

export type CloneServiceDeps = {
  gitWorktrees: Pick<GitWorktreeService, 'gitResultFor' | 'hostFsFor' | 'streamGitFor'>
  projectFolders: Pick<ProjectFolderService, 'resolveCloneParent' | 'resolveCloneSource'>
  runner: WslCommandRunner
  /** Per-user directory for one-attempt credential artifacts (userData/clone-auth). */
  credentialRoot: string
  /** Test seam; production reads the distro's own home. */
  readGuestHome?: (distro: string) => Promise<string | null>
  /** Persists a credential after a successful interactive clone when wired. */
  persistence?: Pick<
    ClonePersistenceService,
    'hasHelper' | 'approve' | 'store' | 'switchRemoteToSsh'
  >
}

/** Everything an authenticated attempt needs once the credential package exists. */
type CloneAuthContext = {
  hint: CloneAuthHint
  gitOptions: readonly string[]
  env: Readonly<Record<string, string>>
}

type ActiveClone = {
  requestId: string
  url: string
  target: ExecutionTarget
  parent: string
  destination: string
  controller: AbortController
  auth?: CloneAuthPayload
  authContext: CloneAuthContext | null
  credentialBundle: CloneCredentialBundle | null
}

function fail(
  code: AppError['code'],
  message: string,
  detail?: string,
  messageKey?: MessageKey
): AppError {
  return makeAppError(code, message, {
    ...(detail ? { detail } : {}),
    ...(messageKey === undefined ? {} : { messageKey })
  })
}

/** Credential fields are line-oriented on disk; a newline is a protocol risk. */
function isSingleLineCredential(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/[\u0000\r\n]/u.test(value)
}

/** Keeps the dispatcher's appError wrapper convention. */
export class CloneServiceError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'CloneServiceError'
  }
}

/** One directory name, usable on Windows and POSIX alike. */
export { isValidCloneName }

function isStrictDescendant(parent: string, destination: string, target: ExecutionTarget): boolean {
  const api = target.kind === 'local' && process.platform === 'win32' ? win32 : posix
  const relative = api.relative(api.resolve(parent), api.resolve(destination))
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  )
}

type CompletedAuth = {
  target: ExecutionTarget
  cwd: string
  url: string
  username: string
  password: Buffer
  timer: NodeJS.Timeout
}

const COMPLETED_AUTH_TTL_MS = 10 * 60 * 1_000
const MAX_COMPLETED_AUTH = 8

export class CloneService {
  private readonly active = new Map<string, ActiveClone>()
  private readonly listeners = new Set<(event: CloneEvent) => void>()
  /**
   * A successful HTTPS clone with no helper leaves the user one decision:
   * store, switch to SSH, or skip. The credential is held only in memory, with
   * a TTL, so the user does not have to paste it again after the clone.
   */
  private readonly completedAuth = new Map<string, CompletedAuth>()

  constructor(private readonly deps: CloneServiceDeps) {}

  subscribe(listener: (event: CloneEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Validates the request and starts the clone in the background.
   *
   * Every refusal here happens before a directory is created, so an invalid
   * name or an existing destination costs nothing.
   */
  async start(input: CloneStartInput): Promise<{ requestId: string }> {
    if (this.active.size >= MAX_ACTIVE_CLONES) {
      throw new CloneServiceError(
        fail(
          'INVALID_ARGUMENT',
          'Too many clones are running. Wait for one to finish.',
          undefined,
          'addRepo.clone.busy'
        )
      )
    }
    if (this.active.has(input.requestId)) {
      throw new CloneServiceError(fail('INVALID_ARGUMENT', 'That clone request is already running.'))
    }
    const url = input.url.trim()
    if (!isCloneableRemoteInput(url) || containsRedactionPlaceholder(url)) {
      throw new CloneServiceError(
        fail('INVALID_ARGUMENT', 'Enter a supported Git URL.', input.url.slice(0, 200), 'addRepo.clone.invalidUrl')
      )
    }
    const name = input.name.trim()
    if (!isValidCloneName(name)) {
      throw new CloneServiceError(
        fail(
          'INVALID_ARGUMENT',
          'Enter a folder name without separators or reserved characters.',
          input.name.slice(0, 200),
          'addRepo.clone.invalidName'
        )
      )
    }
    if (input.auth !== undefined) this.validateAuthInput(input.auth, url)

    let parent: string
    try {
      parent = await this.deps.projectFolders.resolveCloneParent({
        path: input.parentPath,
        target: input.target
      })
    } catch (error) {
      if (error instanceof ProjectFolderError) throw new CloneServiceError(error.appError)
      throw error
    }
    const destination = joinCloneDestination(parent, name, input.target)
    if (destination.length > MAX_PATH_LENGTH) {
      throw new CloneServiceError(
        fail(
          'INVALID_ARGUMENT',
          'The destination path is too long.',
          destination.slice(0, 200),
          'addRepo.clone.invalidName'
        )
      )
    }
    if (!isStrictDescendant(parent, destination, input.target)) {
      throw new CloneServiceError(
        fail('INVALID_ARGUMENT', 'Enter a folder name without separators.', name)
      )
    }

    const fs = await this.deps.gitWorktrees.hostFsFor(input.target)
    if (await fs.exists(destination)) {
      throw new CloneServiceError(
        fail(
          'INVALID_ARGUMENT',
          'That folder already exists. Choose another name or destination.',
          destination,
          'addRepo.clone.destinationExists'
        )
      )
    }

    let source = url
    try {
      source = await this.deps.projectFolders.resolveCloneSource({
        path: url,
        target: input.target
      })
    } catch (error) {
      if (error instanceof ProjectFolderError) throw new CloneServiceError(error.appError)
      throw error
    }

    const entry: ActiveClone = {
      requestId: input.requestId,
      url: source,
      target: input.target,
      parent,
      destination,
      controller: new AbortController(),
      auth: input.auth,
      authContext: null,
      credentialBundle: null
    }
    // Validation awaits, so the limits are re-checked before the entry exists.
    if (this.active.size >= MAX_ACTIVE_CLONES) {
      throw new CloneServiceError(
        fail(
          'INVALID_ARGUMENT',
          'Too many clones are running. Wait for one to finish.',
          undefined,
          'addRepo.clone.busy'
        )
      )
    }
    if (this.active.has(entry.requestId)) {
      throw new CloneServiceError(fail('INVALID_ARGUMENT', 'That clone request is already running.'))
    }
    this.active.set(entry.requestId, entry)
    void this.run(entry)
    return { requestId: entry.requestId }
  }

  cancel(requestId: string): boolean {
    const entry = this.active.get(requestId)
    if (entry === undefined) return false
    entry.controller.abort()
    return true
  }

  cancelAll(): void {
    for (const entry of this.active.values()) entry.controller.abort()
  }

  private emit(event: CloneEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A dead window must not stop the clone.
      }
    }
  }

  private emitProgress(
    requestId: string,
    progress: CloneProgress,
    state: { phase: ClonePhase | null; percent: number | null; at: number }
  ): void {
    const now = Date.now()
    const phaseChanged = progress.phase !== state.phase
    const percentChanged =
      progress.percent !== null &&
      (state.percent === null || Math.abs(progress.percent - state.percent) >= 1)
    if (!phaseChanged && (progress.percent === null || !percentChanged || now - state.at < THROTTLE_MS)) {
      return
    }
    state.phase = progress.phase
    state.percent = progress.percent
    state.at = now
    this.emit({ type: 'progress', requestId, ...progress })
  }

  private validateAuthInput(auth: CloneAuthPayload, url: string): void {
    const parsed = parseRemoteUrl(url)
    if (parsed === null || parsed.kind !== 'url' || parsed.isLocalPath) {
      throw new CloneServiceError(
        fail(
          'INVALID_ARGUMENT',
          'Credentials can only be used with a network Git URL.',
          undefined,
          'addRepo.clone.auth.networkOnly'
        )
      )
    }
    if (auth.kind === 'https') {
      if (parsed.scheme !== 'https' || parsed.hasCredentials) {
        throw new CloneServiceError(
          fail(
            'INVALID_ARGUMENT',
            'Credentials can only be used with an HTTPS URL that does not already contain them.',
            undefined,
            'addRepo.clone.auth.httpsOnly'
          )
        )
      }
      if (
        !isSingleLineCredential(auth.username, 255) ||
        !isSingleLineCredential(auth.password, 4_096)
      ) {
        throw new CloneServiceError(
          fail(
            'INVALID_ARGUMENT',
            'Enter a username and password or access token on one line.',
            undefined,
            'addRepo.clone.auth.invalidCredential'
          )
        )
      }
      return
    }
    if (parsed.scheme !== 'ssh' && parsed.scheme !== 'git+ssh') {
      throw new CloneServiceError(
        fail(
          'INVALID_ARGUMENT',
          'An SSH authentication attempt requires an SSH URL.',
          undefined,
          'addRepo.clone.auth.sshOnly'
        )
      )
    }
  }

  /**
   * Writes the per-attempt credential handoff and returns the Git options that
   * mount it. Only HTTPS is supported here; SSH has no secret and is handled by
   * its own flow.
   */
  private async prepareAuth(entry: ActiveClone): Promise<CloneAuthContext | null> {
    const auth = entry.auth
    if (auth === undefined) return null
    if (auth.kind === 'ssh') {
      // The SSH service already tested the key, agent and host key. The clone
      // still preflights with the same BatchMode policy, so a key removed
      // between the test and this call fails before a long transfer.
      const sshCommand = `${quotePosixShell('ssh')} -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes`
      return {
        hint: 'ssh',
        gitOptions: ['-c', `core.sshCommand=${sshCommand}`],
        env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }
      }
    }
    await this.assertNoInsteadOfRewrite(entry)
    const password = Buffer.from(auth.password, 'utf8')
    try {
      const bundle =
        entry.target.kind === 'wsl'
          ? await createGuestCredentialBundle({
              runner: this.deps.runner,
              distro: entry.target.distro,
              home: await this.guestHome(entry),
              requestId: entry.requestId,
              url: entry.url,
              username: auth.username,
              password,
              signal: entry.controller.signal
            })
          : await createLocalCredentialBundle({
              root: this.deps.credentialRoot,
              url: entry.url,
              username: auth.username,
              password
            })
      entry.credentialBundle = bundle
      return { hint: 'https', gitOptions: bundle.gitOptions, env: bundle.env }
    } finally {
      password.fill(0)
    }
  }

  private async guestHome(entry: ActiveClone): Promise<string> {
    if (entry.target.kind !== 'wsl') throw new Error('guestHome called for a non-WSL target')
    const home =
      this.deps.readGuestHome !== undefined
        ? await this.deps.readGuestHome(entry.target.distro)
        : await readGuestHome(this.deps.runner, entry.target.distro)
    if (home === null) {
      throw new CloneCredentialError(
        fail(
          'WSL_UNAVAILABLE',
          'The WSL distro did not report a home directory.',
          entry.target.distro,
          'errors.WSL_UNAVAILABLE'
        )
      )
    }
    return home
  }

  /**
   * A URL Git would rewrite before transport cannot be bound to the host the
   * user typed. Refuse the authenticated attempt rather than authenticate
   * against a different host; an anonymous clone remains available.
   */
  private async assertNoInsteadOfRewrite(entry: ActiveClone): Promise<void> {
    const git = await this.deps.gitWorktrees.gitResultFor(entry.target)
    const result = await git(
      entry.parent,
      ['config', '--get-regexp', '^url\\..*\\.insteadof$'],
      READ_TIMEOUT_MS,
      { signal: entry.controller.signal }
    )
    if (result.timedOut || result.exitCode !== 0) return
    const rewrite = matchingInsteadOfPrefix(entry.url, result.stdout.toString('utf8'))
    if (rewrite === null) return
    throw new CloneCredentialError(
      fail(
        'INVALID_ARGUMENT',
        "This URL is rewritten by Git's url.*.insteadOf configuration; use the rewritten URL.",
        rewrite.slice(0, 200),
        'addRepo.clone.auth.rewrittenUrl'
      )
    )
  }

  /**
   * Proves the credential against the remote before a long clone. `ls-remote`
   * asks for one ref and prints none of the repository; its auth failure is the
   * same Git diagnostic the clone would have produced.
   */
  private async preflightAuth(entry: ActiveClone, context: CloneAuthContext): Promise<boolean> {
    const git = await this.deps.gitWorktrees.gitResultFor(entry.target)
    const result = await git(
      entry.parent,
      [...context.gitOptions, 'ls-remote', '--', entry.url, 'HEAD'],
      AUTH_VERIFY_TIMEOUT_MS,
      { env: context.env, signal: entry.controller.signal }
    )

    if (entry.controller.signal.aborted) {
      const cleanup = await this.cleanup(entry)
      this.emit({ type: 'cancelled', requestId: entry.requestId, destination: entry.destination, cleanup })
      return false
    }
    if (result.spawnFailure === 'wsl_missing') {
      const cleanup = await this.cleanup(entry)
      this.emit({
        type: 'failed',
        requestId: entry.requestId,
        destination: entry.destination,
        error: fail('WSL_UNAVAILABLE', 'WSL is not available.', undefined, 'errors.WSL_UNAVAILABLE'),
        cleanup
      })
      return false
    }
    if (result.timedOut) {
      const cleanup = await this.cleanup(entry)
      this.emit({
        type: 'failed',
        requestId: entry.requestId,
        destination: entry.destination,
        error: fail(
          'GIT_REMOTE_FAILED',
          'Git did not answer while checking credentials.',
          undefined,
          'addRepo.clone.auth.checkTimeout'
        ),
        cleanup
      })
      return false
    }
    if (result.exitCode === 0) return true

    const cleanup = await this.cleanup(entry)
    this.emit({
      type: 'failed',
      requestId: entry.requestId,
      destination: entry.destination,
      error: classifyCloneFailure({
        stderr: result.stderr.toString('utf8'),
        operation: 'clone',
        target: entry.target,
        remoteUrl: entry.url,
        fallback: 'The repository could not be cloned.'
      }),
      cleanup
    })
    return false
  }

  /**
   * Saves the credential where the environment's Git can find it later.
   *
   * An existing helper is authoritative and receives an approve silently. No
   * helper means there is nowhere to save: the record waits for the dialog's
   * explicit store/SSH/skip choice. Either way the plaintext reference in
   * `entry.auth` is dropped here.
   */
  private async persistenceAfterClone(
    entry: ActiveClone
  ): Promise<CloneCredentialOutcome | undefined> {
    const auth = entry.auth
    if (auth?.kind !== 'https') return undefined
    const persistence = this.deps.persistence
    if (persistence === undefined) return { used: true, persistence: 'not-applicable' }
    const password = Buffer.from(auth.password, 'utf8')
    try {
      let hasHelper = false
      try {
        hasHelper = await persistence.hasHelper(entry.target, entry.destination, entry.url)
      } catch {
        hasHelper = false
      }
      if (hasHelper) {
        try {
          await persistence.approve(
            entry.target,
            entry.destination,
            entry.url,
            auth.username,
            password
          )
          return { used: true, persistence: 'stored' }
        } catch {
          return { used: true, persistence: 'failed' }
        }
      }
      this.rememberCompletedAuth(entry, auth.username, password)
      return { used: true, persistence: 'no-helper' }
    } finally {
      password.fill(0)
      entry.auth = undefined
    }
  }

  private rememberCompletedAuth(entry: ActiveClone, username: string, password: Buffer): void {
    this.clearCompletedAuth(entry.requestId)
    if (this.completedAuth.size >= MAX_COMPLETED_AUTH) {
      const oldest = this.completedAuth.keys().next().value
      if (oldest !== undefined) this.clearCompletedAuth(oldest)
    }
    const timer = setTimeout(
      () => this.clearCompletedAuth(entry.requestId),
      COMPLETED_AUTH_TTL_MS
    )
    timer.unref?.()
    this.completedAuth.set(entry.requestId, {
      target: entry.target,
      cwd: entry.destination,
      url: entry.url,
      username,
      password: Buffer.from(password),
      timer
    })
  }

  private clearCompletedAuth(requestId: string): void {
    const record = this.completedAuth.get(requestId)
    if (record === undefined) return
    clearTimeout(record.timer)
    record.password.fill(0)
    this.completedAuth.delete(requestId)
  }

  /**
   * Handles the dialog's post-success choice. The renderer names only a
   * request id and a mode; destination, target and credential come from the
   * in-memory record, never from the wire.
   */
  async persist(
    requestId: string,
    mode: 'store' | 'ssh' | 'skip',
    sshUrl?: string
  ): Promise<{ status: 'stored' | 'switched' | 'skipped' }> {
    const record = this.completedAuth.get(requestId)
    if (record === undefined) {
      throw new CloneServiceError(
        fail(
          'INVALID_ARGUMENT',
          'The saved credential is no longer available.',
          undefined,
          'addRepo.clone.persist.expired'
        )
      )
    }
    const persistence = this.deps.persistence
    if (mode !== 'skip' && persistence === undefined) {
      this.clearCompletedAuth(requestId)
      throw new CloneServiceError(fail('INTERNAL', 'Credential persistence is unavailable.'))
    }
    try {
      if (mode === 'skip') return { status: 'skipped' }
      if (mode === 'store') {
        // A helper may have appeared since the clone; prefer it over adding a
        // second, plaintext one to the global configuration.
        const hasHelper = await persistence!.hasHelper(
          record.target,
          record.cwd,
          record.url
        )
        if (hasHelper) {
          await persistence!.approve(
            record.target,
            record.cwd,
            record.url,
            record.username,
            record.password
          )
        } else {
          await persistence!.store(
            record.target,
            record.cwd,
            record.url,
            record.username,
            record.password
          )
        }
        return { status: 'stored' }
      }
      if (sshUrl === undefined) {
        throw new CloneServiceError(
          fail(
            'INVALID_ARGUMENT',
            'An SSH URL is required to switch this checkout.',
            undefined,
            'addRepo.clone.auth.sshOnly'
          )
        )
      }
      await persistence!.switchRemoteToSsh(record.target, record.cwd, record.url, sshUrl)
      return { status: 'switched' }
    } catch (error) {
      if (error instanceof ClonePersistenceError) {
        throw new CloneServiceError(error.appError)
      }
      throw error
    } finally {
      this.clearCompletedAuth(requestId)
    }
  }

  private async run(entry: ActiveClone): Promise<void> {
    const { requestId, target, url, destination } = entry
    const throttleState = { phase: null as ClonePhase | null, percent: null as number | null, at: 0 }
    const reader = createCloneProgressReader((progress) => {
      this.emitProgress(requestId, progress, throttleState)
    })
    let cloneCompleted = false
    this.emit({
      type: 'progress',
      requestId,
      phase: 'starting',
      percent: null,
      detail: ''
    })

    try {
      const authContext = await this.prepareAuth(entry)
      if (authContext !== null) {
        entry.authContext = authContext
        if (!(await this.preflightAuth(entry, authContext))) return
      }
      const result =
        target.kind === 'wsl'
          ? await this.cloneGuest(entry, reader)
          : await this.cloneLocal(entry, reader)
      reader.flush()

      if (result.timedOut) {
        const cleanup = await this.cleanup(entry)
        this.emit({
          type: 'failed',
          requestId,
          destination,
          error: fail('GIT_REMOTE_FAILED', 'The clone did not finish in time.'),
          cleanup
        })
        return
      }
      if (result.spawnFailure === 'wsl_missing') {
        const cleanup = await this.cleanup(entry)
        this.emit({
          type: 'failed',
          requestId,
          destination,
          error: fail(
            'WSL_UNAVAILABLE',
            'WSL is not available.',
            undefined,
            'errors.WSL_UNAVAILABLE'
          ),
          cleanup
        })
        return
      }
      if (result.cancelled) {
        const cleanup = await this.cleanup(entry)
        this.emit({ type: 'cancelled', requestId, destination, cleanup })
        return
      }
      if (result.exitCode !== 0) {
        const cleanup = await this.cleanup(entry)
        if (entry.controller.signal.aborted) {
          this.emit({ type: 'cancelled', requestId, destination, cleanup })
          return
        }
        this.emit({
          type: 'failed',
          requestId,
          destination,
          error: classifyCloneFailure({
            stderr: result.stderr,
            operation: 'clone',
            target,
            remoteUrl: url,
            fallback: 'The repository could not be cloned.'
          }),
          cleanup
        })
        return
      }

      const fs = await this.deps.gitWorktrees.hostFsFor(target)
      cloneCompleted = true
      if (!(await fs.exists(destination))) {
        this.emit({
          type: 'failed',
          requestId,
          destination,
          error: fail('GIT_REMOTE_FAILED', 'The clone finished but the destination is missing.'),
          cleanup: 'not-needed'
        })
        return
      }
      const unborn = await this.isUnborn(destination, target)
      const credentialOutcome = await this.persistenceAfterClone(entry)
      this.emit({
        type: 'progress',
        requestId,
        phase: 'done',
        percent: 100,
        detail: ''
      })
      this.emit({
        type: 'done',
        requestId,
        destination,
        unborn,
        ...(credentialOutcome === undefined ? {} : { credential: credentialOutcome })
      })
    } catch (error) {
      // Cancellation wins over whatever shape the transport reported: a local
      // spawn aborted through its signal rejects with an AbortError rather than
      // returning a non-zero exit.
      if (entry.controller.signal.aborted && !cloneCompleted) {
        const cleanup = await this.cleanup(entry)
        this.emit({ type: 'cancelled', requestId, destination, cleanup })
        return
      }
      // A clone that exited successfully is never deleted because a follow-up
      // read failed; the checkout is the user's now.
      const cleanup = cloneCompleted ? 'not-needed' : await this.cleanup(entry)
      this.emit({
        type: 'failed',
        requestId,
        destination,
        error:
          error !== null && typeof error === 'object' && 'appError' in error
            ? (error as { appError: AppError }).appError
            : fail(
                'GIT_REMOTE_FAILED',
                'The repository could not be cloned.',
                error instanceof Error ? error.message : String(error)
              ),
        cleanup
      })
    } finally {
      // The credential directory exists only for this process lifetime.
      await entry.credentialBundle?.dispose()
      this.active.delete(requestId)
    }
  }

  private async cloneLocal(
    entry: ActiveClone,
    reader: ReturnType<typeof createCloneProgressReader>
  ): Promise<{
    exitCode: number | null
    timedOut: boolean
    cancelled: boolean
    stderr: string
    spawnFailure?: 'wsl_missing'
  }> {
    const stream = await this.deps.gitWorktrees.streamGitFor(entry.target)
    if (stream === null) {
      throw new GitUnavailableError('Git streaming is unavailable on this host.')
    }
    const auth = entry.authContext
    const result = await stream(
      entry.parent,
      [...(auth?.gitOptions ?? []), 'clone', '--progress', '--', entry.url, entry.destination],
      {
        onStderr: (chunk) => reader.push(chunk)
      },
      {
        timeoutMs: CLONE_TIMEOUT_MS,
        signal: entry.controller.signal,
        ...(auth === null ? {} : { env: auth.env })
      }
    )
    return {
      exitCode: result.timedOut ? null : result.exitCode,
      timedOut: result.timedOut,
      cancelled: entry.controller.signal.aborted,
      stderr: result.stderr.toString('utf8')
    }
  }

  private async cloneGuest(
    entry: ActiveClone,
    reader: ReturnType<typeof createCloneProgressReader>
  ): Promise<{
    exitCode: number | null
    timedOut: boolean
    cancelled: boolean
    stderr: string
    spawnFailure?: 'wsl_missing'
  }> {
    if (entry.target.kind !== 'wsl') {
      throw new Error('cloneGuest called for a non-WSL target')
    }
    const chunks: Buffer[] = []
    let bytes = 0
    const result = await runStreamingGuestClone({
      runner: this.deps.runner,
      distro: entry.target.distro,
      url: entry.url,
      destination: entry.destination,
      timeoutMs: CLONE_TIMEOUT_MS,
      signal: entry.controller.signal,
      onStderr: (chunk) => {
        reader.push(chunk)
        chunks.push(chunk)
        bytes += chunk.length
        while (bytes > 64 * 1024 && chunks.length > 1) {
          bytes -= chunks[0]!.length
          chunks.shift()
        }
      },
      ...(entry.authContext === null
        ? {}
        : { gitOptions: entry.authContext.gitOptions, env: entry.authContext.env })
    })
    return {
      exitCode: result.code,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stderr: Buffer.concat(chunks).toString('utf8'),
      ...(result.spawnFailure === undefined ? {} : { spawnFailure: result.spawnFailure })
    }
  }

  private async isUnborn(destination: string, target: ExecutionTarget): Promise<boolean> {
    const git = await this.deps.gitWorktrees.gitResultFor(target)
    const head = await git(destination, ['rev-parse', '--verify', 'HEAD'], READ_TIMEOUT_MS)
    if (head.timedOut) {
      throw fail('GIT_REMOTE_FAILED', 'Git did not answer while reading the cloned repository.')
    }
    if (head.spawnFailure !== undefined) {
      throw fail(
        'WSL_UNAVAILABLE',
        'The WSL distro could not run Git.',
        undefined,
        'errors.WSL_UNAVAILABLE'
      )
    }
    return head.exitCode !== 0
  }

  /**
   * Removes a partial clone.
   *
   * A destination that does not exist needs nothing. A destination that exists
   * but has no `.git` entry and is not empty is preserved: it was not created by
   * this clone, and deleting user data is worse than leaving a message.
   */
  private async cleanup(entry: ActiveClone): Promise<CloneCleanup> {
    const { parent, destination, target } = entry
    if (!isStrictDescendant(parent, destination, target)) return 'not-needed'
    const fs = await this.deps.gitWorktrees.hostFsFor(target)
    try {
      if (!(await fs.exists(destination))) return 'not-needed'
      const hasGitEntry = await fs.exists(`${destination}/.git`)
      const empty = await fs.isEmptyDirectory(destination)
      if (!hasGitEntry && !empty) return 'failed'
      await fs.removeTree(destination)
      return 'removed'
    } catch {
      return 'failed'
    }
  }
}

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
import { isCloneableRemoteInput, containsRedactionPlaceholder } from '../../shared/domain/remote-url'
import { isValidCloneName, joinCloneDestination } from '../../shared/domain/clone'
import { MAX_PATH_LENGTH } from '../../shared/domain/paths'
import type { MessageKey } from '../../shared/i18n/messages'
import type { WslCommandRunner } from '../wsl/exec'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { ProjectFolderService } from '../repositories/project-folder-service'
import { ProjectFolderError } from '../repositories/project-folder-service'
import { classifyRemoteFailure } from './remote-failure'
import { runStreamingGuestClone } from './clone-guest'
import {
  createCloneProgressReader,
  type ClonePhase,
  type CloneProgress
} from './clone-progress'
import { GitUnavailableError } from './executor'

const MAX_ACTIVE_CLONES = 3
const CLONE_TIMEOUT_MS = 30 * 60 * 1_000
const READ_TIMEOUT_MS = 10_000
const THROTTLE_MS = 100

export type CloneCleanup = 'removed' | 'failed' | 'not-needed'

export type CloneEvent =
  | ({
      type: 'progress'
      requestId: string
    } & CloneProgress)
  | { type: 'done'; requestId: string; destination: string; unborn: boolean }
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
}

export type CloneServiceDeps = {
  gitWorktrees: Pick<GitWorktreeService, 'gitResultFor' | 'hostFsFor' | 'streamGitFor'>
  projectFolders: Pick<ProjectFolderService, 'resolveCloneParent' | 'resolveCloneSource'>
  runner: WslCommandRunner
}

type ActiveClone = {
  requestId: string
  url: string
  target: ExecutionTarget
  parent: string
  destination: string
  controller: AbortController
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

export class CloneService {
  private readonly active = new Map<string, ActiveClone>()
  private readonly listeners = new Set<(event: CloneEvent) => void>()

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
      controller: new AbortController()
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
          error: classifyRemoteFailure({
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
      this.emit({
        type: 'progress',
        requestId,
        phase: 'done',
        percent: 100,
        detail: ''
      })
      this.emit({ type: 'done', requestId, destination, unborn })
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
    const result = await stream(
      entry.parent,
      ['clone', '--progress', '--', entry.url, entry.destination],
      {
        onStderr: (chunk) => reader.push(chunk)
      },
      { timeoutMs: CLONE_TIMEOUT_MS, signal: entry.controller.signal }
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
      }
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

import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import { normalizeRelativePath, type FileContent, type FileListing, type FileSearchResult } from '../../shared/domain/workspace-files'
import { makeAppError } from '../../shared/domain/errors'
import { createLocalFileBackend, FileAccessError, type FileBackend } from './local-file-backend'
import { createGuestFileBackend } from './guest-file-backend'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import { SessionServiceError } from '../sessions/session-errors'
import type { SessionService } from '../sessions/session-service'

export type WorkspaceFilesDeps = {
  sessions: SessionService
  repositories: RepositoryStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  runner: import('../wsl/exec').WslCommandRunner
  /** Test seam: forces a backend without a real distro. */
  backendFor?: (worktreePath: string, target: import('../../shared/domain/repository').ExecutionTarget) => FileBackend
}

export type FilesUnavailable = {
  status: 'unavailable'
  reason:
    | 'primary-checkout'
    | 'worktree-missing'
    | 'worktree-unavailable'
    | 'path-outside'
    | 'not-found'
    | 'not-a-file'
    | 'not-a-directory'
    | 'unreadable'
    | 'file-too-large'
    | 'binary'
    | 'write-failed'
  detail: string
}

export type FilesOutcome<T> = ({ status: 'ok' } & T) | FilesUnavailable

type Resolved =
  | {
      status: 'ok'
      worktreePath: string
      target: import('../../shared/domain/repository').ExecutionTarget
      backend: FileBackend
    }
  | FilesUnavailable

function outsideWorktree(): FilesUnavailable {
  return {
    status: 'unavailable',
    reason: 'path-outside',
    detail: 'That path is not inside this worktree.'
  }
}

/**
 * File browsing, editing and search, scoped to one session's checkout.
 *
 * The backend is chosen from the repository's persisted execution target, never
 * from the path string, and there is no fallback: a checkout that lives in a
 * distro is read by the distro. A temporary inability to reach that distro is
 * reported as `worktree-unavailable`, never as a missing project.
 */
export class WorkspaceFilesService {
  private readonly backends = new Map<string, FileBackend>()

  constructor(private readonly deps: WorkspaceFilesDeps) {}

  async list(sessionId: string, path: string): Promise<FilesOutcome<FileListing>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const relative = normalizeRelativePath(path)
    if (relative === null) return outsideWorktree()
    try {
      const listing = await resolved.backend.list(relative)
      return { status: 'ok', path: relative, entries: listing.entries, truncated: listing.truncated }
    } catch (error) {
      return this.mapError(error)
    }
  }

  async read(sessionId: string, path: string): Promise<FilesOutcome<FileContent>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const relative = normalizeRelativePath(path)
    if (relative === null || relative === '') return outsideWorktree()
    try {
      return { status: 'ok', ...(await resolved.backend.read(relative)) }
    } catch (error) {
      return this.mapError(error)
    }
  }

  async write(sessionId: string, path: string, text: string): Promise<FilesOutcome<{ size: number }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const relative = normalizeRelativePath(path)
    if (relative === null || relative === '') return outsideWorktree()
    if (typeof text !== 'string') {
      return { status: 'unavailable', reason: 'write-failed', detail: 'No content was supplied.' }
    }
    try {
      const result = await resolved.backend.write(relative, text)
      return { status: 'ok', ...result }
    } catch (error) {
      return this.mapError(error)
    }
  }

  async search(
    sessionId: string,
    query: string,
    options: { caseSensitive?: boolean; limit?: number } = {}
  ): Promise<FilesOutcome<FileSearchResult>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      return { status: 'ok', matches: [], truncated: false, scannedFiles: 0 }
    }
    try {
      const result = await resolved.backend.search(trimmed, {
        caseSensitive: options.caseSensitive === true,
        limit: Math.max(1, Math.min(options.limit ?? 200, 500))
      })
      return { status: 'ok', ...result }
    } catch (error) {
      return this.mapError(error)
    }
  }

  private mapError(error: unknown): FilesOutcome<never> {
    if (error instanceof FileAccessError) {
      return { status: 'unavailable', reason: error.reason, detail: error.message }
    }
    return {
      status: 'unavailable',
      reason: 'unreadable',
      detail: error instanceof Error ? error.message : String(error)
    }
  }

  /** Session → checkout + the backend for the host that owns it. */
  private async resolve(sessionId: string): Promise<Resolved> {
    const record = this.deps.worktrees.findBySession(sessionId)
    if (!record) {
      return {
        status: 'unavailable',
        reason: 'primary-checkout',
        detail: 'This session runs in the primary checkout, which has no isolated file scope.'
      }
    }
    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      return {
        status: 'unavailable',
        reason: 'not-found',
        detail: 'The session repository is no longer registered.'
      }
    }

    const target = repository.executionTarget
    // Existence is asked of the host that owns the checkout, so a distro path is
    // never tested against the controller's filesystem.
    let exists: boolean
    try {
      const fs = await this.deps.gitWorktrees.hostFsFor(target)
      exists = await fs.isDirectory(record.path)
    } catch {
      return {
        status: 'unavailable',
        reason: 'worktree-unavailable',
        detail:
          target.kind === 'local'
            ? 'The session worktree could not be inspected.'
            : 'The session distro could not be reached, so its files are unavailable right now.'
      }
    }
    if (!exists) {
      return {
        status: 'unavailable',
        reason: 'worktree-missing',
        detail:
          target.kind === 'local'
            ? 'The session worktree directory is missing.'
            : 'The session worktree directory is missing inside its distro.'
      }
    }

    return { status: 'ok', worktreePath: record.path, target, backend: this.backendFor(record.path, target) }
  }

  private backendFor(
    worktreePath: string,
    target: import('../../shared/domain/repository').ExecutionTarget
  ): FileBackend {
    if (this.deps.backendFor) return this.deps.backendFor(worktreePath, target)
    const key =
      target.kind === 'local'
        ? `local:${worktreePath}`
        : `wsl:${target.distro}\u0000${target.distroId ?? ''}\u0000${worktreePath}`
    const existing = this.backends.get(key)
    if (existing) return existing
    const backend =
      target.kind === 'local'
        ? createLocalFileBackend(worktreePath)
        : createGuestFileBackend(this.deps.runner, target.distro, worktreePath)
    // Both kinds are bound to one checkout: a guest backend `cd`s into it on
    // every call, so sharing one across worktrees would read the wrong tree.
    this.backends.set(key, backend)
    return backend
  }
}

/** Re-exported so the IPC layer can map a service error to the shared type. */
export function filesError(error: unknown): SessionServiceError {
  return new SessionServiceError(
    makeAppError('INTERNAL', 'The file request could not be completed.', {
      detail: error instanceof Error ? error.message : String(error)
    })
  )
}

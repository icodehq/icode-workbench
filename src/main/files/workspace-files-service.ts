import type { RepositoryStore } from '../persistence/repository-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import { dirname, join, posix, win32 } from 'node:path'
import {
  normalizeRelativePath,
  parentPath,
  type FileBatchEntry,
  type FileBatchResult,
  type FileContent,
  type FileListing,
  type FileReplaceEntry,
  type FileReplaceResult,
  type FileSearchOptions,
  type FileSearchResult,
  type FileStat,
  type FileTrashEntry,
  type FileTrashOperation,
  type FileTrashResult
} from '../../shared/domain/workspace-files'
import { replaceLiteralAll } from '../../shared/domain/text-search'
import { makeAppError } from '../../shared/domain/errors'
import { createLocalFileBackend, FileAccessError, type FileBackend } from './local-file-backend'
import { createGuestFileBackend } from './guest-file-backend'
import { FilesTrashState } from './files-trash-state'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import { SessionServiceError } from '../sessions/session-errors'
import type { SessionService } from '../sessions/session-service'

export type WorkspaceFilesDeps = {
  sessions: SessionService
  repositories: RepositoryStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  runner: import('../wsl/exec').WslCommandRunner
  /** Controller-side metadata for the app-managed session trash. */
  trashStateFile?: string
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
    | 'already-exists'
    | 'changed-on-disk'
    | 'invalid-query'
    | 'cancelled'
  detail: string
  /** The version that caused a `changed-on-disk` refusal, when known. */
  currentEtag?: string
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

function basenameOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/')
  return index === -1 ? relativePath : relativePath.slice(index + 1)
}

/** Removes paths whose ancestor is also in the list, preserving order. */
export function collapseDescendantPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)]
  const sorted = unique.sort(
    (left, right) => left.length - right.length || left.localeCompare(right)
  )
  const result: string[] = []
  for (const path of sorted) {
    if (result.some((ancestor) => path === ancestor || path.startsWith(`${ancestor}/`))) {
      continue
    }
    result.push(path)
  }
  return result
}

/** Splits `name.ext` so incremental copies keep the extension. */
function splitName(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { base: name, extension: '' }
  return { base: name.slice(0, dot), extension: name.slice(dot) }
}

export function incrementCopyName(name: string, isDirectory: boolean, attempt: number): string {
  if (attempt <= 0) return name
  const { base, extension } = isDirectory ? { base: name, extension: '' } : splitName(name)
  const suffix = attempt === 1 ? ' copy' : ` copy ${String(attempt)}`
  return `${base}${suffix}${extension}`
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
  private readonly searchControllers = new Map<string, AbortController>()
  private readonly trashState: FilesTrashState

  constructor(private readonly deps: WorkspaceFilesDeps) {
    this.trashState = new FilesTrashState(deps.trashStateFile ?? null)
  }

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

  async stat(sessionId: string, path: string): Promise<FilesOutcome<FileStat>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const relative = normalizeRelativePath(path)
    if (relative === null || relative === '') return outsideWorktree()
    try {
      return { status: 'ok', ...(await resolved.backend.stat(relative)) }
    } catch (error) {
      return this.mapError(error)
    }
  }

  async write(
    sessionId: string,
    path: string,
    text: string,
    expectedEtag?: string | null
  ): Promise<FilesOutcome<{ size: number; etag: string }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const relative = normalizeRelativePath(path)
    if (relative === null || relative === '') return outsideWorktree()
    if (typeof text !== 'string') {
      return { status: 'unavailable', reason: 'write-failed', detail: 'No content was supplied.' }
    }
    try {
      const result = await resolved.backend.write(relative, text, expectedEtag)
      return { status: 'ok', ...result }
    } catch (error) {
      return this.mapError(error)
    }
  }

  /**
   * Creates an empty file, or a directory.
   *
   * The empty path is refused: the worktree root always exists, so asking to
   * create it is a UI bug rather than a user intention.
   */
  async create(
    sessionId: string,
    path: string,
    kind: 'file' | 'directory'
  ): Promise<FilesOutcome<{ path: string; kind: 'file' | 'directory'; etag: string | null }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const relative = normalizeRelativePath(path)
    if (relative === null || relative === '') return outsideWorktree()
    try {
      const created = await resolved.backend.create(relative, kind)
      return { status: 'ok', path: relative, kind, etag: created.etag }
    } catch (error) {
      return this.mapError(error)
    }
  }

  /** Renames or moves one path inside the worktree. */
  async rename(
    sessionId: string,
    from: string,
    to: string
  ): Promise<FilesOutcome<{ from: string; to: string }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const source = normalizeRelativePath(from)
    const target = normalizeRelativePath(to)
    if (source === null || target === null || source === '' || target === '') return outsideWorktree()
    if (source === target) {
      return { status: 'unavailable', reason: 'already-exists', detail: 'The new name is the same as the old one.' }
    }
    try {
      await resolved.backend.rename(source, target)
      return { status: 'ok', from: source, to: target }
    } catch (error) {
      return this.mapError(error)
    }
  }

  /** Deletes one path. The caller confirms; the service only refuses escapes. */
  async remove(sessionId: string, path: string): Promise<FilesOutcome<{ path: string }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const relative = normalizeRelativePath(path)
    if (relative === null || relative === '') return outsideWorktree()
    try {
      await resolved.backend.remove(relative)
      return { status: 'ok', path: relative }
    } catch (error) {
      return this.mapError(error)
    }
  }

  async removeMany(
    sessionId: string,
    paths: readonly string[]
  ): Promise<FilesOutcome<FileBatchResult>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const normalized = this.normalizeMany(paths)
    if (normalized.status === 'unavailable') return normalized
    const results: FileBatchEntry[] = []
    for (const path of collapseDescendantPaths(normalized.paths)) {
      try {
        await resolved.backend.remove(path)
        results.push({ path, ok: true })
      } catch (error) {
        if (error instanceof FileAccessError && error.reason === 'not-found') {
          // The path is already gone; the user's intent is satisfied.
          results.push({ path, ok: true })
        } else {
          results.push(this.batchFailure(path, error))
        }
      }
    }
    return { status: 'ok', results }
  }

  /**
   * Moves paths into the app-managed session trash.
   *
   * Metadata is written before any bytes move, so a failed metadata write
   * aborts the whole request instead of stranding files in an unreachable
   * directory. Individual host failures leave the rest of the batch restorable.
   */
  async trashMany(
    sessionId: string,
    paths: readonly string[]
  ): Promise<FilesOutcome<FileTrashResult>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const normalized = this.normalizeMany(paths)
    if (normalized.status === 'unavailable') return normalized
    const sources = collapseDescendantPaths(normalized.paths)
    const opId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const opDir = this.trashOperationDir(resolved.worktreePath, sessionId, opId)
    const outcomes = new Map<string, FileBatchEntry>()
    const entries: FileTrashEntry[] = []
    for (const path of sources) {
      try {
        const info = await resolved.backend.stat(path)
        if (info.kind !== 'file' && info.kind !== 'directory') {
          throw new FileAccessError('not-a-file', 'That path is not a file or folder.')
        }
        entries.push({ path, name: `item-${String(entries.length)}`, kind: info.kind })
      } catch (error) {
        outcomes.set(path, this.batchFailure(path, error))
      }
    }
    if (entries.length === 0) {
      return {
        status: 'ok',
        opId: null,
        results: sources.map((path) => outcomes.get(path)!),
        entries: []
      }
    }
    try {
      await this.trashState.record(sessionId, {
        opId,
        createdAt: Date.now(),
        entries
      })
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'write-failed',
        detail:
          error instanceof Error
            ? `The Trash metadata could not be saved: ${error.message}`
            : 'The Trash metadata could not be saved.'
      }
    }

    const succeeded: FileTrashEntry[] = []
    for (const entry of entries) {
      try {
        await resolved.backend.trash(entry.path, opDir, entry.name)
        succeeded.push(entry)
        outcomes.set(entry.path, { path: entry.path, ok: true })
      } catch (error) {
        outcomes.set(entry.path, this.batchFailure(entry.path, error))
      }
    }
    await this.trashState.replaceEntries(sessionId, opId, succeeded).catch(() => undefined)
    if (succeeded.length === 0) {
      await resolved.backend.discardTrash(opDir).catch(() => undefined)
      await this.trashState.remove(sessionId, opId).catch(() => undefined)
    }
    return {
      status: 'ok',
      opId: succeeded.length > 0 ? opId : null,
      results: sources.map((path) => outcomes.get(path)!),
      entries: succeeded
    }
  }

  /** Restores one trash batch, leaving failed entries retryable in metadata. */
  async restoreTrash(
    sessionId: string,
    opId: string
  ): Promise<FilesOutcome<FileBatchResult>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const operation = await this.trashState.find(sessionId, opId)
    if (operation === null || operation.entries.length === 0) {
      return {
        status: 'unavailable',
        reason: 'not-found',
        detail: 'That deleted batch is no longer in Trash.'
      }
    }
    const opDir = this.trashOperationDir(resolved.worktreePath, sessionId, operation.opId)
    if (!(await resolved.backend.trashExists(opDir))) {
      await this.trashState.remove(sessionId, opId).catch(() => undefined)
      return {
        status: 'unavailable',
        reason: 'not-found',
        detail: 'That deleted batch is no longer in Trash.'
      }
    }
    const results: FileBatchEntry[] = []
    const remaining: FileTrashEntry[] = []
    for (const entry of operation.entries) {
      try {
        await resolved.backend.restoreTrash(opDir, entry.name, entry.path)
        results.push({ path: entry.path, ok: true })
      } catch (error) {
        results.push(this.batchFailure(entry.path, error))
        remaining.push(entry)
      }
    }
    await this.trashState.replaceEntries(sessionId, opId, remaining).catch(() => undefined)
    if (remaining.length === 0) {
      await resolved.backend.discardTrash(opDir).catch(() => undefined)
    }
    return { status: 'ok', results }
  }

  /** Throws away trash older than seven days for this session. */
  async purgeTrash(sessionId?: string): Promise<void> {
    const entries =
      sessionId === undefined
        ? await this.trashState.all()
        : (await this.trashState.list(sessionId)).map((operation) => ({
            sessionId,
            operation
          }))
    const now = Date.now()
    for (const { sessionId: id, operation } of entries) {
      if (now - operation.createdAt < 7 * 24 * 60 * 60 * 1000) continue
      const resolved = await this.resolve(id)
      if (resolved.status === 'ok') {
        await resolved.backend
          .discardTrash(this.trashOperationDir(resolved.worktreePath, id, operation.opId))
          .catch(() => undefined)
        await this.trashState.remove(id, operation.opId).catch(() => undefined)
      } else if (resolved.reason !== 'worktree-unavailable') {
        // The worktree is gone or this is not a session worktree; the trash
        // directory is unreachable and the metadata would otherwise grow.
        await this.trashState.remove(id, operation.opId).catch(() => undefined)
      }
    }
  }

  /**
   * Removes the app-managed Trash directories for sessions whose repository is
   * being removed, together with their metadata.
   *
   * `git worktree remove` deletes the checkout but not this sibling directory
   * (`<worktreeRoot>/<repoId>/.icode-files-trash/<sessionId>`), so removal must
   * clean it explicitly. The caller passes the original worktree path because
   * the session/worktree rows may already be gone by the time cleanup runs.
   */
  async discardTrashForSessions(
    entries: ReadonlyArray<{
      sessionId: string
      worktreePath: string
      target: import('../../shared/domain/repository').ExecutionTarget
    }>
  ): Promise<void> {
    for (const entry of entries) {
      const api =
        entry.target.kind === 'wsl' || process.platform !== 'win32' ? posix : win32
      const trashRoot = api.join(
        api.dirname(entry.worktreePath),
        '.icode-files-trash',
        entry.sessionId
      )
      const fs = await this.deps.gitWorktrees.hostFsFor(entry.target)
      await fs.removeTree(trashRoot)
      await this.trashState.removeSession(entry.sessionId)
      this.disposeSession(entry.sessionId, entry.worktreePath, entry.target)
    }
  }

  /** Drops in-memory per-session backends and search controllers. */
  disposeSessions(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.searchControllers.get(sessionId)?.abort()
      this.searchControllers.delete(sessionId)
    }
  }

  private disposeSession(
    sessionId: string,
    worktreePath: string,
    target: import('../../shared/domain/repository').ExecutionTarget
  ): void {
    this.searchControllers.get(sessionId)?.abort()
    this.searchControllers.delete(sessionId)
    this.backends.delete(this.backendKey(worktreePath, target))
  }

  async listTrash(
    sessionId: string
  ): Promise<FilesOutcome<{ items: FileTrashOperation[] }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    await this.purgeTrash(sessionId)
    const items = await this.trashState.list(sessionId)
    const alive: FileTrashOperation[] = []
    for (const item of items) {
      if (
        await resolved.backend
          .trashExists(this.trashOperationDir(resolved.worktreePath, sessionId, item.opId))
          .catch(() => false)
      ) {
        alive.push(item)
      } else {
        await this.trashState.remove(sessionId, item.opId).catch(() => undefined)
      }
    }
    return { status: 'ok', items: alive }
  }

  private trashOperationDir(
    worktreePath: string,
    sessionId: string,
    opId: string
  ): string {
    return join(dirname(worktreePath), '.icode-files-trash', sessionId, opId)
  }

  async moveMany(
    sessionId: string,
    paths: readonly string[],
    destination: string
  ): Promise<FilesOutcome<FileBatchResult>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const normalized = this.normalizeMany(paths)
    if (normalized.status === 'unavailable') return normalized
    const targetDirectory = normalizeRelativePath(destination)
    if (targetDirectory === null) return outsideWorktree()
    const sources = collapseDescendantPaths(normalized.paths)
    for (const source of sources) {
      if (
        targetDirectory === source ||
        targetDirectory.startsWith(`${source}/`)
      ) {
        return {
          status: 'unavailable',
          reason: 'write-failed',
          detail: 'A folder cannot be moved into itself.'
        }
      }
    }
    const destinationProblem = await this.requireDirectory(
      resolved.backend,
      targetDirectory
    )
    if (destinationProblem !== null) return destinationProblem

    const pairs: Array<{ from: string; to: string; skipped: boolean }> = []
    for (const source of sources) {
      const to =
        targetDirectory === '' ? basenameOf(source) : `${targetDirectory}/${basenameOf(source)}`
      pairs.push({ from: source, to, skipped: parentPath(source) === targetDirectory })
    }

    const live = pairs.filter((pair) => !pair.skipped)
    const targets = new Set<string>()
    for (const pair of live) {
      if (targets.has(pair.to)) {
        return {
          status: 'unavailable',
          reason: 'already-exists',
          detail: 'More than one item would use the same name at the destination.'
        }
      }
      targets.add(pair.to)
    }

    // Refuse the whole batch before moving anything if any target exists.
    const collisions: string[] = []
    for (const pair of live) {
      try {
        await resolved.backend.stat(pair.to)
        collisions.push(pair.to)
      } catch (error) {
        if (error instanceof FileAccessError && error.reason === 'not-found') continue
        return this.mapError(error)
      }
    }
    if (collisions.length > 0) {
      return {
        status: 'unavailable',
        reason: 'already-exists',
        detail: `Some targets already exist: ${collisions.join(', ')}`
      }
    }

    const results: FileBatchEntry[] = []
    for (const pair of pairs) {
      if (pair.skipped) {
        results.push({ path: pair.from, from: pair.from, to: pair.to, ok: true, skipped: true })
        continue
      }
      try {
        await resolved.backend.rename(pair.from, pair.to)
        results.push({ path: pair.from, from: pair.from, to: pair.to, ok: true })
      } catch (error) {
        results.push(this.batchFailure(pair.from, error, pair.to))
      }
    }
    return { status: 'ok', results }
  }

  async copyMany(
    sessionId: string,
    paths: readonly string[],
    destination: string
  ): Promise<FilesOutcome<FileBatchResult>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const normalized = this.normalizeMany(paths)
    if (normalized.status === 'unavailable') return normalized
    const targetDirectory = normalizeRelativePath(destination)
    if (targetDirectory === null) return outsideWorktree()
    const sources = collapseDescendantPaths(normalized.paths)
    for (const source of sources) {
      if (targetDirectory === source || targetDirectory.startsWith(`${source}/`)) {
        return {
          status: 'unavailable',
          reason: 'write-failed',
          detail: 'A folder cannot be copied into itself.'
        }
      }
    }
    const destinationProblem = await this.requireDirectory(
      resolved.backend,
      targetDirectory
    )
    if (destinationProblem !== null) return destinationProblem

    const results: FileBatchEntry[] = []
    for (const source of sources) {
      let kind: 'file' | 'directory'
      try {
        kind = (await resolved.backend.stat(source)).kind
      } catch (error) {
        results.push(this.batchFailure(source, error))
        continue
      }
      let copied: string | null = null
      for (let attempt = 0; attempt < 100 && copied === null; attempt += 1) {
        const name = incrementCopyName(basenameOf(source), kind === 'directory', attempt)
        const to = targetDirectory === '' ? name : `${targetDirectory}/${name}`
        try {
          await resolved.backend.copy(source, to)
          copied = to
        } catch (error) {
          if (error instanceof FileAccessError && error.reason === 'already-exists') continue
          results.push(this.batchFailure(source, error))
          break
        }
      }
      if (copied !== null) {
        results.push({ path: source, from: source, to: copied, ok: true })
      } else if (!results.some((entry) => entry.path === source)) {
        results.push({
          path: source,
          from: source,
          ok: false,
          reason: 'write-failed',
          detail: 'No available name was found for the copy.'
        })
      }
    }
    return { status: 'ok', results }
  }

  /**
   * Resolves paths for the system clipboard. Absolute paths use the host's own
   * dialect; relative paths use the worktree-relative `/` form.
   */
  async copyPaths(
    sessionId: string,
    paths: readonly string[],
    format: 'absolute' | 'relative'
  ): Promise<FilesOutcome<{ paths: string[] }>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const normalized = this.normalizeMany(paths)
    if (normalized.status === 'unavailable') return normalized
    const unique = [...new Set(normalized.paths)]
    if (format === 'relative') return { status: 'ok', paths: unique }
    return {
      status: 'ok',
      paths: unique.map((path) =>
        resolved.target.kind === 'local'
          ? join(resolved.worktreePath, path)
          : `${resolved.worktreePath.replace(/\/+$/u, '')}/${path}`
      )
    }
  }

  private normalizeMany(
    paths: readonly string[]
  ): { status: 'ok'; paths: string[] } | FilesUnavailable {
    if (paths.length === 0) {
      return {
        status: 'unavailable',
        reason: 'not-found',
        detail: 'No paths were selected.'
      }
    }
    const result: string[] = []
    for (const path of paths) {
      const relative = normalizeRelativePath(path)
      if (relative === null || relative === '') return outsideWorktree()
      result.push(relative)
    }
    return { status: 'ok', paths: result }
  }

  private async requireDirectory(
    backend: FileBackend,
    destination: string
  ): Promise<FilesUnavailable | null> {
    if (destination === '') return null
    try {
      const stat = await backend.stat(destination)
      if (stat.kind !== 'directory') {
        return {
          status: 'unavailable',
          reason: 'not-a-directory',
          detail: 'The destination is not a folder.'
        }
      }
      return null
    } catch (error) {
      if (error instanceof FileAccessError) {
        return { status: 'unavailable', reason: error.reason, detail: error.message }
      }
      return {
        status: 'unavailable',
        reason: 'unreadable',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private batchFailure(path: string, error: unknown, to?: string): FileBatchEntry {
    if (error instanceof FileAccessError) {
      return {
        path,
        ...(to === undefined ? {} : { from: path, to }),
        ok: false,
        reason: error.reason,
        detail: error.message
      }
    }
    return {
      path,
      ...(to === undefined ? {} : { from: path, to }),
      ok: false,
      reason: 'unreadable',
      detail: error instanceof Error ? error.message : String(error)
    }
  }

  async search(
    sessionId: string,
    query: string,
    options: Partial<FileSearchOptions> = {}
  ): Promise<FilesOutcome<FileSearchResult>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      return { status: 'ok', matches: [], truncated: false, scannedFiles: 0 }
    }
    this.searchControllers.get(sessionId)?.abort()
    const controller = new AbortController()
    this.searchControllers.set(sessionId, controller)
    try {
      const result = await resolved.backend.search(trimmed, {
        caseSensitive: options.caseSensitive === true,
        wholeWord: options.wholeWord === true,
        regex: options.regex === true,
        include: options.include ?? [],
        exclude: options.exclude ?? [],
        limit: Math.max(1, Math.min(options.limit ?? 200, 500)),
        signal: controller.signal
      })
      return { status: 'ok', ...result }
    } catch (error) {
      return this.mapError(error)
    } finally {
      if (this.searchControllers.get(sessionId) === controller) {
        this.searchControllers.delete(sessionId)
      }
    }
  }

  /** Stops the current search for a session; a newer search also does this. */
  cancelSearch(sessionId: string): boolean {
    const controller = this.searchControllers.get(sessionId)
    if (controller === undefined) return false
    controller.abort()
    this.searchControllers.delete(sessionId)
    return true
  }

  /**
   * Bounded literal replacement over the same surface as search.
   *
   * Each candidate file is read and written with its etag, so a file that
   * changed since the scan is skipped instead of overwritten.
   */
  async replace(
    sessionId: string,
    query: string,
    replacement: string,
    options: Partial<FileSearchOptions> & { paths?: readonly string[] } = {}
  ): Promise<FilesOutcome<FileReplaceResult>> {
    const resolved = await this.resolve(sessionId)
    if (resolved.status !== 'ok') return resolved
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      return {
        status: 'unavailable',
        reason: 'invalid-query',
        detail: 'Enter something to replace.'
      }
    }
    if (options.regex === true) {
      return {
        status: 'unavailable',
        reason: 'invalid-query',
        detail: 'Regex replace is not supported yet.'
      }
    }
    let found: FileSearchResult
    try {
      found = await resolved.backend.search(trimmed, {
        caseSensitive: options.caseSensitive === true,
        wholeWord: options.wholeWord === true,
        regex: false,
        include: options.include ?? [],
        exclude: options.exclude ?? [],
        limit: 4000
      })
    } catch (error) {
      return this.mapError(error)
    }
    const allowed =
      options.paths === undefined ? null : new Set(options.paths)
    const paths = [
      ...new Set(found.matches.map((match) => match.path))
    ].filter((path) => allowed === null || allowed.has(path))
    const results: FileReplaceEntry[] = []
    let replacements = 0
    let files = 0
    for (const path of paths) {
      try {
        const content = await resolved.backend.read(path)
        if (content.binary || content.tooLarge) {
          results.push({
            path,
            ok: false,
            replaced: 0,
            reason: content.tooLarge ? 'file-too-large' : 'binary',
            detail: content.tooLarge ? 'The file is too large to replace.' : 'The file is binary.'
          })
          continue
        }
        const replaced = replaceLiteralAll(content.text, trimmed, replacement, {
          caseSensitive: options.caseSensitive === true,
          wholeWord: options.wholeWord === true
        })
        if (replaced.count === 0) {
          results.push({ path, ok: true, replaced: 0 })
          continue
        }
        await resolved.backend.write(path, replaced.text, content.etag)
        files += 1
        replacements += replaced.count
        results.push({ path, ok: true, replaced: replaced.count })
      } catch (error) {
        const mapped = this.mapError(error)
        results.push({
          path,
          ok: false,
          replaced: 0,
          ...(mapped.status === 'unavailable'
            ? { reason: mapped.reason, detail: mapped.detail }
            : {})
        })
      }
    }
    return { status: 'ok', files, replacements, results, truncated: found.truncated }
  }

  private mapError(error: unknown): FilesOutcome<never> {
    if (error instanceof FileAccessError) {
      return {
        status: 'unavailable',
        reason: error.reason,
        detail: error.message,
        ...(error.currentEtag === undefined ? {} : { currentEtag: error.currentEtag })
      }
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

  private backendKey(
    worktreePath: string,
    target: import('../../shared/domain/repository').ExecutionTarget
  ): string {
    return target.kind === 'local'
      ? `local:${worktreePath}`
      : `wsl:${target.distro}\u0000${target.distroId ?? ''}\u0000${worktreePath}`
  }

  private backendFor(
    worktreePath: string,
    target: import('../../shared/domain/repository').ExecutionTarget
  ): FileBackend {
    if (this.deps.backendFor) return this.deps.backendFor(worktreePath, target)
    const key = this.backendKey(worktreePath, target)
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

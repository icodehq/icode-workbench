/**
 * Watches one session worktree while the Files pane is visible.
 *
 * This is deliberately separate from `GitStatusWatcherService`: Source Control
 * and Files are mutually exclusive tabs, so there is no steady-state duplicate
 * watch, and the Phase 8 Git watcher keeps its proven behaviour untouched.
 *
 * A local checkout is watched directly. A WSL worktree on a Windows drive is
 * watched through its translated Windows path, because Linux inotify on DrvFs
 * sees no events (Phase 0 measurement). An ext4 guest worktree has no watcher
 * yet; the renderer receives `unsupported-target` and polls while visible.
 */

import { relative } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import { canonicalWatchPath } from '../watch-path'
import {
  FILES_SKIP_DIRECTORIES,
  type FilesChangedEvent,
  type FilesWatchOutcome
} from '../../shared/domain/workspace-files'

export type FilesWatchTarget = {
  /** A path this process can watch: local, or a translated DrvFs drive path. */
  worktreePath: string
}

export type FilesWatchEvent = {
  type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir' | 'error'
  path: string
}

export type FilesWatchHandle = {
  close(): Promise<void>
}

export type FilesWatchFactory = (
  roots: readonly string[],
  options: {
    ignored: (path: string) => boolean
    onEvent: (event: FilesWatchEvent) => void
    onError: (error: unknown) => void
    onReady?: () => void
  }
) => FilesWatchHandle

export type WorkspaceFilesWatcherOptions = {
  /** Returns null when the host owning this worktree cannot be watched. */
  resolveTarget: (sessionId: string) => Promise<FilesWatchTarget | null>
  factory?: FilesWatchFactory
  debounceMs?: number
  maxPaths?: number
}

const IGNORED_DIRECTORIES = new Set<string>(FILES_SKIP_DIRECTORIES)

function isInside(parent: string, candidate: string): boolean {
  const normalizedParent = parent.replace(/[\\/]+$/u, '')
  return (
    candidate === normalizedParent ||
    candidate.startsWith(`${normalizedParent}/`) ||
    candidate.startsWith(`${normalizedParent}\\`)
  )
}

/** True when a path must not wake the Files pane. */
export function shouldIgnoreFilesWatchPath(path: string, worktreePath: string): boolean {
  const normalized = path.replace(/\\/gu, '/')
  const worktree = worktreePath.replace(/\\/gu, '/')
  // Chokidar asks about ancestors while walking to the root. Ignoring one would
  // skip the whole tree, so ancestors are never ignored.
  if (!isInside(worktree, normalized)) return false
  if (normalized === worktree) return false

  const relativePath = normalized.slice(worktree.length).replace(/^\/+/u, '')
  const segments = relativePath.split('/')
  const first = segments[0] ?? ''
  if (IGNORED_DIRECTORIES.has(first)) return true
  const name = segments[segments.length - 1] ?? ''
  if (name.endsWith('.swp') || name.endsWith('.tmp')) return true
  // Both backends stage writes beside the target; those files are an
  // implementation detail, not user content.
  if (segments.some((segment) => segment.includes('.icode-write-'))) return true
  return false
}

export function createChokidarFilesWatchFactory(): FilesWatchFactory {
  return (roots, options) => {
    const watcher = chokidarWatch([...roots], {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      ignored: options.ignored
    })
    watcher.on('all', (event, path) => {
      options.onEvent({ type: event as FilesWatchEvent['type'], path })
    })
    watcher.on('ready', () => options.onReady?.())
    watcher.on('error', (error) => options.onError(error))
    return {
      close: async () => {
        await watcher.close()
      }
    }
  }
}

type SessionWatch = {
  active: boolean
  timer: NodeJS.Timeout | null
  pending: Set<string>
  overflow: boolean
  revision: number
  target: FilesWatchTarget
}

/** One OS watch shared by every session running in the same checkout. */
type SharedWatch = {
  handle: FilesWatchHandle
  sessions: Set<string>
}

function watchKey(target: FilesWatchTarget): string {
  return target.worktreePath
}

export class WorkspaceFilesWatcherService {
  private readonly factory: FilesWatchFactory
  private readonly debounceMs: number
  private readonly maxPaths: number
  private readonly sessions = new Map<string, SessionWatch>()
  /** Last requested state; a slow resolve must not resurrect a stopped watch. */
  private readonly desired = new Map<string, number>()
  private readonly handles = new Map<string, SharedWatch>()
  private readonly listeners = new Set<(event: FilesChangedEvent) => void>()
  private token = 0

  constructor(private readonly options: WorkspaceFilesWatcherOptions) {
    this.factory = options.factory ?? createChokidarFilesWatchFactory()
    this.debounceMs = Math.max(50, options.debounceMs ?? 200)
    this.maxPaths = Math.max(1, options.maxPaths ?? 500)
  }

  subscribe(listener: (event: FilesChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Starts or stops watching for one session.
   *
   * `watching: false` is a truthful answer, not an error: the renderer keeps a
   * polling fallback for unsupported targets and failed watches.
   */
  async setActive(sessionId: string, active: boolean): Promise<FilesWatchOutcome> {
    if (!active) {
      this.desired.delete(sessionId)
      await this.stop(sessionId)
      return { watching: false, reason: 'cancelled' }
    }
    const existing = this.sessions.get(sessionId)
    if (existing?.active) return { watching: true }

    const token = ++this.token
    this.desired.set(sessionId, token)
    let target: FilesWatchTarget | null
    try {
      target = await this.options.resolveTarget(sessionId)
    } catch {
      target = null
    }
    if (this.desired.get(sessionId) !== token) {
      return { watching: false, reason: 'cancelled' }
    }
    if (target === null) {
      this.desired.delete(sessionId)
      return { watching: false, reason: 'unsupported-target' }
    }
    // Chokidar and libuv must agree on the spelling of the watched root; a
    // Windows 8.3 short name makes libuv abort the process. Canonicalize before
    // any ignore or relative-path logic sees the target.
    target = { worktreePath: canonicalWatchPath(target.worktreePath) }

    await this.stop(sessionId)
    const state: SessionWatch = {
      active: true,
      timer: null,
      pending: new Set(),
      overflow: false,
      revision: 0,
      target
    }
    this.sessions.set(sessionId, state)
    const key = watchKey(target)
    let shared = this.handles.get(key)
    const joinedExisting = shared !== undefined
    if (!shared) {
      try {
        shared = {
          handle: this.factory([target.worktreePath], {
            ignored: (path) => shouldIgnoreFilesWatchPath(path, target.worktreePath),
            onEvent: (event) => this.onTargetEvent(key, event),
            onError: () => this.failTarget(key),
            // A write that lands during chokidar's initial scan must not be lost.
            onReady: () => this.onTargetReady(key)
          }),
          sessions: new Set()
        }
      } catch {
        this.sessions.delete(sessionId)
        this.desired.delete(sessionId)
        return { watching: false, reason: 'watch-failed' }
      }
      this.handles.set(key, shared)
    }
    shared.sessions.add(sessionId)
    if (joinedExisting) {
      // The shared watch is already past its initial scan; the joining session
      // still needs one full read to match what is on disk.
      state.overflow = true
      this.schedule(sessionId, state)
    }
    return { watching: true }
  }

  async stopAll(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      this.desired.delete(sessionId)
      await this.stop(sessionId)
    }
  }

  activeSessions(): string[] {
    return [...this.sessions.entries()]
      .filter(([, state]) => state.active)
      .map(([sessionId]) => sessionId)
  }

  private onTargetEvent(key: string, event: FilesWatchEvent): void {
    const shared = this.handles.get(key)
    if (!shared) return
    if (event.type === 'error') {
      this.failTarget(key)
      return
    }
    for (const sessionId of [...shared.sessions]) {
      const state = this.sessions.get(sessionId)
      if (!state?.active) continue
      if (shouldIgnoreFilesWatchPath(event.path, state.target.worktreePath)) continue
      this.recordChange(state, event.path)
      this.schedule(sessionId, state)
    }
  }

  private onTargetReady(key: string): void {
    const shared = this.handles.get(key)
    if (!shared) return
    for (const sessionId of [...shared.sessions]) {
      const state = this.sessions.get(sessionId)
      if (!state?.active) continue
      // The scan itself may have raced a write; reconcile once after it settles.
      state.overflow = true
      this.schedule(sessionId, state)
    }
  }

  private recordChange(state: SessionWatch, path: string): void {
    const worktree = state.target.worktreePath.replace(/\\/gu, '/')
    const normalized = path.replace(/\\/gu, '/')
    if (!isInside(worktree, normalized)) return
    const relativePath = relative(worktree, normalized).replace(/\\/gu, '/')
    if (relativePath.length === 0 || relativePath.startsWith('..')) return
    if (state.pending.size < this.maxPaths) state.pending.add(relativePath)
    else state.overflow = true
  }

  private schedule(sessionId: string, state: SessionWatch): void {
    if (state.timer !== null) return
    state.timer = setTimeout(() => this.flush(sessionId), this.debounceMs)
  }

  private flush(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state?.active) return
    state.timer = null
    if (state.pending.size === 0 && !state.overflow) return
    state.revision += 1
    const event: FilesChangedEvent = {
      sessionId,
      revision: state.revision,
      changedPaths: [...state.pending],
      overflow: state.overflow
    }
    state.pending.clear()
    state.overflow = false
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // One renderer listener must not stop another window.
      }
    }
  }

  private failTarget(key: string): void {
    const shared = this.handles.get(key)
    if (!shared) return
    for (const sessionId of [...shared.sessions]) {
      const state = this.sessions.get(sessionId)
      if (!state) continue
      if (state.timer !== null) clearTimeout(state.timer)
      state.timer = null
      state.revision += 1
      const event: FilesChangedEvent = {
        sessionId,
        revision: state.revision,
        changedPaths: [],
        overflow: false,
        failed: true
      }
      for (const listener of this.listeners) {
        try {
          listener(event)
        } catch {
          // ignore
        }
      }
      void this.stop(sessionId)
    }
  }

  private async stop(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    this.sessions.delete(sessionId)
    state.active = false
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = null
    state.pending.clear()
    const key = watchKey(state.target)
    const shared = this.handles.get(key)
    if (!shared) return
    shared.sessions.delete(sessionId)
    if (shared.sessions.size > 0) return
    // Last session out: the physical watch has no remaining consumer.
    this.handles.delete(key)
    try {
      await shared.handle.close()
    } catch {
      // The OS watcher may already be gone; stopping is best effort.
    }
  }
}

/**
 * Watches one worktree and its Git directory while Changes is visible.
 *
 * Phase 0 measured that native filesystem notifications are the only cheap way
 * to notice an Agent's writes; polling every two seconds was the old fallback.
 * The watcher deliberately emits one coalesced event per window instead of one
 * per file, and never watches `objects`, dependency folders or lock files.
 */

import { relative } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import { GENERATED_IGNORE_PATTERNS } from '../repositories/first-commit'
import { canonicalWatchPath } from '../watch-path'
import type { GitStatusWatchEvent } from '../../shared/domain/git-workspace'

export type WatchTarget = {
  worktreePath: string
  /** Common Git directory; also contains linked-worktree metadata. */
  gitDir: string
}

export type GitStatusChangeEvent = GitStatusWatchEvent

export type WatchEvent = {
  type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir' | 'error'
  path: string
}

export type WatchHandle = {
  close(): Promise<void>
}

export type WatchFactory = (
  roots: readonly string[],
  options: {
    ignored: (path: string) => boolean
    onEvent: (event: WatchEvent) => void
    onError: (error: unknown) => void
    onReady?: () => void
  }
) => WatchHandle

export type GitStatusWatcherOptions = {
  resolveTarget: (sessionId: string) => Promise<WatchTarget | null>
  factory?: WatchFactory
  debounceMs?: number
  maxPaths?: number
}

const IGNORED_DIRECTORIES = new Set(
  GENERATED_IGNORE_PATTERNS.map((pattern) => pattern.replace(/\/$/u, ''))
)

function isInside(parent: string, candidate: string): boolean {
  const normalizedParent = parent.replace(/[\\/]+$/u, '')
  return candidate === normalizedParent || candidate.startsWith(`${normalizedParent}/`) || candidate.startsWith(`${normalizedParent}\\`)
}

/** True when a path must not wake the status reader. */
export function shouldIgnoreWatchPath(path: string, target: WatchTarget): boolean {
  const normalized = path.replace(/\\/gu, '/')
  const worktree = target.worktreePath.replace(/\\/gu, '/')
  const gitDir = target.gitDir.replace(/\\/gu, '/')

  // The Git directory is checked first: a primary worktree's `.git` lives
  // inside the worktree, but index/HEAD/operation markers there are exactly the
  // metadata changes the watcher must see.
  if (isInside(gitDir, normalized)) {
    const relativePath = normalized.slice(gitDir.length).replace(/^\/+/u, '')
    const first = relativePath.split('/')[0] ?? ''
    // Objects and reflogs are large and do not affect a status snapshot.
    if (first === 'objects' || first === 'logs' || first === 'lfs') return true
    if (relativePath.endsWith('.lock') || relativePath.endsWith('.tmp')) return true
    if (relativePath.startsWith('next-index-') || relativePath.startsWith('watchman-')) return true
    return false
  }
  if (isInside(`${worktree}/.git`, normalized)) return true
  if (isInside(worktree, normalized)) {
    const relativePath = normalized.slice(worktree.length).replace(/^\/+/u, '')
    const first = relativePath.split('/')[0] ?? ''
    if (IGNORED_DIRECTORIES.has(first)) return true
    if (relativePath.endsWith('.swp') || relativePath.endsWith('.tmp')) return true
    return false
  }
  // An ancestor of a root (or any unrelated path) must not be ignored: chokidar
  // asks about parents while walking to the root, and ignoring one would skip
  // the entire tree. Chokidar never emits events outside the roots anyway.
  return false
}

export function createChokidarWatchFactory(): WatchFactory {
  return (roots, options) => {
    const watcher = chokidarWatch([...roots], {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      ignored: options.ignored
    })
    watcher.on('all', (event, path) => {
      options.onEvent({ type: event as WatchEvent['type'], path })
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
  metadataChanged: boolean
  revision: number
  target: WatchTarget
}

/**
 * One OS watch shared by every session in the same checkout.
 *
 * Sessions sharing a worktree must not each open their own chokidar tree; the
 * physical watch is refcounted by the set, while pending paths and revisions
 * stay per session so each pane receives its own event.
 */
type SharedWatch = {
  handle: WatchHandle
  sessions: Set<string>
}

function watchKey(target: WatchTarget): string {
  return `${target.worktreePath}\u0000${target.gitDir}`
}

export class GitStatusWatcherService {
  private readonly factory: WatchFactory
  private readonly debounceMs: number
  private readonly maxPaths: number
  private readonly sessions = new Map<string, SessionWatch>()
  private readonly desired = new Map<string, number>()
  private readonly handles = new Map<string, SharedWatch>()
  private readonly listeners = new Set<(event: GitStatusChangeEvent) => void>()
  private token = 0

  constructor(private readonly options: GitStatusWatcherOptions) {
    this.factory = options.factory ?? createChokidarWatchFactory()
    this.debounceMs = Math.max(50, options.debounceMs ?? 800)
    this.maxPaths = Math.max(1, options.maxPaths ?? 500)
  }

  subscribe(listener: (event: GitStatusChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Starts or stops watching for one session.
   *
   * Returns `watching: false` for an unsupported target (today a WSL worktree)
   * so the renderer keeps its polling fallback instead of going stale.
   */
  async setActive(
    sessionId: string,
    active: boolean
  ): Promise<{ watching: boolean; reason?: 'unsupported-target' | 'watch-failed' | 'cancelled' }> {
    if (!active) {
      this.desired.delete(sessionId)
      await this.stop(sessionId)
      return { watching: false }
    }
    const existing = this.sessions.get(sessionId)
    if (existing?.active) return { watching: true }

    const token = ++this.token
    this.desired.set(sessionId, token)
    let target: WatchTarget | null
    try {
      target = await this.options.resolveTarget(sessionId)
    } catch {
      target = null
    }
    if (this.desired.get(sessionId) !== token) return { watching: false, reason: 'cancelled' }
    if (target === null) {
      this.desired.delete(sessionId)
      return { watching: false, reason: 'unsupported-target' }
    }
    // Chokidar and libuv must agree on the spelling of the watched root; a
    // Windows 8.3 short name makes libuv abort the process. Canonicalize before
    // any ignore or relative-path logic sees the target.
    target = {
      worktreePath: canonicalWatchPath(target.worktreePath),
      gitDir: canonicalWatchPath(target.gitDir)
    }

    await this.stop(sessionId)
    const state: SessionWatch = {
      active: true,
      timer: null,
      pending: new Set(),
      overflow: false,
      metadataChanged: false,
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
          handle: this.factory([target.worktreePath, target.gitDir], {
            ignored: (path) => shouldIgnoreWatchPath(path, target),
            onEvent: (event) => this.onTargetEvent(key, event),
            onError: () => this.failTarget(key),
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
      // An already-running watch will not emit `ready` again, so the joining
      // session schedules its own initial read instead of waiting forever.
      state.metadataChanged = true
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
    return [...this.sessions.values()].filter((state) => state.active).length > 0
      ? [...this.sessions.entries()].filter(([, state]) => state.active).map(([id]) => id)
      : []
  }

  private onTargetEvent(key: string, event: WatchEvent): void {
    const shared = this.handles.get(key)
    if (!shared) return
    if (event.type === 'error') {
      this.failTarget(key)
      return
    }
    for (const sessionId of [...shared.sessions]) {
      const state = this.sessions.get(sessionId)
      if (!state?.active) continue
      if (shouldIgnoreWatchPath(event.path, state.target)) continue
      this.recordChange(state, event.path)
      this.schedule(sessionId, state)
    }
  }

  /**
   * The initial chokidar scan takes a moment. A write that lands while it runs
   * must not be lost, so becoming ready schedules one normal status read.
   */
  private onTargetReady(key: string): void {
    const shared = this.handles.get(key)
    if (!shared) return
    for (const sessionId of [...shared.sessions]) {
      const state = this.sessions.get(sessionId)
      if (!state?.active) continue
      state.metadataChanged = true
      this.schedule(sessionId, state)
    }
  }

  private recordChange(state: SessionWatch, path: string): void {
    const worktree = state.target.worktreePath.replace(/\\/gu, '/')
    const gitDir = state.target.gitDir.replace(/\\/gu, '/')
    const normalized = path.replace(/\\/gu, '/')
    if (isInside(gitDir, normalized)) {
      // The primary worktree's Git directory is inside the worktree, so this
      // check must come before the relative-path branch.
      state.metadataChanged = true
    } else if (isInside(worktree, normalized)) {
      const relativePath = relative(worktree, normalized).replace(/\\/gu, '/')
      if (relativePath.length > 0 && !relativePath.startsWith('..')) {
        if (state.pending.size < this.maxPaths) state.pending.add(relativePath)
        else state.overflow = true
      }
    } else {
      state.metadataChanged = true
    }
  }

  private schedule(sessionId: string, state: SessionWatch): void {
    if (state.timer !== null) return
    state.timer = setTimeout(() => this.flush(sessionId), this.debounceMs)
  }

  private flush(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state?.active) return
    state.timer = null
    if (state.pending.size === 0 && !state.metadataChanged) return
    state.revision += 1
    const event: GitStatusChangeEvent = {
      sessionId,
      revision: state.revision,
      changedPaths: [...state.pending],
      overflow: state.overflow,
      metadataChanged: state.metadataChanged
    }
    state.pending.clear()
    state.overflow = false
    state.metadataChanged = false
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A renderer/event consumer must not stop the watcher or another window.
      }
    }
  }

  private failTarget(key: string): void {
    const shared = this.handles.get(key)
    if (!shared) return
    for (const sessionId of [...shared.sessions]) {
      const state = this.sessions.get(sessionId)
      if (!state) continue
      this.emitFailed(sessionId, state)
      void this.stop(sessionId)
    }
  }

  private emitFailed(sessionId: string, state: SessionWatch): void {
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = null
    state.revision += 1
    for (const listener of this.listeners) {
      try {
        listener({
          sessionId,
          revision: state.revision,
          changedPaths: [],
          overflow: false,
          metadataChanged: true,
          failed: true
        })
      } catch {
        // ignore
      }
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

/**
 * Watches one worktree and its Git directory while Changes is visible.
 *
 * The physical watch lives in the watcher child. This service keeps the cheap,
 * per-session state: desired tokens, the metadata flag, coalescing, revision
 * counters, and the renderer payload. Only local targets reach it — WSL
 * repositories poll from the renderer, which is why the resolver gates on the
 * persisted execution target before any guest call.
 */

import { relative } from 'node:path'
import { canonicalWatchPath } from '../watch-path'
import {
  GIT_WATCH_SKIP_DIRECTORIES,
  isInsideWatchRoot,
  shouldIgnoreWatchPath
} from '../../shared/domain/watch-ignore'
import type { GitStatusWatchEvent } from '../../shared/domain/git-workspace'
import type { SerializedWatchSpec } from '../../shared/watch-protocol'
import type { WatchClient, WatchEvent } from '../watch/watch-client'

export { shouldIgnoreWatchPath } from '../../shared/domain/watch-ignore'

export type WatchTarget = {
  worktreePath: string
  /** Common Git directory; also contains linked-worktree metadata. */
  gitDir: string
}

export type GitStatusChangeEvent = GitStatusWatchEvent

export type GitStatusWatcherOptions = {
  resolveTarget: (sessionId: string) => Promise<WatchTarget | null>
  client: WatchClient
  debounceMs?: number
  maxPaths?: number
}

const IGNORED_SUFFIXES = ['.swp', '.tmp']

function gitSpec(sessionId: string, target: WatchTarget): SerializedWatchSpec {
  return {
    kind: 'recursive',
    id: `git:${sessionId}`,
    roots: [target.worktreePath, target.gitDir],
    worktreePath: target.worktreePath,
    ignore: {
      skipDirectories: [...GIT_WATCH_SKIP_DIRECTORIES],
      skipSuffixes: IGNORED_SUFFIXES,
      stagingMarker: null
    },
    git: { worktreePath: target.worktreePath, gitDir: target.gitDir }
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
  subId: string
}

export class GitStatusWatcherService {
  private readonly client: WatchClient
  private readonly debounceMs: number
  private readonly maxPaths: number
  private readonly sessions = new Map<string, SessionWatch>()
  private readonly desired = new Map<string, number>()
  private readonly listeners = new Set<(event: GitStatusChangeEvent) => void>()
  private token = 0

  constructor(private readonly options: GitStatusWatcherOptions) {
    this.client = options.client
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
   * Returns `watching: false` for an unsupported target (a WSL checkout) so the
   * renderer keeps its polling fallback instead of going stale.
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
      target,
      subId: `git:${sessionId}`
    }
    this.sessions.set(sessionId, state)
    const result = await this.client.subscribe(gitSpec(sessionId, target), {
      onEvents: (events) => this.onEvents(sessionId, events),
      onOverflow: () => this.onOverflow(sessionId),
      onReady: () => this.onReady(sessionId),
      onError: () => this.failSession(sessionId)
    })
    if (this.desired.get(sessionId) !== token) {
      this.sessions.delete(sessionId)
      await this.client.unsubscribe(state.subId)
      return { watching: false, reason: 'cancelled' }
    }
    if (!result.ok) {
      this.sessions.delete(sessionId)
      this.desired.delete(sessionId)
      return { watching: false, reason: 'watch-failed' }
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

  /** Diagnostics for the perf probe; not part of the IPC contract. */
  stats(): { activeSessions: number; subscriptions: number } {
    return {
      activeSessions: this.activeSessions().length,
      subscriptions: this.sessions.size
    }
  }

  private onEvents(sessionId: string, events: readonly WatchEvent[]): void {
    const state = this.sessions.get(sessionId)
    if (!state?.active) return
    let changed = false
    for (const event of events) {
      if (shouldIgnoreWatchPath(event.path, state.target)) continue
      this.recordChange(state, event.path)
      changed = true
    }
    if (changed) this.schedule(sessionId, state)
  }

  private onOverflow(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state?.active) return
    state.overflow = true
    this.schedule(sessionId, state)
  }

  /**
   * The initial scan takes a moment. A write that lands while it runs must not
   * be lost, so becoming ready schedules one normal status read.
   */
  private onReady(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state?.active) return
    state.metadataChanged = true
    this.schedule(sessionId, state)
  }

  private recordChange(state: SessionWatch, path: string): void {
    const worktree = state.target.worktreePath.replace(/\\/gu, '/')
    const gitDir = state.target.gitDir.replace(/\\/gu, '/')
    const normalized = path.replace(/\\/gu, '/')
    if (isInsideWatchRoot(gitDir, normalized)) {
      // The primary worktree's Git directory is inside the worktree, so this
      // check must come before the relative-path branch.
      state.metadataChanged = true
    } else if (isInsideWatchRoot(worktree, normalized)) {
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

  private failSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
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
    void this.stop(sessionId)
  }

  private async stop(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    this.sessions.delete(sessionId)
    state.active = false
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = null
    state.pending.clear()
    await this.client.unsubscribe(state.subId).catch(() => undefined)
  }
}

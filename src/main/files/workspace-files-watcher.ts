/**
 * Watches one session worktree while the Files pane is visible.
 *
 * The physical watch lives in the watcher child; this service owns the parts
 * that must be per session and cheap: the desired-state token, debounce,
 * coalescing, the revision counter, and the renderer event payload. It never
 * imports a watcher backend, so a backend failure cannot reach the main thread.
 *
 * Only local targets reach this service: `createWatchTargetResolvers` returns
 * null for every WSL checkout before any guest call, and the renderer polls.
 */

import { relative } from 'node:path'
import { canonicalWatchPath } from '../watch-path'
import {
  FILES_WATCH_SKIP_DIRECTORIES,
  shouldIgnoreFilesWatchPath
} from '../../shared/domain/watch-ignore'
import type {
  FilesChangedEvent,
  FilesWatchOutcome
} from '../../shared/domain/workspace-files'
import type { SerializedWatchSpec } from '../../shared/watch-protocol'
import type { WatchClient, WatchEvent } from '../watch/watch-client'

export { shouldIgnoreFilesWatchPath } from '../../shared/domain/watch-ignore'

export type FilesWatchTarget = {
  /** A local path this machine can watch. */
  worktreePath: string
}

export type WorkspaceFilesWatcherOptions = {
  /** Returns null when the checkout cannot be watched on this machine. */
  resolveTarget: (sessionId: string) => Promise<FilesWatchTarget | null>
  client: WatchClient
  debounceMs?: number
  maxPaths?: number
}

function isInside(parent: string, candidate: string): boolean {
  const normalizedParent = parent.replace(/[\\/]+$/u, '')
  return (
    candidate === normalizedParent ||
    candidate.startsWith(`${normalizedParent}/`) ||
    candidate.startsWith(`${normalizedParent}\\`)
  )
}

function filesSpec(sessionId: string, worktreePath: string): SerializedWatchSpec {
  return {
    kind: 'recursive',
    id: `files:${sessionId}`,
    roots: [worktreePath],
    worktreePath,
    ignore: {
      skipDirectories: [...FILES_WATCH_SKIP_DIRECTORIES],
      skipSuffixes: ['.swp', '.tmp'],
      stagingMarker: '.icode-write-'
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
  subId: string
}

export class WorkspaceFilesWatcherService {
  private readonly client: WatchClient
  private readonly debounceMs: number
  private readonly maxPaths: number
  private readonly sessions = new Map<string, SessionWatch>()
  /** Last requested state; a slow resolve must not resurrect a stopped watch. */
  private readonly desired = new Map<string, number>()
  private readonly listeners = new Set<(event: FilesChangedEvent) => void>()
  private token = 0

  constructor(private readonly options: WorkspaceFilesWatcherOptions) {
    this.client = options.client
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
    // The child canonicalizes again before binding; doing it here keeps the
    // relative-path arithmetic and the spec in one spelling.
    target = { worktreePath: canonicalWatchPath(target.worktreePath) }

    await this.stop(sessionId)
    const state: SessionWatch = {
      active: true,
      timer: null,
      pending: new Set(),
      overflow: false,
      revision: 0,
      target,
      subId: `files:${sessionId}`
    }
    // The state and handlers exist before the subscribe round trip: an initial
    // event or `ready` must not be dropped while the ack is in flight.
    this.sessions.set(sessionId, state)
    const result = await this.client.subscribe(filesSpec(sessionId, target.worktreePath), {
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

  private onEvents(sessionId: string, events: readonly WatchEvent[]): void {
    const state = this.sessions.get(sessionId)
    if (!state?.active) return
    let changed = false
    for (const event of events) {
      if (shouldIgnoreFilesWatchPath(event.path, state.target.worktreePath)) continue
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

  private onReady(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state?.active) return
    // The scan itself may have raced a write; reconcile once after it settles.
    state.overflow = true
    this.schedule(sessionId, state)
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

  private failSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
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

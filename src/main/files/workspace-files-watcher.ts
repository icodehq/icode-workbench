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

import { join, relative } from 'node:path'
import { canonicalWatchPath } from '../watch-path'
import {
  FILES_SKIP_DIRECTORIES,
  FILES_WATCH_MAX_ROOTS,
  normalizeRelativePath,
  type FilesChangedEvent,
  type FilesWatchOutcome
} from '../../shared/domain/workspace-files'
import { shouldIgnoreFilesWatchPath } from '../../shared/domain/watch-ignore'
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

/**
 * Turns the renderer's visible folders into absolute watch roots.
 *
 * The root is always included. Absolute paths, traversal segments, and folders
 * the Files pane never lists are dropped rather than trusted; the list is
 * deduped and capped before it reaches the watcher child.
 */
function resolveAbsoluteRoots(
  worktreePath: string,
  roots: readonly string[] | undefined
): string[] {
  const relativeRoots = new Set<string>([''])
  for (const raw of roots ?? []) {
    const normalized = normalizeRelativePath(raw)
    if (normalized === null) continue
    if (normalized !== '') {
      const segments = normalized.split('/')
      if (segments.some((segment) => (FILES_SKIP_DIRECTORIES as readonly string[]).includes(segment))) {
        continue
      }
    }
    relativeRoots.add(normalized)
    if (relativeRoots.size >= FILES_WATCH_MAX_ROOTS) break
  }
  return [...relativeRoots]
    .sort()
    .map((root) => (root === '' ? worktreePath : join(worktreePath, root)))
}

function filesSpec(
  sessionId: string,
  worktreePath: string,
  roots: readonly string[]
): SerializedWatchSpec {
  return {
    kind: 'shallow',
    id: `files:${sessionId}`,
    roots: [...roots],
    worktreePath,
    ignore: {
      skipDirectories: [...FILES_SKIP_DIRECTORIES],
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
  roots: string[]
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
  async setActive(
    sessionId: string,
    active: boolean,
    roots?: readonly string[]
  ): Promise<FilesWatchOutcome> {
    if (!active) {
      this.desired.delete(sessionId)
      await this.stop(sessionId)
      return { watching: false, reason: 'cancelled' }
    }
    const existing = this.sessions.get(sessionId)
    if (existing?.active) {
      if (roots === undefined) return { watching: true }
      const nextRoots = resolveAbsoluteRoots(existing.target.worktreePath, roots)
      const updated = await this.client.updateRoots(existing.subId, nextRoots)
      if (!updated.ok) {
        this.failSession(sessionId)
        return { watching: false, reason: 'watch-failed' }
      }
      existing.roots = nextRoots
      // A directory may have changed while its watch was being bound.
      existing.overflow = true
      this.schedule(sessionId, existing)
      return { watching: true }
    }

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
    const watchRoots = resolveAbsoluteRoots(target.worktreePath, roots)

    await this.stop(sessionId)
    const state: SessionWatch = {
      active: true,
      timer: null,
      pending: new Set(),
      overflow: false,
      revision: 0,
      target,
      subId: `files:${sessionId}`,
      roots: watchRoots
    }
    // The state and handlers exist before the subscribe round trip: an initial
    // event or `ready` must not be dropped while the ack is in flight.
    this.sessions.set(sessionId, state)
    const result = await this.client.subscribe(
      filesSpec(sessionId, target.worktreePath, watchRoots),
      {
        onEvents: (events) => this.onEvents(sessionId, events),
        onOverflow: () => this.onOverflow(sessionId),
        onReady: () => this.onReady(sessionId),
        onError: () => this.failSession(sessionId)
      }
    )
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
  stats(): { activeSessions: number; subscriptions: number; roots: number } {
    let roots = 0
    for (const state of this.sessions.values()) roots += state.roots.length
    return {
      activeSessions: this.activeSessions().length,
      subscriptions: this.sessions.size,
      roots
    }
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

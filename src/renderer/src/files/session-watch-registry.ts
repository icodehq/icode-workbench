import { useSyncExternalStore } from 'react'
import type { LiveState } from './use-files-live'

/**
 * The session's single files-watch owner lives in `SessionFilesWatchHost`.
 * The tree contributes what it can display (its expanded folders and whether
 * the pane is visible) and the host owns the one IPC subscription, root set,
 * polling fallback and tab reconciliation.
 *
 * Main keeps one watcher per session, so a second renderer consumer would
 * replace this one's roots or stop it on unmount. Everything therefore talks
 * to this registry instead of calling `window.icode.files.watch`.
 */

type RootState = 'loading' | 'ready' | 'unavailable'

export type SessionTreeWatchState = {
  /** The Files tree is the visible inspector pane. */
  visible: boolean
  /** Expanded folders, as the tree's `path -> open` map. */
  expanded: Record<string, boolean>
  /** Reloads the tree's expanded folders after a watcher tick. */
  reloadExpanded: () => Promise<void>
  rootState: RootState
}

const treeStates = new Map<string, SessionTreeWatchState>()
const liveStates = new Map<string, LiveState>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setSessionTreeWatch(
  sessionId: string,
  state: SessionTreeWatchState | null
): void {
  if (state === null) {
    if (!treeStates.delete(sessionId)) return
  } else {
    treeStates.set(sessionId, state)
  }
  emit()
}

export function getSessionTreeWatch(sessionId: string): SessionTreeWatchState | null {
  return treeStates.get(sessionId) ?? null
}

export function setSessionLiveState(sessionId: string, state: LiveState): void {
  if (liveStates.get(sessionId) === state) return
  liveStates.set(sessionId, state)
  emit()
}

export function getSessionLiveState(sessionId: string): LiveState {
  return liveStates.get(sessionId) ?? 'off'
}

export function useSessionTreeWatch(sessionId: string): SessionTreeWatchState | null {
  const snapshot = (): SessionTreeWatchState | null => treeStates.get(sessionId) ?? null
  return useSyncExternalStore(subscribe, snapshot, () => null)
}

export function useSessionLiveState(sessionId: string | null): LiveState {
  const snapshot = (): LiveState =>
    sessionId === null ? 'off' : (liveStates.get(sessionId) ?? 'off')
  return useSyncExternalStore(subscribe, snapshot, () => 'off')
}

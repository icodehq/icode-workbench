/**
 * Renderer-side command registry for the split view.
 *
 * The command palette lives at the app shell, while the split tree lives in the
 * active sessions surface. The surface registers its actions here, and the
 * palette renders whatever the active session exposes — the same pattern the
 * Source Control commands use.
 */

import { useSyncExternalStore } from 'react'

export type SplitCommandId =
  | 'split.left'
  | 'split.right'
  | 'split.up'
  | 'split.down'
  | 'split.zoom'
  | 'split.close'

export type SplitCommandEntry = {
  sessionId: string
  enabled: boolean
  disabledReason?: string
  run: () => void
}

export type SplitCommandSnapshot = Readonly<
  Partial<Record<SplitCommandId, Omit<SplitCommandEntry, 'run'>>>
>

type Registered = SplitCommandEntry & { token: object }

const entries = new Map<SplitCommandId, Registered>()
const listeners = new Set<() => void>()
let snapshot: SplitCommandSnapshot = {}

function publish(): void {
  const next: Partial<Record<SplitCommandId, Omit<SplitCommandEntry, 'run'>>> = {}
  for (const [id, entry] of entries) {
    next[id] = {
      sessionId: entry.sessionId,
      enabled: entry.enabled,
      ...(entry.disabledReason === undefined ? {} : { disabledReason: entry.disabledReason })
    }
  }
  snapshot = next
  for (const listener of listeners) listener()
}

/** Registers one command and returns its unregister function. */
export function registerSplitCommand(id: SplitCommandId, entry: SplitCommandEntry): () => void {
  const token = {}
  entries.set(id, { ...entry, token })
  publish()
  return () => {
    if (entries.get(id)?.token !== token) return
    entries.delete(id)
    publish()
  }
}

export function subscribeSplitCommands(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSplitCommandSnapshot(): SplitCommandSnapshot {
  return snapshot
}

/** Runs a command only when it is enabled for the expected session. */
export function runSplitCommand(id: SplitCommandId, sessionId?: string): boolean {
  const entry = entries.get(id)
  if (entry === undefined || !entry.enabled) return false
  if (sessionId !== undefined && entry.sessionId !== sessionId) return false
  entry.run()
  return true
}

export function useSplitCommandSnapshot(): SplitCommandSnapshot {
  return useSyncExternalStore(
    subscribeSplitCommands,
    getSplitCommandSnapshot,
    getSplitCommandSnapshot
  )
}

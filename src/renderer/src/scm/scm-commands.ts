/**
 * Renderer-side command registry for Source Control.
 *
 * The command palette lives at the app shell, while the Git controller lives in
 * the active session's Changes panel. Components register their command
 * handlers here, and the palette renders whatever the active session exposes.
 * Ids follow VS Code's built-in Git commands so muscle memory and palette
 * searches both line up.
 */

import { useSyncExternalStore } from 'react'

export type ScmCommandId =
  | 'git.commit'
  | 'git.commitAll'
  | 'git.refresh'
  | 'git.stageAll'
  | 'git.unstageAll'
  | 'git.discardAll'
  | 'git.pull'
  | 'git.push'
  | 'git.sync'
  | 'git.publish'
  | 'git.merge'
  | 'git.pushTo'
  | 'git.viewHistory'
  | 'git.continueOperation'
  | 'git.abortOperation'

export type ScmCommandEntry = {
  sessionId: string
  enabled: boolean
  disabledReason?: string
  run: () => void
}

export type ScmCommandSnapshot = Readonly<
  Partial<Record<ScmCommandId, Omit<ScmCommandEntry, 'run'>>>
>

type Registered = ScmCommandEntry & { token: object }

const entries = new Map<ScmCommandId, Registered>()
const listeners = new Set<() => void>()
let snapshot: ScmCommandSnapshot = {}

function publish(): void {
  const next: Partial<Record<ScmCommandId, Omit<ScmCommandEntry, 'run'>>> = {}
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
export function registerScmCommand(id: ScmCommandId, entry: ScmCommandEntry): () => void {
  const token = {}
  entries.set(id, { ...entry, token })
  publish()
  return () => {
    if (entries.get(id)?.token !== token) return
    entries.delete(id)
    publish()
  }
}

export function subscribeScmCommands(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getScmCommandSnapshot(): ScmCommandSnapshot {
  return snapshot
}

/**
 * Runs a command only when it is enabled for the expected session. Returns
 * false when the command was unavailable, so callers can leave the palette open.
 */
export function runScmCommand(id: ScmCommandId, sessionId?: string): boolean {
  const entry = entries.get(id)
  if (entry === undefined || !entry.enabled) return false
  if (sessionId !== undefined && entry.sessionId !== sessionId) return false
  entry.run()
  return true
}

export function useScmCommandSnapshot(): ScmCommandSnapshot {
  return useSyncExternalStore(
    subscribeScmCommands,
    getScmCommandSnapshot,
    getScmCommandSnapshot
  )
}

import { useSyncExternalStore } from 'react'
import type { AppError } from '../../../shared/domain/errors'
import type { UpdateLiveSession, UpdateState } from '../../../shared/schemas/updates'

/**
 * Persistent update state for the shell. Unlike `NoticeToast`, this state must
 * survive across surfaces and must not auto-dismiss.
 */

export type UpdateRestartPrompt = {
  version: string
  liveSessions: UpdateLiveSession[]
}

let state: UpdateState | null = null
let dismissedVersion: string | null = null
let restartPrompt: UpdateRestartPrompt | null = null
let bootstrapped = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function setUpdateState(next: UpdateState): void {
  state = next
  emit()
}

function applyError(error: AppError): void {
  if (state === null) return
  state = { ...state, phase: 'error', error }
  emit()
}

export function getUpdateState(): UpdateState | null {
  return state
}

export function getDismissedUpdateVersion(): string | null {
  return dismissedVersion
}

export function getUpdateRestartPrompt(): UpdateRestartPrompt | null {
  return restartPrompt
}

export function subscribeUpdates(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUpdateState(): UpdateState | null {
  return useSyncExternalStore(subscribeUpdates, getUpdateState, () => null)
}

export function useDismissedUpdateVersion(): string | null {
  return useSyncExternalStore(subscribeUpdates, getDismissedUpdateVersion, () => null)
}

export function useUpdateRestartPrompt(): UpdateRestartPrompt | null {
  return useSyncExternalStore(subscribeUpdates, getUpdateRestartPrompt, () => null)
}

/** One-time bridge from main's push channel plus the initial snapshot. */
export function bootstrapUpdates(): void {
  if (bootstrapped) return
  bootstrapped = true
  window.icode.updates.onChanged((next) => setUpdateState(next))
  void window.icode.updates
    .get()
    .then((result) => {
      // A push may have arrived before this snapshot resolved; never replace a
      // newer pushed state with the earlier read.
      if (result.ok && state === null) setUpdateState(result.value)
    })
    .catch(() => undefined)
}

export function dismissUpdate(version: string | null): void {
  dismissedVersion = version
  emit()
}

export async function checkForUpdates(): Promise<void> {
  const result = await window.icode.updates.check()
  if (result.ok) setUpdateState(result.value)
  else applyError(result.error)
}

export async function downloadUpdate(): Promise<void> {
  const result = await window.icode.updates.download()
  if (result.ok) setUpdateState(result.value)
  else applyError(result.error)
}

export async function skipUpdateVersion(version: string | null): Promise<void> {
  const result = await window.icode.updates.skip({ version })
  if (result.ok) setUpdateState(result.value)
  else applyError(result.error)
}

export async function setUpdateAutoCheck(enabled: boolean): Promise<void> {
  const result = await window.icode.updates.setAutoCheck({ enabled })
  if (result.ok) setUpdateState(result.value)
  else applyError(result.error)
}

export async function requestUpdateInstall(): Promise<void> {
  restartPrompt = null
  emit()
  const result = await window.icode.updates.install({})
  if (!result.ok) {
    applyError(result.error)
    return
  }
  if (result.value.status === 'confirmation-required') {
    restartPrompt = {
      version: result.value.version,
      liveSessions: result.value.liveSessions
    }
    emit()
    return
  }
  if (result.value.status === 'blocked') applyError(result.value.error)
}

export async function confirmUpdateInstall(): Promise<void> {
  restartPrompt = null
  emit()
  const result = await window.icode.updates.install({ stopLiveSessions: true })
  if (!result.ok) applyError(result.error)
  else if (result.value.status === 'blocked') applyError(result.value.error)
}

export function cancelUpdateInstall(): void {
  restartPrompt = null
  emit()
}

export function openUpdateDownload(url: string): void {
  void window.icode.window.openExternal({ url })
}

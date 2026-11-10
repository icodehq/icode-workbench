import { harnessLabel, type HarnessId } from '../../../shared/domain/harness'
import { normalizeSessionTitle } from '../../../shared/domain/session'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import { translate } from '../i18n/i18n-store'

/**
 * A create request that has been accepted by the UI but has not produced a
 * session row yet.
 *
 * Deliberately not a `SessionSummary`: the main process owns the real id, and a
 * synthetic row would flow into selection, pane mounting, project statistics and
 * localStorage. This descriptor is presentation-only and lives outside the
 * workspace reducer, so a `sessionsLoaded` refresh cannot wipe it.
 */
export type PendingCreateRequest = {
  repoId: string
  harness: HarnessId
  title?: string
}

export type PendingCreate = {
  /** Per-submit nonce; makes clearing race-safe when a second create starts. */
  id: string
  request: PendingCreateRequest
  repoId: string
  harness: HarnessId
  /** Effective title, normalized the same way the main process does. */
  title: string
  /** Renderer clock at submit, used to hide the pending surface once the real row exists. */
  startedAt: number
}

let nextNonce = 0

function nextId(now: number): string {
  nextNonce += 1
  return `pending-create-${String(now)}-${String(nextNonce)}`
}

export function createPendingCreate(
  input: PendingCreateRequest,
  repos: readonly RepositorySummary[],
  now: number = Date.now()
): PendingCreate {
  const repository = repos.find((entry) => entry.id === input.repoId) ?? null
  const fallback = `${harnessLabel(input.harness)} · ${
    repository?.displayName ?? translate('newSession.repositoryFallback')
  }`
  return {
    id: nextId(now),
    request: input,
    repoId: input.repoId,
    harness: input.harness,
    title: normalizeSessionTitle(input.title ?? fallback, translate('session.untitled')),
    startedAt: now
  }
}

/** The pending create that belongs to a repository, if any. */
export function pendingCreateForRepo(
  pending: PendingCreate | null,
  repoId: string | null
): PendingCreate | null {
  if (pending === null || repoId === null) return null
  return pending.repoId === repoId ? pending : null
}

/**
 * Whether the pending surface should still be shown.
 *
 * The main process emits the successful `state` event before the create IPC
 * response resolves, so the real row can appear while the pending descriptor is
 * still set. Once a matching non-failed session is visible (created no earlier
 * than the submit), the pending row is redundant. Failed sessions do not hide it:
 * the outcome is not known yet, and the failed row is the durable evidence.
 */
export function pendingCreateStillVisible(
  pending: PendingCreate,
  sessions: readonly SessionSummary[]
): boolean {
  return !sessions.some(
    (session) =>
      session.repoId === pending.repoId &&
      session.harness === pending.harness &&
      session.title === pending.title &&
      session.state !== 'failed' &&
      session.updatedAt >= pending.startedAt
  )
}

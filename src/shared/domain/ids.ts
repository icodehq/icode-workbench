/**
 * Identity vocabulary.
 *
 * iCode owns durable repository, workspace, and session IDs. The terminal host
 * owns incarnation IDs because only it can name one PTY lifetime. Keeping these
 * as separate brands prevents a durable ID from being passed where a process
 * identity is required.
 */

declare const identityBrand: unique symbol

type Branded<T extends string, B extends string> = T & { readonly [identityBrand]: B }

export type RepoId = Branded<string, 'RepoId'>
export type WorkspaceId = Branded<string, 'WorkspaceId'>
export type SessionId = Branded<string, 'SessionId'>
export type WorktreeId = Branded<string, 'WorktreeId'>
export type ProviderId = Branded<string, 'ProviderId'>
export type PtyIncarnationId = Branded<string, 'PtyIncarnationId'>

const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const REPO_ID_PATTERN = new RegExp(`^repo_${UUID_V4}$`)
const WORKSPACE_ID_PATTERN = new RegExp(`^ws_${UUID_V4}$`)
const SESSION_ID_PATTERN = new RegExp(`^ses_${UUID_V4}$`)
const WORKTREE_ID_PATTERN = new RegExp(`^wt_${UUID_V4}$`)
const PROVIDER_ID_PATTERN = new RegExp(`^prv_${UUID_V4}$`)
/** Host-generated: opaque, but long enough to identify a PTY lifetime. */
const INCARNATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export const REPO_ID_RE = REPO_ID_PATTERN
export const WORKSPACE_ID_RE = WORKSPACE_ID_PATTERN
export const SESSION_ID_RE = SESSION_ID_PATTERN
export const WORKTREE_ID_RE = WORKTREE_ID_PATTERN
export const PROVIDER_ID_RE = PROVIDER_ID_PATTERN
export const INCARNATION_ID_RE = INCARNATION_ID_PATTERN

function newUuid(): string {
  return globalThis.crypto.randomUUID()
}

export function newRepoId(): RepoId {
  return `repo_${newUuid()}` as RepoId // SAFETY: generated format matches REPO_ID_PATTERN.
}

export function newWorkspaceId(): WorkspaceId {
  return `ws_${newUuid()}` as WorkspaceId // SAFETY: generated format matches WORKSPACE_ID_PATTERN.
}

export function newSessionId(): SessionId {
  return `ses_${newUuid()}` as SessionId // SAFETY: generated format matches SESSION_ID_PATTERN.
}

export function newWorktreeId(): WorktreeId {
  return `wt_${newUuid()}` as WorktreeId // SAFETY: generated format matches WORKTREE_ID_PATTERN.
}

export function newProviderId(): ProviderId {
  return `prv_${newUuid()}` as ProviderId // SAFETY: generated format matches PROVIDER_ID_PATTERN.
}

export function parseRepoId(value: string): RepoId | null {
  return REPO_ID_PATTERN.test(value) ? (value as RepoId) : null
}

export function parseWorkspaceId(value: string): WorkspaceId | null {
  return WORKSPACE_ID_PATTERN.test(value) ? (value as WorkspaceId) : null
}

export function parseSessionId(value: string): SessionId | null {
  return SESSION_ID_PATTERN.test(value) ? (value as SessionId) : null
}

export function parseWorktreeId(value: string): WorktreeId | null {
  return WORKTREE_ID_PATTERN.test(value) ? (value as WorktreeId) : null
}

export function parseProviderId(value: string): ProviderId | null {
  return PROVIDER_ID_PATTERN.test(value) ? (value as ProviderId) : null
}

/**
 * Incarnations are opaque to iCode, so the only shape requirement is a stable
 * identifier. iCode's durable prefixes are rejected so a durable ID cannot be
 * mistaken for a process identity.
 */
export function parsePtyIncarnationId(value: string): PtyIncarnationId | null {
  if (/^(repo|ws|ses|wt)_/.test(value)) return null
  return INCARNATION_ID_PATTERN.test(value) ? (value as PtyIncarnationId) : null
}

export function toSessionId(value: string): SessionId {
  const parsed = parseSessionId(value)
  if (!parsed) throw new Error(`Invalid session ID: ${value}`)
  return parsed
}

export function toPtyIncarnationId(value: string): PtyIncarnationId {
  const parsed = parsePtyIncarnationId(value)
  if (!parsed) throw new Error(`Invalid PTY incarnation ID: ${value}`)
  return parsed
}

/**
 * A delayed event from a previous PTY must never be applied to a restarted one.
 * Durable session identity may repeat; incarnation identity may not.
 */
export function assertDistinctSessionAndIncarnation(
  sessionId: SessionId,
  incarnationId: PtyIncarnationId
): void {
  if ((sessionId as string) === (incarnationId as string)) {
    throw new Error('Session ID and PTY incarnation ID must be distinct')
  }
}

import type { AppError } from '../../shared/domain/errors'
import { appErrorSchema } from '../../shared/schemas/domain'
import type { HarnessId } from '../../shared/domain/harness'
import {
  parsePtyIncarnationId,
  parseRepoId as parseDomainRepoId,
  parseSessionId as parseDomainSessionId,
  parseWorkspaceId as parseDomainWorkspaceId,
  type PtyIncarnationId,
  type RepoId,
  type SessionId,
  type WorkspaceId
} from '../../shared/domain/ids'
import type { CanonicalRepositoryPath } from '../../shared/domain/paths'
import type {
  ExecutionTarget,
  RepositoryAvailability,
  RepositoryPreparation,
  RepositoryRecord,
  WorkspaceRecord
} from '../../shared/domain/repository'
import { repositoryPreparationSchema } from '../../shared/schemas/domain'
import { LOCAL_EXECUTION_TARGET } from '../../shared/domain/repository'
import type {
  PersistedSessionObservation,
  SessionLifecycleState,
  SessionRole
} from '../../shared/domain/session'
import { SESSION_ROLES } from '../../shared/domain/session'

/** Raw SQLite rows are untrusted input: parse, never cast blindly. */
export function parseRepoId(value: unknown): RepoId {
  const parsed = parseDomainRepoId(requireString(value, 'repos.id'))
  if (!parsed) throw rowError('repos.id', value)
  return parsed
}

export function parseWorkspaceId(value: unknown): WorkspaceId {
  const parsed = parseDomainWorkspaceId(requireString(value, 'workspaces.id'))
  if (!parsed) throw rowError('workspaces.id', value)
  return parsed
}

export function parseSessionId(value: unknown): SessionId {
  const parsed = parseDomainSessionId(requireString(value, 'sessions.id'))
  if (!parsed) throw rowError('sessions.id', value)
  return parsed
}

export function parsePath(value: unknown, column: string): CanonicalRepositoryPath {
  const parsed = requireString(value, column)
  return parsed as CanonicalRepositoryPath
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== 'string' || value.length === 0) throw rowError(column, value)
  return value
}

function requireInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw rowError(column, value)
  return value
}

function rowError(column: string, value: unknown): Error {
  return new Error(
    `Corrupt database row: ${column} has unexpected value ${JSON.stringify(value).slice(0, 80)}`
  )
}

export type RepoRow = {
  id: unknown
  path: unknown
  display_name: unknown
  added_at: unknown
  last_opened_at: unknown
  current_branch: unknown
  availability: unknown
  git_common_dir?: unknown
  /** Absent only for rows read through a pre-v3 column list. */
  host_kind?: unknown
  wsl_distro?: unknown
  wsl_distro_id?: unknown
  /** Absent only for rows read through a pre-v6 column list. */
  preparation_json?: unknown
}

export type WorkspaceRow = {
  id: unknown
  repo_id: unknown
  path: unknown
  kind: unknown
  created_at: unknown
}

const AVAILABILITY: readonly RepositoryAvailability[] = ['present', 'missing']

export function repoFromRow(row: RepoRow): RepositoryRecord {
  const availability = row.availability
  if (typeof availability !== 'string' || !AVAILABILITY.includes(availability as RepositoryAvailability)) {
    throw rowError('repos.availability', availability)
  }
  const branch = row.current_branch
  if (branch !== null && typeof branch !== 'string') throw rowError('repos.current_branch', branch)
  return {
    id: parseRepoId(row.id),
    path: parsePath(row.path, 'repos.path'),
    displayName: requireString(row.display_name, 'repos.display_name'),
    addedAt: requireInteger(row.added_at, 'repos.added_at'),
    lastOpenedAt: requireInteger(row.last_opened_at, 'repos.last_opened_at'),
    currentBranch: branch,
    availability: availability as RepositoryAvailability,
    gitCommonDir:
      typeof row.git_common_dir === 'string' && row.git_common_dir.length > 0
        ? row.git_common_dir
        : null,
    executionTarget: executionTargetFromRow(row),
    preparation: preparationFromRow(row.preparation_json)
  }
}

/**
 * Preparation is stored as JSON so its shape can grow without another table
 * rebuild. It is still validated: a hand-edited or truncated row must fail
 * loudly instead of presenting an invalid state to the UI.
 */
function preparationFromRow(value: unknown): RepositoryPreparation | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    throw rowError('repos.preparation_json', value)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw rowError('repos.preparation_json', value)
  }
  const result = repositoryPreparationSchema.safeParse(parsed)
  if (!result.success) throw rowError('repos.preparation_json', value)
  return result.data
}

/**
 * Rebuilds the execution target from its three columns.
 *
 * A row without a `host_kind` predates v3, and every such row is local. The
 * name/id pair is validated rather than coerced: a WSL row always names a distro,
 * and a local row never does, so an inconsistent triple is a corrupt row rather
 * than something to guess about.
 */
function executionTargetFromRow(row: RepoRow): ExecutionTarget {
  const kind = row.host_kind ?? 'local'
  if (kind === 'local') {
    if (row.wsl_distro !== undefined && row.wsl_distro !== '') {
      throw rowError('repos.wsl_distro', row.wsl_distro)
    }
    if (row.wsl_distro_id !== undefined && row.wsl_distro_id !== null) {
      throw rowError('repos.wsl_distro_id', row.wsl_distro_id)
    }
    return LOCAL_EXECUTION_TARGET
  }
  if (kind !== 'wsl') throw rowError('repos.host_kind', kind)
  const distro = requireString(row.wsl_distro, 'repos.wsl_distro')
  const distroId = row.wsl_distro_id
  if (distroId !== null && typeof distroId !== 'string') {
    throw rowError('repos.wsl_distro_id', distroId)
  }
  return { kind: 'wsl', distro, distroId: distroId === '' ? null : distroId }
}

export function workspaceFromRow(row: WorkspaceRow): WorkspaceRecord {
  if (row.kind !== 'primary-checkout') throw rowError('workspaces.kind', row.kind)
  return {
    id: parseWorkspaceId(row.id),
    repoId: parseRepoId(row.repo_id),
    path: parsePath(row.path, 'workspaces.path'),
    kind: 'primary-checkout',
    createdAt: requireInteger(row.created_at, 'workspaces.created_at')
  }
}

export type SessionRow = {
  id: unknown
  workspace_id: unknown
  harness: unknown
  title: unknown
  created_at: unknown
  last_active_at: unknown
  last_observed_state: unknown
  last_observed_exit_code: unknown
  last_observed_error_json: unknown
  last_observed_incarnation_id: unknown
  last_observed_at: unknown
  sleeping_at: unknown
  resume_token: unknown
  role: unknown
}

const HARNESSES: readonly HarnessId[] = ['claude', 'codex', 'opencode', 'shell']
const STATES: readonly SessionLifecycleState[] = [
  'starting',
  'live',
  'exited',
  'failed',
  'unavailable'
]

export type StoredSession = {
  id: SessionId
  workspaceId: WorkspaceId
  harness: HarnessId
  title: string
  role: SessionRole
  createdAt: number
  lastActiveAt: number
  observation: PersistedSessionObservation
  /** Non-null when the user slept the session and it has not been woken. */
  sleepingAt: number | null
  /** Harness conversation identity to resume on wake, when one is known. */
  resumeToken: string | null
}

function parseAppError(raw: unknown): AppError | null {
  if (raw === null) return null
  if (typeof raw !== 'string') throw rowError('sessions.last_observed_error_json', raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw rowError('sessions.last_observed_error_json', raw)
  }
  const result = appErrorSchema.safeParse(parsed)
  if (!result.success) throw rowError('sessions.last_observed_error_json', raw)
  return result.data
}

export function sessionFromRow(row: SessionRow): StoredSession {
  const harness = row.harness
  if (typeof harness !== 'string' || !HARNESSES.includes(harness as HarnessId)) {
    throw rowError('sessions.harness', harness)
  }
  const state = row.last_observed_state
  if (typeof state !== 'string' || !STATES.includes(state as SessionLifecycleState)) {
    throw rowError('sessions.last_observed_state', state)
  }
  const exitCode = row.last_observed_exit_code
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) {
    throw rowError('sessions.last_observed_exit_code', exitCode)
  }
  const incarnation = row.last_observed_incarnation_id
  if (incarnation === null) {
    // no process identity was ever recorded
  } else if (typeof incarnation !== 'string' || !parsePtyIncarnationId(incarnation)) {
    throw rowError('sessions.last_observed_incarnation_id', incarnation)
  }
  const sleepingAt = row.sleeping_at
  if (sleepingAt !== null && (typeof sleepingAt !== 'number' || !Number.isInteger(sleepingAt))) {
    throw rowError('sessions.sleeping_at', sleepingAt)
  }
  const resumeToken = row.resume_token
  if (
    resumeToken !== null &&
    (typeof resumeToken !== 'string' || resumeToken.length === 0 || resumeToken.length > 512)
  ) {
    throw rowError('sessions.resume_token', resumeToken)
  }
  const role = row.role ?? 'interactive'
  if (typeof role !== 'string' || !SESSION_ROLES.includes(role as SessionRole)) {
    throw rowError('sessions.role', role)
  }
  return {
    id: parseSessionId(row.id),
    workspaceId: parseWorkspaceId(row.workspace_id),
    harness: harness as HarnessId,
    title: requireString(row.title, 'sessions.title'),
    role: role as SessionRole,
    createdAt: requireInteger(row.created_at, 'sessions.created_at'),
    lastActiveAt: requireInteger(row.last_active_at, 'sessions.last_active_at'),
    observation: {
      lastObservedState: state as SessionLifecycleState,
      lastObservedExitCode: exitCode,
      lastObservedError: parseAppError(row.last_observed_error_json),
      lastObservedIncarnationId: incarnation as PtyIncarnationId | null,
      lastObservedAt: requireInteger(row.last_observed_at, 'sessions.last_observed_at')
    },
    sleepingAt,
    resumeToken
  }
}

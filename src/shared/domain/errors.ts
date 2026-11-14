import type { MessageKey } from '../i18n/messages'

/**
 * Stable error vocabulary shared by main, the host client, and the renderer.
 * Messages are user-facing; details carry diagnostics but must never include
 * tokens or environment dumps.
 *
 * `message` stays the authoritative English text. `messageKey` names the same
 * message in the shared catalogs so a renderer can localize it; persisted rows
 * written before keys existed keep their English message as a safe fallback.
 */

export const APP_ERROR_CODES = [
  'PATH_NOT_FOUND',
  'NOT_A_DIRECTORY',
  'NOT_A_GIT_REPO',
  'REPO_PATH_MISSING',
  'HARNESS_UNAVAILABLE',
  'HARNESS_DETECTION_FAILED',
  'SPAWN_FAILED',
  'CWD_MISSING',
  'HOST_UNREACHABLE',
  'HOST_PROTOCOL_MISMATCH',
  'HOST_AUTH_FAILED',
  'SUPERVISOR_UNAVAILABLE',
  'ASSISTANT_BUSY',
  'ASSISTANT_UNAVAILABLE',
  'SESSION_NOT_FOUND',
  'SESSION_START_TIMEOUT',
  'SESSION_NOT_LIVE',
  'DB_CORRUPT',
  'INVALID_ARGUMENT',
  'INTERNAL',
  'WORKTREE_CREATE_FAILED',
  'WORKTREE_MISSING',
  'WORKTREE_INCONSISTENT',
  'WORKTREE_DIRTY',
  'WORKTREE_UNMERGED',
  'BRANCH_NOT_OWNED',
  'UNBORN_REPOSITORY',
  'GIT_OPERATION_IN_PROGRESS',
  'CHANGE_PATH_OUTSIDE',
  'GIT_READ_FAILED',
  'GIT_READ_TIMEOUT',
  // Project adoption: a folder can be a Git-free project, but not yet a usable one.
  'GIT_IDENTITY_MISSING',
  'GIT_INIT_FAILED',
  'GIT_COMMIT_FAILED',
  // Git state that needs a specific remedy rather than a generic "git failed".
  'GIT_INDEX_LOCKED',
  'GIT_CONFLICT',
  'GIT_DIVERGED',
  'GIT_AUTH_FAILED',
  'GIT_NON_FAST_FORWARD',
  'GIT_BRANCH_IN_USE',
  'GIT_STALE_STATUS',
  // Remote configuration, fetch, clone, push and pull failures that are not auth.
  'GIT_REMOTE_FAILED',
  // Session-first integration: starting refs, branch naming, dependency chains.
  'START_REF_NOT_FOUND',
  'BRANCH_EXISTS',
  'CHAIN_BRANCH_CONFLICT',
  'CHAIN_BRANCH_MISMATCH',
  'CHAIN_BRANCH_MISSING',
  'MERGE_IN_PROGRESS',
  'MERGE_TARGET_BUSY',
  'MERGE_TARGET_MOVED',
  // WSL execution targets. Each names a different remedy, so they are separate
  // codes rather than one WSL_* bucket: the distro is gone, versus WSL itself is
  // unavailable, versus a probe against a live distro failed.
  'WSL_UNAVAILABLE',
  'WSL_DISTRO_NOT_FOUND',
  'WSL_GUEST_PROBE_FAILED',
  // Managed WSL Host lifecycle (W4). Each is a different remedy: deploy again,
  // launch again, stop what is already running, or replace an incompatible Host.
  'WSL_HOST_DEPLOY_FAILED',
  'WSL_HOST_START_FAILED',
  'WSL_HOST_UNVERIFIABLE',
  'WSL_HOST_STOP_FAILED',
  'WSL_HOST_PROTOCOL_MISMATCH',
  // A pre-W1 WSL row names its distro only by name; the recorded repository and
  // the proven registration cannot be shown to be the same installation.
  'WSL_LEGACY_REGISTRATION_UNRESOLVED',
  // The repository is tombstoned by a durable removal job and cannot accept new
  // sessions, tasks, merges, or a duplicate registration.
  'REPOSITORY_REMOVING'
] as const

export type AppErrorCode = (typeof APP_ERROR_CODES)[number]

/** Wire codes produced by the terminal host. */
export const HOST_FAILURE_CODES = [
  'AUTH_FAILED',
  'BAD_REQUEST',
  'FRAME_TOO_LARGE',
  'SESSION_NOT_FOUND',
  'STALE_INCARNATION',
  'SPAWN_FAILED',
  'INTERNAL',
  'UNSUPPORTED_VERSION'
] as const

export type HostFailureCode = (typeof HOST_FAILURE_CODES)[number]

/** Main-side transport failures that never reach the wire. */
export type HostTransportFailureCode = 'HOST_TIMEOUT' | 'HOST_CONNECT_FAILED' | 'HOST_UNREACHABLE'

export type AppErrorMessageParams = Record<string, string | number>

export type AppError = {
  code: AppErrorCode
  message: string
  detail?: string
  /** Whether the same action can reasonably be retried without changing inputs. */
  retryable: boolean
  context?: Record<string, string>
  messageKey?: MessageKey
  messageParams?: AppErrorMessageParams
}

const RETRYABLE_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'HOST_UNREACHABLE',
  'SESSION_START_TIMEOUT',
  'HARNESS_DETECTION_FAILED',
  'WORKTREE_CREATE_FAILED',
  'GIT_READ_FAILED',
  'GIT_READ_TIMEOUT',
  // Network and remote-server failures are commonly transient.
  'GIT_REMOTE_FAILED',
  // Index lock contention is transient: the other Git process usually finishes.
  'GIT_INDEX_LOCKED',
  // The target branch moved while the merge was being prepared; retry.
  'MERGE_TARGET_MOVED',
  // A stopped distro or a busy WSL service generally answers on the next attempt.
  'WSL_UNAVAILABLE',
  'WSL_GUEST_PROBE_FAILED',
  'WSL_HOST_DEPLOY_FAILED',
  'WSL_HOST_START_FAILED',
  'WSL_HOST_STOP_FAILED',
  'INTERNAL'
])

export function isRetryableAppErrorCode(code: AppErrorCode): boolean {
  return RETRYABLE_CODES.has(code)
}

export function makeAppError(
  code: AppErrorCode,
  message: string,
  options: {
    detail?: string
    context?: Record<string, string>
    messageKey?: MessageKey
    messageParams?: AppErrorMessageParams
  } = {}
): AppError {
  const error: AppError = {
    code,
    message,
    retryable: isRetryableAppErrorCode(code)
  }
  if (options.detail) error.detail = options.detail
  if (options.context && Object.keys(options.context).length > 0) error.context = options.context
  if (options.messageKey) error.messageKey = options.messageKey
  if (options.messageParams && Object.keys(options.messageParams).length > 0) {
    error.messageParams = options.messageParams
  }
  return error
}

export type HostFailure = {
  code: HostFailureCode | HostTransportFailureCode
  message: string
  detail?: string
}

const HOST_TO_APP: Record<HostFailureCode | HostTransportFailureCode, AppErrorCode> = {
  AUTH_FAILED: 'HOST_AUTH_FAILED',
  BAD_REQUEST: 'INVALID_ARGUMENT',
  FRAME_TOO_LARGE: 'HOST_PROTOCOL_MISMATCH',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  STALE_INCARNATION: 'SESSION_NOT_FOUND',
  SPAWN_FAILED: 'SPAWN_FAILED',
  INTERNAL: 'INTERNAL',
  UNSUPPORTED_VERSION: 'HOST_PROTOCOL_MISMATCH',
  HOST_TIMEOUT: 'HOST_UNREACHABLE',
  HOST_CONNECT_FAILED: 'HOST_UNREACHABLE',
  HOST_UNREACHABLE: 'HOST_UNREACHABLE'
}

export function appErrorFromHostFailure(failure: HostFailure): AppError {
  return makeAppError(HOST_TO_APP[failure.code], failure.message, {
    ...(failure.detail ? { detail: failure.detail } : {})
  })
}

export function appErrorFromUnknown(error: unknown, fallback: AppErrorCode = 'INTERNAL'): AppError {
  if (error instanceof Error) {
    return makeAppError(fallback, error.message)
  }
  return makeAppError(fallback, typeof error === 'string' ? error : 'Unexpected error')
}

/**
 * Stable error vocabulary shared by main, the host client, and the renderer.
 * Messages are user-facing; details carry diagnostics but must never include
 * tokens or environment dumps.
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
  'REVIEW_PATH_OUTSIDE',
  'GIT_READ_FAILED',
  'GIT_READ_TIMEOUT'
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

export type AppError = {
  code: AppErrorCode
  message: string
  detail?: string
  /** Whether the same action can reasonably be retried without changing inputs. */
  retryable: boolean
  context?: Record<string, string>
}

const RETRYABLE_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'HOST_UNREACHABLE',
  'SESSION_START_TIMEOUT',
  'HARNESS_DETECTION_FAILED',
  'WORKTREE_CREATE_FAILED',
  'GIT_READ_FAILED',
  'GIT_READ_TIMEOUT',
  'INTERNAL'
])

export function isRetryableAppErrorCode(code: AppErrorCode): boolean {
  return RETRYABLE_CODES.has(code)
}

export function makeAppError(
  code: AppErrorCode,
  message: string,
  options: { detail?: string; context?: Record<string, string> } = {}
): AppError {
  const error: AppError = {
    code,
    message,
    retryable: isRetryableAppErrorCode(code)
  }
  if (options.detail) error.detail = options.detail
  if (options.context && Object.keys(options.context).length > 0) error.context = options.context
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

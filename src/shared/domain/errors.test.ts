import { describe, expect, it } from 'vitest'
import {
  APP_ERROR_CODES,
  HOST_FAILURE_CODES,
  appErrorFromHostFailure,
  appErrorFromUnknown,
  isRetryableAppErrorCode,
  makeAppError
} from './errors'
import { appErrorSchema } from '../schemas/domain'

describe('app error codes', () => {
  it('keeps the approved code set stable', () => {
    expect(APP_ERROR_CODES).toEqual([
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
      'GIT_IDENTITY_MISSING',
      'GIT_INIT_FAILED',
      'GIT_COMMIT_FAILED',
      'GIT_INDEX_LOCKED',
      'GIT_CONFLICT',
      'GIT_DIVERGED',
      'GIT_AUTH_FAILED',
      'GIT_NON_FAST_FORWARD',
      'GIT_BRANCH_IN_USE',
      'GIT_STALE_STATUS',
      'GIT_REMOTE_FAILED',
      'START_REF_NOT_FOUND',
      'BRANCH_EXISTS',
      'CHAIN_BRANCH_CONFLICT',
      'CHAIN_BRANCH_MISMATCH',
      'CHAIN_BRANCH_MISSING',
      'MERGE_IN_PROGRESS',
      'MERGE_TARGET_BUSY',
      'MERGE_TARGET_MOVED',
      'WSL_UNAVAILABLE',
      'WSL_DISTRO_NOT_FOUND',
      'WSL_GUEST_PROBE_FAILED',
      'WSL_HOST_DEPLOY_FAILED',
      'WSL_HOST_START_FAILED',
      'WSL_HOST_UNVERIFIABLE',
      'WSL_HOST_STOP_FAILED',
      'WSL_HOST_PROTOCOL_MISMATCH',
      'WSL_LEGACY_REGISTRATION_UNRESOLVED',
      'REPOSITORY_REMOVING'
    ])
    expect(HOST_FAILURE_CODES).toHaveLength(8)
    expect(HOST_FAILURE_CODES).toContain('STALE_INCARNATION')
  })

  it('derives retryability from the code, not the caller', () => {
    expect(isRetryableAppErrorCode('HOST_UNREACHABLE')).toBe(true)
    expect(isRetryableAppErrorCode('SESSION_START_TIMEOUT')).toBe(true)
    expect(isRetryableAppErrorCode('HARNESS_DETECTION_FAILED')).toBe(true)
    expect(isRetryableAppErrorCode('HARNESS_UNAVAILABLE')).toBe(false)
    expect(isRetryableAppErrorCode('PATH_NOT_FOUND')).toBe(false)
    expect(isRetryableAppErrorCode('SPAWN_FAILED')).toBe(false)
    expect(isRetryableAppErrorCode('DB_CORRUPT')).toBe(false)
  })

  it('builds structured errors with optional diagnostics', () => {
    expect(makeAppError('PATH_NOT_FOUND', 'Repository folder does not exist')).toEqual({
      code: 'PATH_NOT_FOUND',
      message: 'Repository folder does not exist',
      retryable: false
    })

    const detailed = makeAppError('HOST_UNREACHABLE', 'Terminal host is unreachable', {
      detail: 'connect ECONNREFUSED',
      context: { socket: '/run/user/1000/icode/terminal-host.sock' }
    })
    expect(detailed).toMatchObject({
      retryable: true,
      detail: 'connect ECONNREFUSED',
      context: { socket: '/run/user/1000/icode/terminal-host.sock' }
    })
  })
})

describe('host failure mapping', () => {
  it.each([
    ['AUTH_FAILED', 'HOST_AUTH_FAILED', false],
    ['UNSUPPORTED_VERSION', 'HOST_PROTOCOL_MISMATCH', false],
    ['BAD_REQUEST', 'INVALID_ARGUMENT', false],
    ['FRAME_TOO_LARGE', 'HOST_PROTOCOL_MISMATCH', false],
    ['SESSION_NOT_FOUND', 'SESSION_NOT_FOUND', false],
    ['SPAWN_FAILED', 'SPAWN_FAILED', false],
    ['INTERNAL', 'INTERNAL', true],
    ['HOST_TIMEOUT', 'HOST_UNREACHABLE', true],
    ['HOST_CONNECT_FAILED', 'HOST_UNREACHABLE', true]
  ] as const)('maps %s to %s', (hostCode, appCode, retryable) => {
    const mapped = appErrorFromHostFailure({ code: hostCode, message: 'failure' })
    expect(mapped.code).toBe(appCode)
    expect(mapped.retryable).toBe(retryable)
  })

  it('preserves safe detail text', () => {
    const mapped = appErrorFromHostFailure({
      code: 'SPAWN_FAILED',
      message: 'Cannot start Claude Code',
      detail: 'spawn claude ENOENT'
    })
    expect(mapped.detail).toBe('spawn claude ENOENT')
  })
})

describe('unknown failures', () => {
  it('wraps Error, string, and object values', () => {
    expect(appErrorFromUnknown(new Error('boom'))).toMatchObject({ code: 'INTERNAL', message: 'boom' })
    expect(appErrorFromUnknown('plain')).toMatchObject({ code: 'INTERNAL', message: 'plain' })
    expect(appErrorFromUnknown({ weird: true })).toMatchObject({
      code: 'INTERNAL',
      message: 'Unexpected error'
    })
    expect(appErrorFromUnknown(new Error('bad path'), 'PATH_NOT_FOUND').code).toBe('PATH_NOT_FOUND')
  })
})

describe('appErrorSchema', () => {
  it('accepts a consistent error', () => {
    const parsed = appErrorSchema.safeParse(makeAppError('SESSION_NOT_LIVE', 'Session has exited'))
    expect(parsed.success).toBe(true)
  })

  it('rejects unknown codes and inconsistent retryability', () => {
    expect(
      appErrorSchema.safeParse({ code: 'NOT_REAL', message: 'x', retryable: false }).success
    ).toBe(false)
    expect(
      appErrorSchema.safeParse({ code: 'PATH_NOT_FOUND', message: 'x', retryable: true }).success
    ).toBe(false)
  })

  it('rejects empty messages and oversized detail', () => {
    expect(
      appErrorSchema.safeParse({ code: 'INTERNAL', message: '', retryable: true }).success
    ).toBe(false)
    expect(
      appErrorSchema.safeParse({
        code: 'INTERNAL',
        message: 'x',
        retryable: true,
        detail: 'd'.repeat(4001)
      }).success
    ).toBe(false)
  })
})

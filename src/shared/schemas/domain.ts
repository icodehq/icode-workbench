import { z } from 'zod'
import { APP_ERROR_CODES, isRetryableAppErrorCode } from '../domain/errors'
import { en } from '../i18n/catalogs'
import type { MessageKey } from '../i18n/messages'
import { HARNESS_IDS } from '../domain/harness'
import {
  HOST_SESSION_STATUSES,
  SESSION_LIFECYCLE_STATES
} from '../domain/session'
import {
  absolutePathSchema,
  diagnosticTextSchema,
  errorDetailSchema,
  errorMessageSchema,
  incarnationIdSchema,
  repoIdSchema,
  sessionIdSchema,
  sessionTitleSchema,
  timestampSchema,
  workspaceIdSchema
} from './primitives'

export const appErrorCodeSchema = z.enum(APP_ERROR_CODES)

/** A catalog key that exists in the source catalog. */
export const appErrorMessageKeySchema = z.custom<MessageKey>(
  (value) => typeof value === 'string' && Object.prototype.hasOwnProperty.call(en, value),
  { message: 'Unknown message key' }
)

export const appErrorSchema = z
  .strictObject({
    code: appErrorCodeSchema,
    message: errorMessageSchema,
    detail: errorDetailSchema.optional(),
    retryable: z.boolean(),
    context: z.record(z.string().max(100), z.string().max(1000)).optional(),
    messageKey: appErrorMessageKeySchema.optional(),
    messageParams: z
      .record(
        z.string().max(64),
        z.union([z.string().max(500), z.number()])
      )
      .optional()
  })
  .refine((error) => error.retryable === isRetryableAppErrorCode(error.code), {
    message: 'retryable must match the code policy',
    path: ['retryable']
  })

export const harnessIdSchema = z.enum(HARNESS_IDS)
export const hostSessionStatusSchema = z.enum(HOST_SESSION_STATUSES)
export const sessionLifecycleStateSchema = z.enum(SESSION_LIFECYCLE_STATES)

export const repositoryAvailabilitySchema = z.enum(['present', 'missing'])

export const repositoryPreparationSchema = z.strictObject({
  state: z.enum(['preparing', 'ready', 'failed']),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  committedFiles: z.number().int().nonnegative().nullable(),
  skippedFolders: z.array(z.string().min(1).max(200)).max(50),
  error: appErrorSchema.nullable()
})

export const repositoryRecordSchema = z.strictObject({
  id: repoIdSchema,
  path: absolutePathSchema,
  displayName: z.string().min(1).max(200),
  addedAt: timestampSchema,
  lastOpenedAt: timestampSchema,
  currentBranch: z.string().min(1).max(255).nullable(),
  availability: repositoryAvailabilitySchema,
  preparation: repositoryPreparationSchema.nullable().optional()
})

export const workspaceRecordSchema = z.strictObject({
  id: workspaceIdSchema,
  repoId: repoIdSchema,
  path: absolutePathSchema,
  kind: z.literal('primary-checkout'),
  createdAt: timestampSchema
})

export const persistedSessionObservationSchema = z.strictObject({
  lastObservedState: sessionLifecycleStateSchema,
  lastObservedExitCode: z.number().int().nullable(),
  lastObservedError: appErrorSchema.nullable(),
  lastObservedIncarnationId: incarnationIdSchema.nullable(),
  lastObservedAt: timestampSchema
})

export const sessionRecordSchema = z.strictObject({
  id: sessionIdSchema,
  workspaceId: workspaceIdSchema,
  harness: harnessIdSchema,
  title: sessionTitleSchema,
  createdAt: timestampSchema,
  lastActiveAt: timestampSchema,
  lastObservedState: sessionLifecycleStateSchema,
  lastObservedExitCode: z.number().int().nullable(),
  lastObservedError: appErrorSchema.nullable(),
  lastObservedIncarnationId: incarnationIdSchema.nullable(),
  lastObservedAt: timestampSchema
})

export const harnessProbeDiagnosticsSchema = z.strictObject({
  resolvedPath: z.string().max(4096).nullable(),
  outcome: z.enum(['exited', 'timed_out', 'signaled', 'spawn_error']),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(64).nullable(),
  stdoutTail: diagnosticTextSchema,
  stderrTail: diagnosticTextSchema,
  durationMs: z.number().int().nonnegative(),
  observedAt: timestampSchema,
  attempts: z.number().int().min(1)
})

export const harnessDetectionSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('available'),
    harness: harnessIdSchema,
    version: z.string().max(64).nullable(),
    resolvedPath: z.string().min(1).max(4096),
    diagnostics: harnessProbeDiagnosticsSchema
  }),
  z.strictObject({
    state: z.literal('unavailable'),
    harness: harnessIdSchema,
    reason: z.enum(['not_found', 'permission_denied', 'incompatible_installation']),
    incompatibility: z
      .enum([
        'missing_platform_binary',
        'wrong_platform_package',
        'unsupported_platform',
        'incompatible_runtime'
      ])
      .nullable(),
    message: errorMessageSchema,
    diagnostics: harnessProbeDiagnosticsSchema
  }),
  z.strictObject({
    state: z.literal('detection_failed'),
    harness: harnessIdSchema,
    reason: z.enum(['timeout', 'terminated_by_signal', 'nonzero_exit', 'spawn_error']),
    message: errorMessageSchema,
    diagnostics: harnessProbeDiagnosticsSchema
  })
])

export const hostSessionSnapshotSchema = z.strictObject({
  status: hostSessionStatusSchema,
  incarnationId: incarnationIdSchema,
  ptyPid: z.number().int().min(-1),
  exitCode: z.number().int().nullable(),
  stopRequested: z.boolean().optional()
})

export const hostObservationSchema = z.union([
  z.strictObject({ reachable: z.literal(false) }),
  z.strictObject({
    reachable: z.literal(true),
    session: hostSessionSnapshotSchema.nullable()
  })
])

export const reconciliationReasonSchema = z.enum([
  'host_starting',
  'host_live',
  'host_exited',
  'host_failed',
  'session_not_known',
  'history_only',
  'host_unreachable',
  'host_unreachable_history'
])

export const reconciledSessionStateSchema = z.strictObject({
  state: sessionLifecycleStateSchema,
  authority: z.enum(['host', 'persisted', 'unreachable']),
  reason: reconciliationReasonSchema,
  incarnationId: incarnationIdSchema.nullable(),
  exitCode: z.number().int().nullable(),
  error: appErrorSchema.nullable()
})

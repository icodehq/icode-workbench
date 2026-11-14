import { z } from 'zod'
import { isCloneableRemoteInput } from '../domain/remote-url'
import { appErrorSchema } from './domain'
import { absolutePathSchema, repoIdSchema } from './primitives'
import { executionTargetSchema } from './ipc'

/**
 * Remote and clone request shapes.
 *
 * URLs are validated against the shared allowlist here as well as in the
 * service: IPC is a boundary, and a schema refusal never reaches Git. The
 * service remains authoritative for remote names, which Git itself checks.
 */

export const remoteNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000- \u007f]/u.test(value), 'must not contain whitespace')
  .refine((value) => !value.startsWith('-'), 'must not start with a dash')
  .refine((value) => !value.startsWith('refs/'), 'must not start with refs/')

export const remoteUrlInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(isCloneableRemoteInput, 'must be a supported Git URL')

export const remoteListInputSchema = z.strictObject({ repoId: repoIdSchema })

export const remoteAddInputSchema = z.strictObject({
  repoId: repoIdSchema,
  name: remoteNameSchema,
  url: remoteUrlInputSchema
})

export const remoteSetUrlInputSchema = z.strictObject({
  repoId: repoIdSchema,
  name: remoteNameSchema,
  url: remoteUrlInputSchema
})

export const remoteRemoveInputSchema = z.strictObject({
  repoId: repoIdSchema,
  name: remoteNameSchema
})

export const remoteFetchInputSchema = z.strictObject({
  repoId: repoIdSchema,
  name: remoteNameSchema,
  prune: z.boolean().optional()
})

export const remoteSummarySchema = z.strictObject({
  name: z.string().min(1).max(255),
  /** Already redacted for display; the raw URL never crosses IPC. */
  displayFetchUrl: z.string().max(2_048),
  /** Present only when it differs from the fetch URL; display-only. */
  displayPushUrl: z.string().max(2_048).nullable(),
  provider: z.enum(['github', 'gitlab', 'generic']),
  webUrl: z.string().max(2_048).nullable(),
  hasCredentials: z.boolean()
})

export const remoteListResultSchema = z.array(remoteSummarySchema).max(100)

export const remoteMutationResultSchema = z.strictObject({
  status: z.literal('ok'),
  name: z.string().min(1).max(255)
})

export const cloneRequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u, 'must be an opaque request identifier')

export const cloneStartInputSchema = z.strictObject({
  requestId: cloneRequestIdSchema,
  url: remoteUrlInputSchema,
  target: executionTargetSchema,
  parentPath: absolutePathSchema,
  name: z.string().trim().min(1).max(200)
})

export const cloneStartResultSchema = z.strictObject({ requestId: cloneRequestIdSchema })

export const cloneCancelInputSchema = z.strictObject({
  requestId: cloneRequestIdSchema
})

export const cloneCancelResultSchema = z.strictObject({ cancelled: z.boolean() })

export const CLONE_PHASES = [
  'starting',
  'enumerating',
  'counting',
  'compressing',
  'receiving',
  'resolving',
  'checking-out',
  'done'
] as const

export type ClonePhasePayload = (typeof CLONE_PHASES)[number]

export const cloneCleanupSchema = z.enum(['removed', 'failed', 'not-needed'])

export const cloneProgressEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('progress'),
    requestId: cloneRequestIdSchema,
    phase: z.enum(CLONE_PHASES),
    percent: z.number().int().min(0).max(100).nullable(),
    detail: z.string().max(2_000),
    objectsDone: z.number().int().nonnegative().optional(),
    objectsTotal: z.number().int().nonnegative().optional()
  }),
  z.strictObject({
    type: z.literal('done'),
    requestId: cloneRequestIdSchema,
    destination: absolutePathSchema,
    unborn: z.boolean()
  }),
  z.strictObject({
    type: z.literal('cancelled'),
    requestId: cloneRequestIdSchema,
    destination: absolutePathSchema,
    cleanup: cloneCleanupSchema
  }),
  z.strictObject({
    type: z.literal('failed'),
    requestId: cloneRequestIdSchema,
    destination: absolutePathSchema,
    error: appErrorSchema,
    cleanup: cloneCleanupSchema
  })
])

export type RemoteSummaryPayload = z.infer<typeof remoteSummarySchema>
export type RemoteListInput = z.infer<typeof remoteListInputSchema>
export type RemoteAddInput = z.infer<typeof remoteAddInputSchema>
export type RemoteSetUrlInput = z.infer<typeof remoteSetUrlInputSchema>
export type RemoteRemoveInput = z.infer<typeof remoteRemoveInputSchema>
export type RemoteFetchInput = z.infer<typeof remoteFetchInputSchema>
export type CloneStartInputPayload = z.infer<typeof cloneStartInputSchema>
export type CloneCancelInput = z.infer<typeof cloneCancelInputSchema>
export type CloneProgressEventPayload = z.infer<typeof cloneProgressEventSchema>

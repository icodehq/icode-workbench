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

/**
 * A credential field is line-oriented on disk and in the Git helper protocol,
 * so a value containing a newline or NUL is a protocol-injection opportunity,
 * not a password.
 */
const cloneCredentialTextSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000\r\n]/u.test(value), 'must be a single line without NUL')

export const cloneHttpsAuthSchema = z.strictObject({
  kind: z.literal('https'),
  username: cloneCredentialTextSchema(255),
  /** Password or personal access token. */
  password: cloneCredentialTextSchema(4_096)
})

export const cloneSshAuthSchema = z.strictObject({ kind: z.literal('ssh') })

export const cloneAuthSchema = z.discriminatedUnion('kind', [
  cloneHttpsAuthSchema,
  cloneSshAuthSchema
])

export const cloneStartInputSchema = z.strictObject({
  requestId: cloneRequestIdSchema,
  url: remoteUrlInputSchema,
  target: executionTargetSchema,
  parentPath: absolutePathSchema,
  name: z.string().trim().min(1).max(200),
  /** Present only on a retry that supplies credentials or selects SSH. */
  auth: cloneAuthSchema.optional()
})

export const cloneStartResultSchema = z.strictObject({ requestId: cloneRequestIdSchema })

export const cloneCancelInputSchema = z.strictObject({
  requestId: cloneRequestIdSchema
})

export const cloneCancelResultSchema = z.strictObject({ cancelled: z.boolean() })

/**
 * The post-success choice. The credential itself never crosses this channel:
 * the renderer names a request id and a mode, and main resolves the rest from
 * its short-lived in-memory record.
 */
export const clonePersistInputSchema = z.strictObject({
  requestId: cloneRequestIdSchema,
  mode: z.enum(['store', 'ssh', 'skip']),
  sshUrl: remoteUrlInputSchema.optional()
})

export const clonePersistResultSchema = z.strictObject({
  status: z.enum(['stored', 'switched', 'skipped'])
})

const sshHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/u, 'must be a hostname')

const sshFingerprintSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^SHA256:[A-Za-z0-9+/=]+$/u, 'must be a SHA256 fingerprint')

export const cloneSshStatusInputSchema = z.strictObject({
  target: executionTargetSchema
})

export const cloneSshStatusResultSchema = z.strictObject({
  sshAvailable: z.boolean(),
  keygenAvailable: z.boolean(),
  keyscanAvailable: z.boolean(),
  agentAvailable: z.boolean(),
  agentIdentities: z.number().int().nonnegative().nullable(),
  home: z.string().max(4_096).nullable(),
  defaultKeyPath: z.string().max(4_096).nullable(),
  defaultKeyExists: z.boolean(),
  keys: z
    .array(
      z.strictObject({
        path: z.string().max(4_096),
        type: z.string().max(64).nullable(),
        fingerprint: z.string().max(256).nullable(),
        publicKey: z.string().max(8_192)
      })
    )
    .max(20),
  sshPath: z.string().max(4_096).nullable(),
  keygenPath: z.string().max(4_096).nullable(),
  keyscanPath: z.string().max(4_096).nullable()
})

export const cloneSshGenerateInputSchema = z.strictObject({
  target: executionTargetSchema,
  /** Literal true: an accidental call must not create a key. */
  consent: z.literal(true)
})

export const cloneSshGenerateResultSchema = z.strictObject({
  status: z.enum(['created', 'exists']),
  keyPath: z.string().min(1).max(4_096),
  publicKey: z.string().max(8_192)
})

export const cloneSshTestInputSchema = z.strictObject({
  target: executionTargetSchema,
  url: remoteUrlInputSchema
})

export const cloneSshTestResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok') }),
  z.strictObject({
    status: z.literal('host_key_unknown'),
    host: sshHostSchema,
    port: z.number().int().min(1).max(65_535),
    fingerprints: z
      .array(
        z.strictObject({
          type: z.string().max(64),
          fingerprint: sshFingerprintSchema
        })
      )
      .min(1)
      .max(4)
  }),
  z.strictObject({
    status: z.literal('auth_failed'),
    reason: z.enum(['publickey', 'agent', 'other']),
    detail: z.string().max(2_000).optional()
  }),
  z.strictObject({
    status: z.literal('ssh_unavailable'),
    detail: z.string().max(2_000).optional()
  }),
  z.strictObject({
    status: z.literal('network'),
    detail: z.string().max(2_000).optional()
  })
])

export const cloneSshTrustHostInputSchema = z.strictObject({
  target: executionTargetSchema,
  host: sshHostSchema,
  port: z.number().int().min(1).max(65_535),
  fingerprints: z.array(sshFingerprintSchema).min(1).max(4)
})

export const cloneSshTrustHostResultSchema = z.strictObject({
  status: z.enum(['trusted', 'already-trusted'])
})

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
    unborn: z.boolean(),
    /**
     * Present only when the clone used an in-dialog credential. `no-helper`
     * asks the dialog to offer an explicit persistence choice; a stored or
     * failed auto-approve is informational.
     */
    credential: z
      .strictObject({
        used: z.boolean(),
        persistence: z.enum(['stored', 'no-helper', 'failed', 'not-applicable'])
      })
      .optional()
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
export type CloneAuthPayload = z.infer<typeof cloneAuthSchema>
export type CloneHttpsAuthPayload = z.infer<typeof cloneHttpsAuthSchema>
export type CloneStartInputPayload = z.infer<typeof cloneStartInputSchema>
export type CloneCancelInput = z.infer<typeof cloneCancelInputSchema>
export type ClonePersistInput = z.infer<typeof clonePersistInputSchema>
export type CloneSshStatusPayload = z.infer<typeof cloneSshStatusResultSchema>
export type CloneSshGeneratePayload = z.infer<typeof cloneSshGenerateResultSchema>
export type CloneSshTestPayload = z.infer<typeof cloneSshTestResultSchema>
export type CloneSshTrustHostPayload = z.infer<typeof cloneSshTrustHostResultSchema>
export type CloneProgressEventPayload = z.infer<typeof cloneProgressEventSchema>
export type CloneCredentialPayload = NonNullable<
  Extract<CloneProgressEventPayload, { type: 'done' }>['credential']
>

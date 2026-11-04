/**
 * iCode terminal-host protocol, v1.
 *
 * The host owns PTYs. Session IDs are durable iCode identities; incarnation IDs
 * name one PTY lifetime. Wire IDs stay opaque so the host does not depend on
 * iCode's ID formats.
 */

import { z } from 'zod'
import { HOST_FAILURE_CODES, type HostFailureCode } from './domain/errors'
import type { HostSessionStatus } from './domain/session'
import {
  absolutePathSchema,
  dimensionSchema,
  terminalInputSchema,
  timestampSchema,
  wireIdSchema,
  wireIncarnationIdSchema,
  wireSessionIdSchema
} from './schemas/primitives'

export const HOST_PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 4 * 1024 * 1024
export const MAX_REQUEST_TIMEOUT_MS = 60_000
export const HELLO_TIMEOUT_MS = 3_000

export type { HostFailureCode }
export type SessionStatus = HostSessionStatus

export const hostErrorSchema = z.strictObject({
  code: z.enum(HOST_FAILURE_CODES),
  message: z.string().min(1).max(500),
  detail: z.string().max(4000).optional()
})

export const hostHelloRequestSchema = z.strictObject({
  type: z.literal('hello'),
  protocolVersion: z.number().int().min(1).max(1000),
  token: z.string().min(1).max(512),
  clientId: wireIdSchema
})

export const hostHelloResponseSchema = z.strictObject({
  type: z.literal('hello'),
  ok: z.literal(true),
  protocolVersion: z.number().int().min(1).max(1000),
  hostPid: z.number().int().min(1),
  startedAt: timestampSchema,
  hostVersion: z.string().min(1).max(64)
})

export const hostHelloFailureSchema = z.strictObject({
  type: z.literal('hello'),
  ok: z.literal(false),
  error: hostErrorSchema
})

const requestBase = {
  type: z.literal('request'),
  id: wireIdSchema
} as const

export const createOrAttachParamsSchema = z.strictObject({
  sessionId: wireSessionIdSchema,
  cwd: absolutePathSchema,
  command: z.string().min(1).max(4096),
  /**
   * An argv array for ordinary spawns, or one raw command line for a Windows
   * `.cmd`/`.bat` shim started through cmd.exe. node-pty treats a string as a
   * verbatim command line, which is the only quoting that survives cmd /c.
   */
  args: z
    .union([z.array(z.string().max(4096)).max(128), z.string().max(65_536)])
    .optional(),
  cols: dimensionSchema,
  rows: dimensionSchema,
  attachOnly: z.boolean().optional()
})

export const createOrAttachRequestSchema = z.strictObject({
  ...requestBase,
  method: z.literal('createOrAttach'),
  params: createOrAttachParamsSchema
})

export const writeRequestSchema = z.strictObject({
  ...requestBase,
  method: z.literal('write'),
  params: z.strictObject({
    sessionId: wireSessionIdSchema,
    /** Must match the live PTY; a stale incarnation is rejected. */
    incarnationId: wireIncarnationIdSchema,
    data: terminalInputSchema
  })
})

export const resizeRequestSchema = z.strictObject({
  ...requestBase,
  method: z.literal('resize'),
  params: z.strictObject({
    sessionId: wireSessionIdSchema,
    incarnationId: wireIncarnationIdSchema,
    cols: dimensionSchema,
    rows: dimensionSchema
  })
})

export const shutdownIfIdleRequestSchema = z.strictObject({
  ...requestBase,
  method: z.literal('shutdownIfIdle'),
  params: z.strictObject({})
})

export const killRequestSchema = z.strictObject({
  ...requestBase,
  method: z.literal('kill'),
  params: z.strictObject({ sessionId: wireSessionIdSchema })
})

export const listSessionsRequestSchema = z.strictObject({
  ...requestBase,
  method: z.literal('listSessions'),
  params: z.strictObject({})
})

export const shutdownRequestSchema = z.strictObject({
  ...requestBase,
  method: z.literal('shutdown'),
  params: z.strictObject({})
})

export const pingRequestSchema = z.strictObject({
  ...requestBase,
  method: z.literal('ping'),
  params: z.strictObject({})
})

export const hostRequestSchema = z.discriminatedUnion('method', [
  createOrAttachRequestSchema,
  writeRequestSchema,
  resizeRequestSchema,
  killRequestSchema,
  listSessionsRequestSchema,
  shutdownIfIdleRequestSchema,
  shutdownRequestSchema,
  pingRequestSchema
])

export const hostSuccessResponseSchema = z.strictObject({
  type: z.literal('response'),
  id: wireIdSchema,
  ok: z.literal(true),
  payload: z.unknown()
})

export const hostErrorResponseSchema = z.strictObject({
  type: z.literal('response'),
  id: wireIdSchema,
  ok: z.literal(false),
  error: hostErrorSchema
})

export const hostResponseSchema = z.union([hostSuccessResponseSchema, hostErrorResponseSchema])


export const hostDataEventSchema = z.strictObject({
  type: z.literal('event'),
  event: z.literal('data'),
  sessionId: wireSessionIdSchema,
  incarnationId: wireIncarnationIdSchema,
  seq: z.number().int().nonnegative(),
  data: z.string().max(MAX_FRAME_BYTES)
})

export const hostExitEventSchema = z.strictObject({
  type: z.literal('event'),
  event: z.literal('exit'),
  sessionId: wireSessionIdSchema,
  incarnationId: wireIncarnationIdSchema,
  exitCode: z.number().int(),
  signal: z.number().int().optional(),
  /** True when iCode requested this termination; the exit code is still process truth. */
  requested: z.boolean().optional()
})

export const hostSpawnedEventSchema = z.strictObject({
  type: z.literal('event'),
  event: z.literal('spawned'),
  sessionId: wireSessionIdSchema,
  incarnationId: wireIncarnationIdSchema,
  ptyPid: z.number().int().min(1)
})

export const hostLaggedEventSchema = z.strictObject({
  type: z.literal('event'),
  event: z.literal('lagged'),
  sessionId: wireSessionIdSchema,
  incarnationId: wireIncarnationIdSchema,
  /** Last sequence the client is known to have received. */
  fromSeq: z.number().int().nonnegative(),
  /** Latest sequence available from the host. */
  toSeq: z.number().int().nonnegative(),
  message: z.string().max(300)
})

export const hostEventSchema = z
  .discriminatedUnion('event', [
    hostDataEventSchema,
    hostExitEventSchema,
    hostSpawnedEventSchema,
    hostLaggedEventSchema
  ])
  .refine((event) => event.sessionId !== event.incarnationId, {
    message: 'sessionId and incarnationId must be distinct'
  })

const sessionInfoShape = {
  sessionId: wireSessionIdSchema,
  incarnationId: wireIncarnationIdSchema,
  ptyPid: z.number().int().min(-1),
  cwd: absolutePathSchema,
  command: z.string().min(1).max(4096),
  cols: dimensionSchema,
  rows: dimensionSchema,
  status: z.enum(['starting', 'live', 'exited', 'failed']),
  exitCode: z.number().int().nullable(),
  /** Set once a kill request has been accepted for this incarnation. */
  stopRequested: z.boolean(),
  createdAt: timestampSchema
} as const

export const sessionInfoSchema = z
  .strictObject(sessionInfoShape)
  .refine((session) => session.sessionId !== session.incarnationId, {
    message: 'sessionId and incarnationId must be distinct'
  })

export const terminalSnapshotSchema = z.strictObject({
  /** Serialized terminal contents, including alternate-screen transitions. */
  data: z.string().max(MAX_FRAME_BYTES),
  cols: dimensionSchema,
  rows: dimensionSchema,
  /** Sequence of the last PTY chunk reflected in this snapshot. */
  seq: z.number().int().nonnegative(),
  alternateScreen: z.boolean(),
  cursor: z.strictObject({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative()
  }),
  scrollbackLines: z.number().int().nonnegative(),
  /** True when output older than the retained scrollback was dropped. */
  truncated: z.boolean()
})

export const createOrAttachPayloadSchema = z
  .strictObject({
    ...sessionInfoShape,
    created: z.boolean(),
    snapshot: terminalSnapshotSchema
  })
  .refine((session) => session.sessionId !== session.incarnationId, {
    message: 'sessionId and incarnationId must be distinct'
  })

export const listSessionsPayloadSchema = z.strictObject({
  hostPid: z.number().int().min(1),
  startedAt: timestampSchema,
  sessions: z.array(sessionInfoSchema).max(1024),
  liveSessions: z.number().int().nonnegative(),
  connectedClients: z.number().int().nonnegative()
})

export const shutdownIfIdlePayloadSchema = z.strictObject({
  shutdown: z.boolean(),
  reason: z.enum(['idle', 'live_sessions', 'connected_clients']).optional(),
  liveSessions: z.number().int().nonnegative(),
  connectedClients: z.number().int().nonnegative()
})

export const hostClientMessageSchema = z.union([hostHelloRequestSchema, hostRequestSchema])

export const hostServerMessageSchema = z.union([
  hostHelloResponseSchema,
  hostHelloFailureSchema,
  hostResponseSchema,
  hostEventSchema
])

export type HostError = z.infer<typeof hostErrorSchema>
export type HostHelloRequest = z.infer<typeof hostHelloRequestSchema>
export type HostHelloResponse = z.infer<typeof hostHelloResponseSchema>
export type HostHelloFailure = z.infer<typeof hostHelloFailureSchema>
export type HostRequest = z.infer<typeof hostRequestSchema>
export type HostResponse = z.infer<typeof hostResponseSchema>
export type HostDataEvent = z.infer<typeof hostDataEventSchema>
export type HostExitEvent = z.infer<typeof hostExitEventSchema>
export type HostSpawnedEvent = z.infer<typeof hostSpawnedEventSchema>
export type HostLaggedEvent = z.infer<typeof hostLaggedEventSchema>
export type HostEvent = z.infer<typeof hostEventSchema>
export type SessionInfo = z.infer<typeof sessionInfoSchema>
export type CreateOrAttachPayload = z.infer<typeof createOrAttachPayloadSchema>
export type ListSessionsPayload = z.infer<typeof listSessionsPayloadSchema>
export type TerminalSnapshot = z.infer<typeof terminalSnapshotSchema>
export type ShutdownIfIdlePayload = z.infer<typeof shutdownIfIdlePayloadSchema>

export type HostClientMessage = HostHelloRequest | HostRequest
export type HostServerMessage =
  | HostHelloResponse
  | HostHelloFailure
  | HostResponse
  | HostEvent
/** Back-compat alias from Work 1. */
export type HostWireMessage = HostResponse | HostEvent

/**
 * Version is checked separately from schema parsing so a mismatched client can
 * receive a structured UNSUPPORTED_VERSION reply instead of a generic parse error.
 */
export function checkHelloProtocolVersion(hello: Pick<HostHelloRequest, 'protocolVersion'>): HostError | null {
  if (hello.protocolVersion === HOST_PROTOCOL_VERSION) return null
  return {
    code: 'UNSUPPORTED_VERSION',
    message: `Host protocol is v${HOST_PROTOCOL_VERSION}, client sent v${String(hello.protocolVersion)}`
  }
}

/**
 * Events from a previous PTY must never touch a restarted session. A null
 * expected incarnation matches by session only (used before attach completes).
 */
export function isHostEventFor(
  event: HostEvent,
  expected: { sessionId: string; incarnationId: string | null }
): boolean {
  if (event.sessionId !== expected.sessionId) return false
  return expected.incarnationId === null ? true : event.incarnationId === expected.incarnationId
}

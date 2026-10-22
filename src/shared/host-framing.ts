import type { z } from 'zod'
import {
  MAX_FRAME_BYTES,
  hostEventSchema,
  hostHelloFailureSchema,
  hostHelloRequestSchema,
  hostHelloResponseSchema,
  hostRequestSchema,
  hostResponseSchema,
  type HostClientMessage,
  type HostError,
  type HostServerMessage
} from './host-protocol'

export type FrameError = HostError & {
  /** A framing violation that should end the connection rather than be answered. */
  fatal: boolean
}

export type FrameParseResult<T> = { ok: true; value: T } | { ok: false; error: FrameError }

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid message'
  if (issue.code === 'invalid_union') return 'does not match any supported message shape'
  const path = issue.path.join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

type JsonResult = { ok: true; value: unknown } | { ok: false; error: FrameError }

function readJson(raw: string): JsonResult {
  if (utf8ByteLength(raw) > MAX_FRAME_BYTES) {
    return {
      ok: false,
      error: {
        code: 'FRAME_TOO_LARGE',
        message: `Frame exceeds ${MAX_FRAME_BYTES} bytes`,
        fatal: true
      }
    }
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'Malformed JSON frame', fatal: true } }
  }
}

/** Durable and process identities must not be interchangeable on the wire. */
function identitiesAreDistinct(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true
  const record = value as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || typeof record.incarnationId !== 'string') return true
  return record.sessionId !== record.incarnationId
}

function validate<T>(schema: z.ZodType<T>, value: unknown): FrameParseResult<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    return {
      ok: false,
      error: { code: 'BAD_REQUEST', message: describeIssues(result.error), fatal: false }
    }
  }
  if (!identitiesAreDistinct(result.data)) {
    return {
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Session and incarnation IDs must be distinct',
        fatal: false
      }
    }
  }
  return { ok: true, value: result.data }
}

function unsupported(what: string): FrameParseResult<never> {
  return {
    ok: false,
    error: { code: 'BAD_REQUEST', message: `Unsupported ${what}`, fatal: false }
  }
}

export function parseHostClientFrame(raw: string): FrameParseResult<HostClientMessage> {
  const json = readJson(raw)
  if (!json.ok) return json
  const value = json.value
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return unsupported('host message type')
  }
  const type = (value as { type: unknown }).type
  if (type === 'hello') return validate(hostHelloRequestSchema, value)
  if (type === 'request') {
    const result = validate(hostRequestSchema, value)
    if (result.ok) return result
    const method = (value as { method?: unknown }).method
    if (typeof method === 'string' && !KNOWN_METHODS.has(method)) {
      return {
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          message: `Unsupported request method: ${method}`,
          fatal: false
        }
      }
    }
    return result
  }
  return unsupported('host message type')
}

const KNOWN_METHODS = new Set([
  'createOrAttach',
  'write',
  'resize',
  'kill',
  'listSessions',
  'shutdownIfIdle',
  'shutdown',
  'ping'
])

export function parseHostServerFrame(raw: string): FrameParseResult<HostServerMessage> {
  const json = readJson(raw)
  if (!json.ok) return json
  const value = json.value
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return unsupported('host message type')
  }
  const type = (value as { type: unknown }).type
  if (type === 'hello') {
    const success = hostHelloResponseSchema.safeParse(value)
    if (success.success) return { ok: true, value: success.data }
    return validate(hostHelloFailureSchema, value)
  }
  if (type === 'response') return validate(hostResponseSchema, value)
  if (type === 'event') return validate(hostEventSchema, value)
  return unsupported('host message type')
}

export function encodeHostFrame(message: HostClientMessage | HostServerMessage): string {
  return `${JSON.stringify(message)}\n`
}

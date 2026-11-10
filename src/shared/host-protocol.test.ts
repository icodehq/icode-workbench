import { describe, expect, it } from 'vitest'
import {
  HOST_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  checkHelloProtocolVersion,
  createOrAttachPayloadSchema,
  hostEventSchema,
  hostHelloResponseSchema,
  isHostEventFor,
  listSessionsPayloadSchema,
  type HostEvent
} from './host-protocol'
import { parseHostClientFrame, parseHostServerFrame } from './host-framing'

const sessionId = 'ses_00000000-0000-4000-8000-000000000000'
const incarnationId = '56260a795d16b072'

function dataEvent(overrides: Record<string, unknown> = {}): HostEvent {
  return {
    type: 'event',
    event: 'data',
    sessionId,
    incarnationId,
    seq: 7,
    data: 'hello\r\n',
    ...overrides
  } as HostEvent
}

describe('client frame parsing', () => {
  it('accepts a versioned hello', () => {
    const result = parseHostClientFrame(
      JSON.stringify({
        type: 'hello',
        protocolVersion: HOST_PROTOCOL_VERSION,
        token: 'a'.repeat(64),
        clientId: 'icode-main-123'
      })
    )
    expect(result.ok).toBe(true)
  })

  it('accepts a ping and a create request without optional args', () => {
    const ping = parseHostClientFrame(
      JSON.stringify({ type: 'request', id: 'r1', method: 'ping', params: {} })
    )
    expect(ping.ok).toBe(true)

    const create = parseHostClientFrame(
      JSON.stringify({
        type: 'request',
        id: 'r2',
        method: 'createOrAttach',
        params: {
          sessionId,
          cwd: '/home/dev/atlas',
          command: '/bin/bash',
          cols: 120,
          rows: 32
        }
      })
    )
    expect(create.ok).toBe(true)
  })

  it('accepts per-request provider env within the limits', () => {
    const params = {
      sessionId,
      cwd: '/home/dev/atlas',
      command: '/bin/bash',
      cols: 120,
      rows: 32,
      env: { ICODE_PROVIDER_API_KEY: 'sk-test' }
    }
    const accepted = parseHostClientFrame(
      JSON.stringify({ type: 'request', id: 'r1', method: 'createOrAttach', params })
    )
    expect(accepted.ok).toBe(true)

    const tooMany = parseHostClientFrame(
      JSON.stringify({
        type: 'request',
        id: 'r2',
        method: 'createOrAttach',
        params: {
          ...params,
          env: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`K${index}`, 'v'])
          )
        }
      })
    )
    expect(tooMany.ok).toBe(false)

    const tooLong = parseHostClientFrame(
      JSON.stringify({
        type: 'request',
        id: 'r3',
        method: 'createOrAttach',
        params: { ...params, env: { BIG: 'x'.repeat(16_385) } }
      })
    )
    expect(tooLong.ok).toBe(false)
  })

  it('rejects unknown methods explicitly', () => {
    const result = parseHostClientFrame(
      JSON.stringify({ type: 'request', id: 'r1', method: 'exec', params: {} })
    )
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error.code).toBe('BAD_REQUEST')
    expect(result.error.fatal).toBe(false)
    expect(result.error.message).toMatch(/supported request method|supported message shape/)
  })

  it('rejects an unknown top-level message type', () => {
    const result = parseHostClientFrame(JSON.stringify({ type: 'command', id: 'r1' }))
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error.code).toBe('BAD_REQUEST')
    expect(result.error.message).toContain('Unsupported host message type')
  })

  it('rejects unexpected fields at the trust boundary', () => {
    const result = parseHostClientFrame(
      JSON.stringify({ type: 'request', id: 'r1', method: 'ping', params: {}, extra: true })
    )
    expect(result.ok).toBe(false)
  })

  it('rejects malformed JSON as a fatal bad request', () => {
    const result = parseHostClientFrame('{')
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error).toMatchObject({ code: 'BAD_REQUEST', fatal: true })
  })

  it('rejects oversized frames before parsing', () => {
    const result = parseHostClientFrame('x'.repeat(MAX_FRAME_BYTES + 1))
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error).toMatchObject({ code: 'FRAME_TOO_LARGE', fatal: true })
  })

  it('rejects invalid dimensions and relative cwd', () => {
    const base = {
      type: 'request',
      id: 'r3',
      method: 'createOrAttach',
      params: { sessionId, cwd: 'relative/path', command: 'bash', cols: 0, rows: 24 }
    }
    expect(parseHostClientFrame(JSON.stringify(base)).ok).toBe(false)
  })
})

describe('protocol version', () => {
  it('parses a mismatched version and lets the host answer explicitly', () => {
    const parsed = parseHostClientFrame(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 3,
        token: 'b'.repeat(64),
        clientId: 'icode-main-123'
      })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.value.type !== 'hello') return
    const error = checkHelloProtocolVersion(parsed.value)
    expect(error?.code).toBe('UNSUPPORTED_VERSION')
    expect(error?.message).toContain('v3')
  })

  it('accepts the current version', () => {
    expect(checkHelloProtocolVersion({ protocolVersion: HOST_PROTOCOL_VERSION })).toBeNull()
  })
})

describe('server frame parsing', () => {
  it('accepts hello success and failure shapes', () => {
    expect(
      parseHostServerFrame(
        JSON.stringify({
          type: 'hello',
          ok: true,
          protocolVersion: 1,
          hostPid: 42,
          startedAt: 1,
          hostVersion: '0.1.0'
        })
      ).ok
    ).toBe(true)

    expect(
      parseHostServerFrame(
        JSON.stringify({
          type: 'hello',
          ok: false,
          error: { code: 'AUTH_FAILED', message: 'invalid token' }
        })
      ).ok
    ).toBe(true)
  })

  it('accepts success and error responses', () => {
    expect(
      parseHostServerFrame(
        JSON.stringify({ type: 'response', id: 'r1', ok: true, payload: { anything: 1 } })
      ).ok
    ).toBe(true)
    expect(
      parseHostServerFrame(
        JSON.stringify({
          type: 'response',
          id: 'r2',
          ok: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'unknown session' }
        })
      ).ok
    ).toBe(true)
  })

  it('rejects unknown error codes and unknown events', () => {
    expect(
      parseHostServerFrame(
        JSON.stringify({
          type: 'response',
          id: 'r3',
          ok: false,
          error: { code: 'MICODE_UP', message: 'nope' }
        })
      ).ok
    ).toBe(false)
    expect(parseHostServerFrame(JSON.stringify(dataEvent({ event: 'tick' }))).ok).toBe(false)
  })

  it('accepts a well-formed data event with an incarnation', () => {
    const result = parseHostServerFrame(JSON.stringify(dataEvent()))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ event: 'data', sessionId, incarnationId, seq: 7 })
  })

  it('rejects an event without an incarnation', () => {
    const event = dataEvent()
    const { incarnationId: _removed, ...withoutIncarnation } = event as Record<string, unknown> & {
      incarnationId?: string
    }
    void _removed
    expect(parseHostServerFrame(JSON.stringify(withoutIncarnation)).ok).toBe(false)
  })

  it('rejects an event whose session and incarnation IDs collide', () => {
    expect(
      hostEventSchema.safeParse({
        type: 'event',
        event: 'data',
        sessionId: 'abcdefgh',
        incarnationId: 'abcdefgh',
        seq: 1,
        data: 'x'
      }).success
    ).toBe(false)
    expect(
      parseHostServerFrame(
        JSON.stringify({
          type: 'event',
          event: 'data',
          sessionId: 'abcdefgh',
          incarnationId: 'abcdefgh',
          seq: 1,
          data: 'x'
        })
      ).ok
    ).toBe(false)
  })

  it('validates session lists and their identity split', () => {
    const base = {
      sessionId,
      incarnationId,
      ptyPid: 123,
      cwd: '/home/dev/atlas',
      command: '/bin/bash',
      cols: 80,
      rows: 24,
      status: 'live',
      exitCode: null,
      stopRequested: false,
      createdAt: 5
    }
    expect(
      listSessionsPayloadSchema.safeParse({
        hostPid: 1,
        startedAt: 2,
        sessions: [base],
        liveSessions: 1,
        connectedClients: 1
      }).success
    ).toBe(true)
    expect(
      listSessionsPayloadSchema.safeParse({
        hostPid: 1,
        startedAt: 2,
        sessions: [{ ...base, incarnationId: sessionId }],
        liveSessions: 1,
        connectedClients: 1
      }).success
    ).toBe(false)
    expect(
      createOrAttachPayloadSchema.safeParse({
        ...base,
        created: true,
        snapshot: {
          data: 'hello',
          cols: 80,
          rows: 24,
          seq: 0,
          alternateScreen: false,
          cursor: { x: 0, y: 0 },
          scrollbackLines: 0,
          truncated: false
        }
      }).success
    ).toBe(true)
    expect(
      createOrAttachPayloadSchema.safeParse({ ...base, created: true }).success
    ).toBe(false)
  })

  it('rejects invalid pids and dimensions in session info', () => {
    expect(
      listSessionsPayloadSchema.safeParse({
        hostPid: 1,
        startedAt: 2,
        sessions: [
          {
            sessionId,
            incarnationId,
            ptyPid: -2,
            cwd: '/tmp/repo',
            command: 'bash',
            cols: 80,
            rows: 24,
            status: 'live',
            exitCode: null,
            stopRequested: false,
            createdAt: 5
          }
        ],
        liveSessions: 0,
        connectedClients: 0
      }).success
    ).toBe(false)
  })
})

describe('host event identity guard', () => {
  it('accepts only the matching session and incarnation', () => {
    const event = dataEvent()
    expect(isHostEventFor(event, { sessionId, incarnationId })).toBe(true)
    expect(isHostEventFor(event, { sessionId: 'ses_other', incarnationId })).toBe(false)
    expect(isHostEventFor(event, { sessionId, incarnationId: '1234567890abcdef' })).toBe(false)
  })

  it('matches by session before an incarnation is known', () => {
    const event = dataEvent()
    expect(isHostEventFor(event, { sessionId, incarnationId: null })).toBe(true)
    expect(isHostEventFor(event, { sessionId: 'ses_other', incarnationId: null })).toBe(false)
  })

  it('drops a delayed event from a previous PTY after restart', () => {
    const stale = dataEvent()
    const restarted = { sessionId, incarnationId: 'fedcba0987654321' }
    expect(isHostEventFor(stale, restarted)).toBe(false)
  })

  it('parses a host hello response with a positive pid', () => {
    expect(
      hostHelloResponseSchema.safeParse({
        type: 'hello',
        ok: true,
        protocolVersion: 1,
        hostPid: 0,
        startedAt: 1,
        hostVersion: '0.1.0'
      }).success
    ).toBe(false)
  })
})

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityHookServer } from './hook-server'
import type { ActivityHookEvent } from '../../shared/domain/activity'

const roots: string[] = []
const running: ActivityHookServer[] = []

function socketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'ade-hook-sock-'))
  roots.push(root)
  return join(root, 'activity.sock')
}

function send(path: string, payload: string, options: { stall?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    let response = ''
    socket.on('data', (chunk) => {
      response += String(chunk)
    })
    socket.on('error', () => resolve(response))
    socket.on('close', () => resolve(response))
    socket.on('connect', () => {
      if (options.stall) return
      socket.end(payload)
    })
  })
}

type Verdict = 'accepted' | 'duplicate' | 'stale' | 'unknown-session' | 'stale-incarnation'

function start(
  ingest: (event: ActivityHookEvent) => Verdict = () => 'accepted'
): { server: ActivityHookServer; path: string; events: ActivityHookEvent[]; rejected: string[] } {
  const path = socketPath()
  const events: ActivityHookEvent[] = []
  const rejected: string[] = []
  const server = new ActivityHookServer({
    socketPath: path,
    ingest: (event) => {
      events.push(event)
      return ingest(event)
    },
    onRejected: (reason) => rejected.push(reason),
    readTimeoutMs: 300
  })
  running.push(server)
  return { server, path, events, rejected }
}

afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const VALID = JSON.stringify({
  event: 'PreToolUse',
  sessionId: 'ses_0123456789abcdef0123456789abcdef',
  incarnationId: 'abcdef1234567890',
  claudeSessionId: 'claude-1',
  promptId: 'prompt-1',
  toolName: 'Bash',
  sentAt: 1_700_000_000_000
})

describe('hook ingress', () => {
  it('accepts a valid payload and creates a 0700 socket', async () => {
    const { server, path, events } = start()
    await server.start()
    expect(existsSync(path)).toBe(true)
    await send(path, VALID)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: 'PreToolUse', toolName: 'Bash' })
  })

  it('drops malformed JSON and invalid payloads', async () => {
    const { server, path, events, rejected } = start()
    await server.start()
    await send(path, '{"event":')
    await send(path, JSON.stringify({ event: 'NotARealEvent', sessionId: 'x' }))
    await send(path, JSON.stringify({ ...JSON.parse(VALID), extra: true }))
    await send(path, '')
    expect(events).toHaveLength(0)
    expect(rejected).toEqual(
      expect.arrayContaining(['invalid-json', 'invalid-payload', 'empty-payload'])
    )
  })

  it('rejects a payload over 8 KiB without reading it', async () => {
    const { server, path, events, rejected } = start()
    await server.start()
    await send(path, JSON.stringify({ ...JSON.parse(VALID), padding: 'x'.repeat(9000) }))
    expect(events).toHaveLength(0)
    expect(rejected).toContain('payload-too-large')
  })

  it('closes a stalled client after the read timeout', async () => {
    const { server, path, events, rejected } = start()
    await server.start()
    await send(path, '', { stall: true })
    await new Promise((done) => setTimeout(done, 500))
    expect(events).toHaveLength(0)
    expect(rejected).toContain('read-timeout')
  })

  it('stops accepting events and removes the socket on stop', async () => {
    const { server, path } = start()
    await server.start()
    await server.stop()
    expect(existsSync(path)).toBe(false)
    running.length = 0
  })

  it('propagates the ingest verdict without throwing', async () => {
    const { server, path, events } = start(() => 'accepted')
    await server.start()
    await send(path, VALID)
    await send(path, VALID.replace('prompt-1', 'prompt-2'))
    expect(events).toHaveLength(2)
  })

  it('reports a rejection reason through the ingest result', async () => {
    const rejecter = vi.fn(() => 'stale-incarnation' as const)
    const { server, path } = start(rejecter)
    await server.start()
    await send(path, VALID)
    expect(rejecter).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAppError } from '../../../shared/domain/errors'
import type {
  IpcResult,
  RendererSessionEvent,
  SessionSummary,
  TerminalAttachPayload
} from '../../../shared/schemas/ipc'
import {
  SessionTerminal,
  type TerminalApi,
  type SessionTerminalOptions,
  type TerminalSink,
  type TerminalStatus
} from './session-terminal'

const SESSION_ID = 'ses_0123456789abcdef0123456789abcdef'
const INCARNATION = 'abcdef1234567890'
const NEXT_INCARNATION = 'abcdef1234567891'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function attachment(
  overrides: Partial<TerminalAttachPayload> = {}
): IpcResult<TerminalAttachPayload> {
  return {
    ok: true,
    value: {
      sessionId: SESSION_ID,
      incarnationId: INCARNATION,
      cols: 100,
      rows: 30,
      snapshot: 'SNAPSHOT',
      seq: 0,
      alternateScreen: false,
      cursor: { x: 0, y: 0 },
      scrollbackLines: 0,
      truncated: false,
      ...overrides
    }
  }
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: SESSION_ID,
    repoId: 'repo_0123456789abcdef0123456789abcdef',
    title: 'Test session',
    harness: 'shell',
    state: 'live',
    authority: 'host',
    reason: 'host_live',
    incarnationId: INCARNATION,
    exitCode: null,
    error: null,
    updatedAt: 1,
    worktree: null,
    activity: null,
    ...overrides
  }
}

function dataEvent(seq: number, data: string, incarnationId = INCARNATION): RendererSessionEvent {
  return { type: 'data', sessionId: SESSION_ID, incarnationId, seq, data }
}

type Harness = {
  terminal: TerminalApi
  emit: (event: RendererSessionEvent) => void
  attach: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  listenerCount: () => number
  sink: TerminalSink & { writes: string[]; resets: number; resizes: unknown[] }
  statuses: TerminalStatus[]
  controller: SessionTerminal
}

function harness(
  options: {
    maxResyncs?: number
    cooldown?: number
    bufferLimit?: number
    readOnly?: boolean
    onError?: (error: Parameters<NonNullable<SessionTerminalOptions['onError']>>[0]) => void
  } = {}
): Harness {
  const listeners = new Set<(event: RendererSessionEvent) => void>()
  const attach = vi.fn()
  const write = vi.fn().mockResolvedValue({ ok: true, value: null })
  const resize = vi.fn().mockResolvedValue({ ok: true, value: null })
  const terminal: TerminalApi = {
    terminal: {
      attach: attach as unknown as TerminalApi['terminal']['attach'],
      write: write as unknown as TerminalApi['terminal']['write'],
      resize: resize as unknown as TerminalApi['terminal']['resize']
    },
    onSessionEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const writes: string[] = []
  const sink = {
    writes,
    resets: 0,
    resizes: [] as unknown[],
    reset(): void {
      this.resets += 1
      writes.push('RESET')
    },
    write(data: string): void {
      writes.push(data)
    },
    resize(cols: number, rows: number): void {
      this.resizes.push([cols, rows])
    }
  }
  const statuses: TerminalStatus[] = []
  const controller = new SessionTerminal({
    sessionId: SESSION_ID,
    api: terminal,
    sink,
    onStatus: (status) => statuses.push(status),
    ...(options.onError ? { onError: options.onError } : {}),
    readOnly: options.readOnly === true,
    maxResyncs: options.maxResyncs ?? 3,
    resyncCooldownMs: options.cooldown ?? 0,
    ...(options.bufferLimit === undefined ? {} : { bufferLimitBytes: options.bufferLimit })
  })
  return {
    terminal,
    emit: (event) => {
      for (const listener of listeners) listener(event)
    },
    attach,
    write,
    resize,
    listenerCount: () => listeners.size,
    sink,
    statuses,
    controller
  }
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('attach and snapshot ordering', () => {
  it('applies the snapshot before buffered output and drops already-included sequences', async () => {
    const h = harness()
    const pending = deferred<IpcResult<TerminalAttachPayload>>()
    h.attach.mockReturnValueOnce(pending.promise)

    h.controller.start()
    // Output arriving during the attach round trip, including one sequence the
    // snapshot already contains and one after it.
    h.emit(dataEvent(5, 'FIVE'))
    h.emit(dataEvent(7, 'SEVEN'))
    pending.resolve(attachment({ snapshot: 'SNAPSHOT', seq: 6 }))
    await pending.promise
    await Promise.resolve()

    expect(h.sink.writes).toEqual(['RESET', 'SNAPSHOT', 'SEVEN'])
    expect(h.controller.getStatus().phase).toBe('live')
    expect(h.attach).toHaveBeenCalledTimes(1)
  })

  it('never types into or resizes a read-only wall preview', async () => {
    const h = harness({ readOnly: true })
    h.attach.mockResolvedValueOnce(attachment({ cols: 120, rows: 40 }))
    h.controller.start()
    await Promise.resolve()
    await Promise.resolve()

    expect(h.sink.writes).toEqual(['RESET', 'SNAPSHOT'])
    expect(await h.controller.write('ls\r')).toBe(false)
    h.controller.resize(80, 24)
    expect(h.write).not.toHaveBeenCalled()
    expect(h.resize).not.toHaveBeenCalled()
  })

  it('sorts buffered events and applies only contiguous sequences', async () => {
    const h = harness()
    const pending = deferred<IpcResult<TerminalAttachPayload>>()
    h.attach.mockReturnValueOnce(pending.promise)
    h.controller.start()
    h.emit(dataEvent(3, 'THREE'))
    h.emit(dataEvent(2, 'TWO'))
    pending.resolve(attachment({ seq: 1 }))
    await pending.promise
    await Promise.resolve()

    expect(h.sink.writes).toEqual(['RESET', 'SNAPSHOT', 'TWO', 'THREE'])
    expect(h.attach).toHaveBeenCalledTimes(1)
  })

  it('requests a fresh attach on a sequence gap instead of guessing missing output', async () => {
    const h = harness()
    h.attach
      .mockResolvedValueOnce(attachment({ seq: 10 }))
      .mockResolvedValueOnce(attachment({ seq: 13, snapshot: 'RESYNC' }))
    h.controller.start()
    await Promise.resolve()

    h.emit(dataEvent(11, 'ELEVEN'))
    h.emit(dataEvent(13, 'THIRTEEN'))
    await Promise.resolve()
    await Promise.resolve()

    expect(h.attach).toHaveBeenCalledTimes(2)
    // The gap event must not be written; the new snapshot is authoritative.
    expect(h.sink.writes).toEqual(['RESET', 'SNAPSHOT', 'ELEVEN', 'RESET', 'RESYNC'])
    expect(h.controller.getStatus().phase).toBe('live')
  })

  it('ignores data from a superseded process incarnation', async () => {
    const h = harness()
    h.attach.mockResolvedValueOnce(attachment())
    h.controller.start()
    await Promise.resolve()

    h.emit(dataEvent(1, 'OLD', NEXT_INCARNATION))
    h.emit(dataEvent(1, 'NEW', INCARNATION))
    expect(h.sink.writes).toEqual(['RESET', 'SNAPSHOT', 'NEW'])
    expect(h.controller.getStatus().phase).toBe('live')
  })

  it('discards an attach response superseded by a newer attempt', async () => {
    const h = harness()
    const first = deferred<IpcResult<TerminalAttachPayload>>()
    const second = deferred<IpcResult<TerminalAttachPayload>>()
    h.attach.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    h.controller.start()
    h.controller.retry()
    second.resolve(attachment({ snapshot: 'CURRENT' }))
    await second.promise
    await Promise.resolve()
    first.resolve(attachment({ snapshot: 'STALE' }))
    await first.promise
    await Promise.resolve()

    expect(h.sink.writes).toEqual(['RESET', 'CURRENT'])
    expect(h.controller.getStatus().phase).toBe('live')
  })
})

describe('buffering and resynchronization', () => {
  it('reports desynchronization when the pre-attach buffer overflows', async () => {
    const h = harness({ bufferLimit: 10 })
    const first = deferred<IpcResult<TerminalAttachPayload>>()
    const second = deferred<IpcResult<TerminalAttachPayload>>()
    h.attach.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    h.controller.start()
    h.emit(dataEvent(1, 'X'.repeat(50)))
    first.resolve(attachment({ seq: 0 }))
    await first.promise
    await Promise.resolve()
    await Promise.resolve()

    expect(h.attach).toHaveBeenCalledTimes(2)
    expect(h.controller.getStatus().phase).toBe('resyncing')
    expect(h.sink.writes).toEqual(['RESET', 'SNAPSHOT'])

    second.resolve(attachment({ seq: 50, snapshot: 'FRESH' }))
    await second.promise
    await Promise.resolve()
    expect(h.sink.writes).toEqual(['RESET', 'SNAPSHOT', 'RESET', 'FRESH'])
    expect(h.controller.getStatus().phase).toBe('live')
  })

  it('resynchronizes after a live state event and gives up after repeated failures', async () => {
    const h = harness({ maxResyncs: 2 })
    h.attach.mockResolvedValue(attachment())
    h.controller.start()
    await Promise.resolve()

    h.emit({ type: 'state', session: summary() })
    await Promise.resolve()
    expect(h.attach).toHaveBeenCalledTimes(2)

    h.emit({ type: 'state', session: summary() })
    await Promise.resolve()
    expect(h.attach).toHaveBeenCalledTimes(3)
    expect(h.controller.getStatus().phase).toBe('live')

    h.emit({ type: 'state', session: summary() })
    await Promise.resolve()
    expect(h.attach).toHaveBeenCalledTimes(3)
    expect(h.controller.getStatus().phase).toBe('error')
    expect(h.controller.getStatus().message).toContain('could not be resynchronized')
  })

  it('reattaches when a state event announces a new incarnation', async () => {
    const h = harness()
    h.attach
      .mockResolvedValueOnce(attachment({ snapshot: 'FIRST', seq: 1 }))
      .mockResolvedValueOnce(
        attachment({ snapshot: 'SECOND', seq: 1, incarnationId: NEXT_INCARNATION })
      )
    h.controller.start()
    await Promise.resolve()

    h.emit({
      type: 'state',
      session: summary({ incarnationId: NEXT_INCARNATION })
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(h.attach).toHaveBeenCalledTimes(2)
    expect(h.sink.writes).toEqual(['RESET', 'FIRST', 'RESET', 'SECOND'])
    expect(h.controller.currentIncarnationId).toBe(NEXT_INCARNATION)
  })

  it('does not resynchronize while the initial attach is still in flight', async () => {
    const h = harness()
    const pending = deferred<IpcResult<TerminalAttachPayload>>()
    h.attach.mockReturnValueOnce(pending.promise)
    h.controller.start()
    h.emit({ type: 'state', session: summary() })
    await Promise.resolve()
    expect(h.attach).toHaveBeenCalledTimes(1)
    pending.resolve(attachment())
    await pending.promise
    await Promise.resolve()
    expect(h.attach).toHaveBeenCalledTimes(1)
  })
})

describe('input and resize', () => {
  it('sends the latest size only after a successful attach', async () => {
    const h = harness()
    const pending = deferred<IpcResult<TerminalAttachPayload>>()
    h.attach.mockReturnValueOnce(pending.promise)
    h.controller.start()

    h.controller.resize(80, 24)
    h.controller.resize(120, 40)
    expect(h.resize).not.toHaveBeenCalled()

    pending.resolve(attachment())
    await pending.promise
    await Promise.resolve()

    expect(h.resize).toHaveBeenCalledTimes(1)
    expect(h.resize).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      incarnationId: INCARNATION,
      cols: 120,
      rows: 40
    })

    h.controller.resize(120, 40)
    await Promise.resolve()
    expect(h.resize).toHaveBeenCalledTimes(1)
  })

  it('writes input only while live and bound to the current incarnation', async () => {
    const h = harness()
    h.attach.mockResolvedValueOnce(attachment())
    h.controller.start()
    expect(await h.controller.write('early')).toBe(false)

    await Promise.resolve()
    expect(await h.controller.write('ls\n')).toBe(true)
    expect(h.write).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      incarnationId: INCARNATION,
      data: 'ls\n'
    })

    h.emit({
      type: 'state',
      session: summary({ state: 'exited', exitCode: 0, incarnationId: INCARNATION })
    })
    expect(await h.controller.write('late')).toBe(false)
  })

  it('surfaces a write failure without silently retrying', async () => {
    const onError = vi.fn()
    const h = harness({ onError })
    h.attach.mockResolvedValueOnce(attachment())
    h.controller.start()
    await Promise.resolve()
    h.write.mockResolvedValueOnce({
      ok: false,
      error: makeAppError('HOST_UNREACHABLE', 'Host unreachable')
    })

    expect(await h.controller.write('x')).toBe(false)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'HOST_UNREACHABLE' }))
    expect(h.controller.getStatus().phase).toBe('live')
  })
})

describe('failure and teardown', () => {
  it('reports attach failures and can retry', async () => {
    const h = harness()
    h.attach
      .mockResolvedValueOnce({
        ok: false,
        error: makeAppError('HOST_UNREACHABLE', 'Host unreachable')
      })
      .mockResolvedValueOnce(attachment({ snapshot: 'RECOVERED' }))
    h.controller.start()
    await Promise.resolve()

    expect(h.controller.getStatus().phase).toBe('error')
    expect(h.controller.getStatus().message).toContain('Host unreachable')

    h.controller.retry()
    await Promise.resolve()
    expect(h.sink.writes).toEqual(['RESET', 'RECOVERED'])
    expect(h.controller.getStatus().phase).toBe('live')
  })

  it('maps a missing session to unavailable instead of an unknown error', async () => {
    const h = harness()
    h.attach.mockResolvedValueOnce({
      ok: false,
      error: makeAppError('SESSION_NOT_FOUND', 'The host no longer owns this session.')
    })
    h.controller.start()
    await Promise.resolve()
    expect(h.controller.getStatus().phase).toBe('unavailable')
  })

  it('unsubscribes, ignores late events, and never stops the PTY', async () => {
    const h = harness()
    h.attach.mockResolvedValueOnce(attachment())
    h.controller.start()
    await Promise.resolve()
    expect(h.listenerCount()).toBe(1)

    h.controller.dispose()
    expect(h.listenerCount()).toBe(0)
    const before = [...h.sink.writes]
    h.emit(dataEvent(1, 'LATE'))
    await Promise.resolve()
    expect(h.sink.writes).toEqual(before)
  })

  it('ignores exit events from a previous incarnation', async () => {
    const h = harness()
    h.attach.mockResolvedValueOnce(attachment())
    h.controller.start()
    await Promise.resolve()

    h.emit({
      type: 'exit',
      sessionId: SESSION_ID,
      incarnationId: NEXT_INCARNATION,
      exitCode: 1
    })
    expect(h.controller.getStatus().phase).toBe('live')
  })
})

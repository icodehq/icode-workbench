import { describe, expect, it, vi } from 'vitest'
import { createAdeApi } from './api'
import { IPC_CHANNELS } from '../shared/schemas/ipc'
import { newRepoId, newSessionId } from '../shared/domain/ids'

const repoId = newRepoId()
const sessionId = newSessionId()
const incarnationId = 'abcdef1234567890'

function setup(): {
  api: ReturnType<typeof createAdeApi>
  invoke: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  emit: (payload: unknown) => void
  unsubscribe: ReturnType<typeof vi.fn>
} {
  const invoke = vi.fn(async () => ({ ok: true, value: null }))
  const unsubscribe = vi.fn()
  let listener: ((payload: unknown) => void) | null = null
  const subscribe = vi.fn((_channel: string, next: (payload: unknown) => void) => {
    listener = next
    return unsubscribe
  })
  const api = createAdeApi(
    invoke as unknown as (channel: string, input?: unknown) => Promise<unknown>,
    subscribe as unknown as (channel: string, listener: (payload: unknown) => void) => () => void
  )
  return {
    api,
    invoke,
    subscribe,
    unsubscribe,
    emit: (payload) => listener?.(payload)
  }
}

describe('preload API surface', () => {
  it('exposes only named business operations', () => {
    const { api } = setup()
    expect(Object.keys(api).sort()).toEqual(
      [
        'activity',
        'branches',
        'getRuntimeInfo',
        'harness',
        'onSessionEvent',
        'repos',
        'review',
        'sessions',
        'terminal'
      ].sort()
    )
    expect((api as unknown as { ipcRenderer?: unknown }).ipcRenderer).toBeUndefined()
    expect((api as unknown as { require?: unknown }).require).toBeUndefined()
  })

  it('routes repository operations to their channels', async () => {
    const { api, invoke } = setup()
    await api.repos.list()
    await api.repos.add({ path: '/tmp/repo' })
    await api.repos.remove({ repoId, acknowledgeDependentSessions: true })

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.reposList,
      IPC_CHANNELS.reposAdd,
      IPC_CHANNELS.reposRemove
    ])
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.reposAdd, { path: '/tmp/repo' })
  })

  it('routes session and terminal operations', async () => {
    const { api, invoke } = setup()
    await api.sessions.list({ repoId })
    await api.sessions.get({ sessionId })
    await api.sessions.create({ repoId, harness: 'claude', cols: 100, rows: 30 })
    await api.sessions.close({ sessionId })
    await api.sessions.restart({ sessionId })
    await api.terminal.attach({ sessionId })
    await api.terminal.write({ sessionId, incarnationId, data: 'ls\r' })
    await api.terminal.resize({ sessionId, incarnationId, cols: 120, rows: 40 })
    await api.harness.list()

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.sessionsList,
      IPC_CHANNELS.sessionsGet,
      IPC_CHANNELS.sessionsCreate,
      IPC_CHANNELS.sessionsClose,
      IPC_CHANNELS.sessionsRestart,
      IPC_CHANNELS.terminalAttach,
      IPC_CHANNELS.terminalWrite,
      IPC_CHANNELS.terminalResize,
      IPC_CHANNELS.harnessList
    ])
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.terminalWrite, {
      sessionId,
      incarnationId,
      data: 'ls\r'
    })
  })
})

describe('session event subscription', () => {
  it('subscribes once for multiple listeners and fans out', () => {
    const { api, subscribe, emit } = setup()
    const first = vi.fn()
    const second = vi.fn()
    api.onSessionEvent(first)
    api.onSessionEvent(second)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls[0]![0]).toBe(IPC_CHANNELS.sessionEvent)

    const event = { type: 'exit', sessionId, incarnationId, exitCode: 0 } as const
    emit(event)
    expect(first).toHaveBeenCalledWith(event)
    expect(second).toHaveBeenCalledWith(event)
  })

  it('disposes one listener without affecting others', () => {
    const { api, emit } = setup()
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = api.onSessionEvent(first)
    api.onSessionEvent(second)

    disposeFirst()
    emit({ type: 'data', sessionId, incarnationId, seq: 1, data: 'x' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes the channel after the last listener is disposed', () => {
    const { api, unsubscribe, emit } = setup()
    const dispose = api.onSessionEvent(vi.fn())
    expect(unsubscribe).not.toHaveBeenCalled()
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(() => emit({ type: 'data', sessionId, incarnationId, seq: 1, data: 'x' })).not.toThrow()
  })

  it('makes disposal idempotent', () => {
    const { api, unsubscribe } = setup()
    const dispose = api.onSessionEvent(vi.fn())
    dispose()
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('resubscribes after all listeners were removed', () => {
    const { api, subscribe } = setup()
    const disposeFirst = api.onSessionEvent(vi.fn())
    disposeFirst()
    api.onSessionEvent(vi.fn())
    expect(subscribe).toHaveBeenCalledTimes(2)
  })
})

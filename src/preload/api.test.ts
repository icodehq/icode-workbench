import { describe, expect, it, vi } from 'vitest'
import { createIcodeApi } from './api'
import { IPC_CHANNELS } from '../shared/schemas/ipc'
import { newRepoId, newSessionId } from '../shared/domain/ids'

const repoId = newRepoId()
const sessionId = newSessionId()
const incarnationId = 'abcdef1234567890'

function setup(): {
  api: ReturnType<typeof createIcodeApi>
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
  const api = createIcodeApi(
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
        'ai',
        'assistant',
        'branches',
        'files',
        'getRuntimeInfo',
        'git',
        'harness',
        'locale',
        'onRepoEvent',
        'onSessionEvent',
        'onTaskEvent',
        'onViewCommand',
        'providers',
        'repos',
        'schedules',
        'sessions',
        'supervisor',
        'tasks',
        'terminal',
        'window',
        // Distro discovery for the repository dialog: named, no channel strings.
        'wsl'
      ].sort()
    )
    expect((api as unknown as { ipcRenderer?: unknown }).ipcRenderer).toBeUndefined()
    expect((api as unknown as { require?: unknown }).require).toBeUndefined()
  })

  it('routes repository operations to their channels', async () => {
    const { api, invoke } = setup()
    await api.repos.list()
    await api.repos.add({ path: '/tmp/repo' })
    await api.repos.inspect({ path: '/tmp/repo', target: { kind: 'local' } })
    await api.repos.initialize({ path: '/tmp/repo', target: { kind: 'local' } })
    await api.repos.retryPreparation({ repoId })
    await api.repos.remove({ repoId, acknowledgeDependentSessions: true })

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.reposList,
      IPC_CHANNELS.reposAdd,
      IPC_CHANNELS.reposInspect,
      IPC_CHANNELS.reposInitialize,
      IPC_CHANNELS.reposRetryPreparation,
      IPC_CHANNELS.reposRemove
    ])
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.reposAdd, { path: '/tmp/repo' })
  })

  it('routes commit-message generation and cancellation to their channels', async () => {
    const { api, invoke } = setup()
    await api.ai.commitMessage({ sessionId, requestId: 'request-123' })
    await api.ai.cancelCommitMessage({ requestId: 'request-123' })
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.aiCommitMessage, {
      sessionId,
      requestId: 'request-123'
    })
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.aiCancelCommitMessage, {
      requestId: 'request-123'
    })
  })

  it('routes Mira calls to their named channels', async () => {
    const { api, invoke } = setup()
    await api.assistant.state()
    await api.assistant.messages({ threadId: 'thread_1' })
    await api.assistant.conversations()
    await api.assistant.notifications({ limit: 5 })
    await api.assistant.focus({ messageId: 'msg_1' })
    await api.assistant.send({ text: 'Hello' })
    await api.assistant.markRead({ threadId: 'thread_1' })
    await api.assistant.stop()
    await api.assistant.newConversation()
    await api.assistant.settings()
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.assistantState,
      IPC_CHANNELS.assistantMessagesList,
      IPC_CHANNELS.assistantConversationsList,
      IPC_CHANNELS.assistantNotificationsList,
      IPC_CHANNELS.assistantFocus,
      IPC_CHANNELS.assistantSend,
      IPC_CHANNELS.assistantMarkRead,
      IPC_CHANNELS.assistantStop,
      IPC_CHANNELS.assistantNewConversation,
      IPC_CHANNELS.assistantSettingsGet
    ])
  })

  it('routes window controls and maximize events', async () => {
    const { api, invoke, subscribe, unsubscribe } = setup()
    await api.window.minimize()
    await api.window.toggleMaximize()
    await api.window.close()
    await api.window.isMaximized()
    await api.window.openExternal({ url: 'https://example.com/docs' })
    const off = api.window.onMaximizedChange(() => undefined)

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.windowMinimize,
      IPC_CHANNELS.windowToggleMaximize,
      IPC_CHANNELS.windowClose,
      IPC_CHANNELS.windowIsMaximized,
      IPC_CHANNELS.windowOpenExternal
    ])
    expect(subscribe).toHaveBeenCalledWith(IPC_CHANNELS.windowMaximizedEvent, expect.any(Function))
    off()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('exposes the initial locale synchronously and routes locale changes', async () => {
    const invoke = vi.fn(async (_channel: string, _input?: unknown) => ({
      ok: true,
      value: { preference: 'de', locale: 'de', systemLocale: 'en' }
    }))
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (payload: unknown) => void) => unsubscribe
    )
    const api = createIcodeApi(
      invoke as unknown as (channel: string, input?: unknown) => Promise<unknown>,
      subscribe as unknown as (
        channel: string,
        listener: (payload: unknown) => void
      ) => () => void,
      'de'
    )

    expect(api.locale.initial).toBe('de')
    await api.locale.get()
    await api.locale.set({ preference: 'ja' })
    const off = api.locale.onChanged(() => undefined)

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.localeGet,
      IPC_CHANNELS.localeSet
    ])
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.localeSet, { preference: 'ja' })
    expect(subscribe).toHaveBeenCalledWith(IPC_CHANNELS.localeChangedEvent, expect.any(Function))
    off()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
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

  it('routes working-tree change operations to the Git channels', async () => {
    const { api, invoke } = setup()
    const diffInput = {
      sessionId,
      path: 'src/app.ts',
      oldPath: null,
      scope: 'unstaged' as const,
      status: 'modified' as const,
      binary: false,
      symlink: false,
      additions: 1,
      deletions: 0
    }
    await api.git.changeDiff(diffInput)
    await api.git.sessionChanges({ sessionId })

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.gitInvoke,
      IPC_CHANNELS.gitInvoke
    ])
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.gitInvoke, {
      op: 'changeDiff',
      input: diffInput
    })
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.gitInvoke, {
      op: 'sessionChanges',
      input: { sessionId }
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

  it('forwards native View commands without exposing channel strings', () => {
    const { api, subscribe, emit } = setup()
    const listener = vi.fn()
    api.onViewCommand(listener)
    expect(subscribe.mock.calls[0]![0]).toBe(IPC_CHANNELS.viewCommand)
    emit('focus')
    expect(listener).toHaveBeenCalledWith('focus')
  })
})

describe('provider operations', () => {
  it('routes list/create/update/remove/select/test to their channels', async () => {
    const { api, invoke } = setup()
    const providerId = 'prv_00000000-0000-4000-8000-000000000001'
    await api.providers.list()
    await api.providers.create({
      harness: 'claude',
      name: 'Relay',
      baseUrl: 'https://relay.example.com',
      model: 'claude-sonnet-5',
      apiKey: 'sk-test',
      authStyle: 'auth_token'
    })
    await api.providers.update({
      id: providerId,
      harness: 'claude',
      name: 'Relay',
      baseUrl: 'https://relay.example.com',
      model: 'claude-sonnet-5'
    })
    await api.providers.remove({ providerId })
    await api.providers.select({ harness: 'claude', providerId: null })
    await api.providers.test({ providerId })

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.providersList,
      IPC_CHANNELS.providersCreate,
      IPC_CHANNELS.providersUpdate,
      IPC_CHANNELS.providersRemove,
      IPC_CHANNELS.providersSelect,
      IPC_CHANNELS.providersTest
    ])
  })
})

describe('wsl distro discovery', () => {
  it('routes to its own channel and passes no input', async () => {
    const { api, invoke } = setup()
    invoke.mockResolvedValue({ ok: true, value: { status: 'ok', distros: [], defaultRegistrationId: null } })
    await api.wsl.listDistros()
    expect(invoke.mock.calls.at(-1)?.[0]).toBe(IPC_CHANNELS.wslListDistros)
    expect(invoke.mock.calls.at(-1)?.[1]).toBeUndefined()
  })

  it('leaves "unavailable" as a resolved value, not a rejection', async () => {
    const { api, invoke } = setup()
    const payload = { ok: true as const, value: { status: 'unavailable' as const, reason: 'registry_unreadable' as const, detail: 'denied' } }
    invoke.mockResolvedValue(payload)
    await expect(api.wsl.listDistros()).resolves.toEqual(payload)
  })
})

describe('task retry and continue', () => {
  it('routes each intent to its own channel', async () => {
    const { api, invoke } = setup()
    await api.tasks.retry({ taskId: 'task_1' })
    await api.tasks.resume({ taskId: 'task_1' })
    expect(invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.tasksRetry, { taskId: 'task_1' })
    expect(invoke).toHaveBeenNthCalledWith(2, IPC_CHANNELS.tasksResume, { taskId: 'task_1' })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantService, type AssistantRunnerLike } from './assistant-service'
import { AssistantStore } from '../persistence/assistant-store'
import { makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function fixture(runner?: AssistantRunnerLike): {
  service: AssistantService
  store: AssistantStore
} {
  const root = makeTempRoot()
  cleanups.push(() => root.cleanup())
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  const store = new AssistantStore(db)
  let id = 0
  const service = new AssistantService({
    store,
    now: () => 1_000 + id,
    newId: (prefix) => `${prefix}_${String(++id)}`,
    ...(runner === undefined ? {} : { runner })
  })
  service.start()
  return { service, store }
}

async function waitForIdle(service: AssistantService): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (service.state().status !== 'working') return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Mira did not become idle.')
}

describe('AssistantService', () => {
  it('creates one thread, marks the welcome read, and reports offline without a runner', async () => {
    const { service } = fixture()
    const state = service.state()
    expect(state.personaName).toBe('Mira')
    expect(state.unread).toBe(0)
    expect(state.status).toBe('offline')
    expect(service.listMessages({ threadId: state.threadId })).toHaveLength(1)

    const sent = await service.send({ text: 'Hello' })
    expect(sent.message.role).toBe('user')
    const messages = service.listMessages({ threadId: state.threadId })
    expect(messages.some((message) => message.kind === 'error')).toBe(true)
  })

  it('streams a fake runner reply, tracks unread, and marks read', async () => {
    const runner: AssistantRunnerLike = {
      run: vi.fn(async () => ({ messages: [{ body: 'Hello back.' }] })),
      stop: vi.fn()
    }
    const { service } = fixture(runner)
    const state = service.state()
    expect(state.status).toBe('idle')

    await service.send({ text: 'Hello' })
    await waitForIdle(service)
    const messages = service.listMessages({ threadId: state.threadId })
    expect(messages.map((message) => message.body)).toContain('Hello back.')
    expect(service.state().unread).toBe(1)

    expect(service.markRead({ threadId: state.threadId })).toBe(0)
  })

  it('relays runner progress and draft deltas', async () => {
    const runner: AssistantRunnerLike = {
      run: vi.fn(async (_input, onEvent) => {
        onEvent?.({
          type: 'progress',
          stage: 'calling',
          harness: 'claude',
          target: 'local',
          round: 0
        })
        onEvent?.({ type: 'delta', text: 'Hel' })
        return { messages: [{ body: 'Hello' }] }
      }),
      stop: vi.fn()
    }
    const { service } = fixture(runner)
    const events: Array<{ type: string; [key: string]: unknown }> = []
    service.subscribe((event) => events.push(event as never))
    await service.send({ text: 'Hello' })
    await waitForIdle(service)
    expect(
      events.some(
        (event) =>
          event.type === 'run' && event.stage === 'calling' && event.target === 'local'
      )
    ).toBe(true)
    expect(events.some((event) => event.type === 'delta' && event.text === 'Hel')).toBe(true)
  })

  it('leaves the working state when the runner reports an error', async () => {
    const runner: AssistantRunnerLike = {
      run: vi.fn(async () => ({
        messages: [
          { role: 'system' as const, kind: 'error' as const, body: 'API Error: 503' }
        ],
        status: 'error' as const,
        error: 'API Error: 503'
      })),
      stop: vi.fn()
    }
    const { service } = fixture(runner)
    const state = service.state()
    await service.send({ text: 'Hello' })
    await waitForIdle(service)
    expect(service.state().status).toBe('error')
    const messages = service.listMessages({ threadId: state.threadId })
    expect(messages.some((message) => message.body === 'API Error: 503')).toBe(true)
  })

  it('rejects a second send while a run is active', async () => {
    let resolveRun!: (value: { messages: Array<{ body: string }> }) => void
    const runner: AssistantRunnerLike = {
      run: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRun = resolve
          }) as ReturnType<AssistantRunnerLike['run']>
      ),
      stop: vi.fn()
    }
    const { service } = fixture(runner)
    await service.send({ text: 'First' })
    await expect(service.send({ text: 'Second' })).rejects.toMatchObject({
      code: 'ASSISTANT_BUSY'
    })
    resolveRun({ messages: [{ body: 'First done.' }] })
    await waitForIdle(service)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessId } from '../../shared/domain/harness'
import type { AssistantSettings } from '../../shared/domain/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'
import type { OneShotResult } from '../ai/harness-one-shot'
import { AssistantRunner } from './assistant-runner'
import { AssistantStore } from '../persistence/assistant-store'
import { makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { newRepoId } from '../../shared/domain/ids'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function detection(harness: HarnessId) {
  return {
    state: 'available',
    harness,
    version: 'test',
    resolvedPath: '/bin/echo',
    diagnostics: {},
    command: { command: '/bin/echo', args: [] }
  } as never
}

function claudeOutput(sessionId: string, envelope: object): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
    JSON.stringify({
      type: 'result',
      is_error: false,
      session_id: sessionId,
      result: JSON.stringify(envelope)
    })
  ].join('\n')
}

function codexOutput(threadId: string, envelope: object): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: threadId }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(envelope) }
    }),
    JSON.stringify({ type: 'turn.completed', usage: {} })
  ].join('\n')
}

function output(partial: Partial<OneShotResult> = {}): OneShotResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    outputOverflow: false,
    ...partial
  }
}

function makeFixture(input: {
  runOneShot: (options: { onStdoutChunk?: (chunk: string) => void }) => Promise<OneShotResult>
  settings?: () => AssistantSettings
  execute?: ReturnType<typeof vi.fn>
}) {
  const root = makeTempRoot()
  cleanups.push(() => root.cleanup())
  const db = openTempDatabase(root)
  cleanups.push(() => db.close())
  const store = new AssistantStore(db)
  store.insertThread({
    id: 'thread_main',
    kind: 'main',
    title: 'Mira',
    createdAt: 1_000,
    updatedAt: 1_000,
    lastMessageAt: null,
    lastReadSeq: 0,
    activeRunId: null,
    archivedAt: null
  })
  const execute =
    input.execute ?? vi.fn(async (action: { op: string }) => ({
      op: action.op,
      ok: true,
      message: 'ok',
      value: {}
    }))
  // Real one-shot runs stream stdout to the listener; the mocks must too or
  // session-id observation never fires.
  const runOneShot = async (options: { onStdoutChunk?: (chunk: string) => void }) => {
    const result = await input.runOneShot(options)
    if (result.stdout.length > 0) options.onStdoutChunk?.(result.stdout)
    return result
  }
  const runner = new AssistantRunner({
    store,
    actionsFor: () => ({ execute }) as never,
    taskStore: { list: () => [], countAutoDispatchedSince: () => 0 } as never,
    tasks: { maxConcurrent: () => 2 } as never,
    repositories: { list: () => [] } as never,
    sessions: { list: async () => ({ sessions: [], orphans: [] }) } as never,
    settings: input.settings ?? (() => DEFAULT_ASSISTANT_SETTINGS),
    detectHarness: async (harness) => detection(harness),
    listWslDistros: async () => ({
      status: 'ok',
      distros: [],
      defaultRegistrationId: null
    }),
    readGuestHome: async () => null,
    wslRunner: {} as never,
    workspaceTrust: {
      prepare: async () => ({ status: 'unsupported' }),
      remove: async () => undefined
    },
    userDataDir: root.dir,
    runOneShot: runOneShot as never,
    now: () => 1_000
  })

  let counter = 0
  const addTurn = (text: string) => {
    counter += 1
    const message = store.appendMessage({
      id: `msg_${String(counter)}`,
      threadId: 'thread_main',
      role: 'user',
      kind: 'text',
      body: text,
      createdAt: 1_000 + counter
    })!
    const runId = `run_${String(counter)}`
    store.createRun({
      id: runId,
      threadId: 'thread_main',
      trigger: 'user',
      harness: 'claude',
      startedAt: 1_000 + counter
    })
    return { messageId: message.id, runId, text }
  }

  const runTurn = (text: string) => {
    const turn = addTurn(text)
    return runner.run({
      threadId: 'thread_main',
      runId: turn.runId,
      messageId: turn.messageId,
      startedAt: 1_000,
      text
    })
  }

  return { db, store, runner, runTurn, execute }
}

describe('AssistantRunner native continuity', () => {
  it('captures a fresh native id and resumes it on the next turn', async () => {
    const runOneShot = vi
      .fn()
      .mockResolvedValueOnce(output({ stdout: claudeOutput('session-1', { reply: 'noted', actions: [] }) }))
      .mockResolvedValueOnce(output({ stdout: claudeOutput('session-1', { reply: 'ORCHID', actions: [] }) }))
    const { store, runTurn } = makeFixture({ runOneShot })

    await runTurn('remember ORCHID')
    expect(store.findActiveConversation('thread_main')).toMatchObject({
      nativeSessionId: 'session-1',
      startSeq: 1
    })

    store.appendMessage({
      id: 'msg_card',
      threadId: 'thread_main',
      role: 'assistant',
      kind: 'card',
      body: 'Queued docs.',
      card: { type: 'task', taskId: 'task_1', repoId: newRepoId(), title: 'Docs', status: 'queued', approval: 'approved' },
      createdAt: 1_100
    })
    store.appendMessage({
      id: 'msg_note',
      threadId: 'thread_main',
      role: 'assistant',
      kind: 'notification',
      body: 'A task failed.',
      notificationKind: 'task-failed',
      notificationPriority: 'high',
      notificationState: 'pending',
      createdAt: 1_101
    })

    const result = await runTurn('what codeword?')
    const secondCall = runOneShot.mock.calls.at(-1)?.[0] as {
      args: string[]
      prompt: string
    }
    expect(secondCall.args).toContain('--resume')
    expect(secondCall.args).toContain('session-1')
    expect(secondCall.prompt).toContain('## Current state')
    expect(secondCall.prompt).toContain('## User\nwhat codeword?')
    expect(secondCall.prompt).not.toContain('## Recent conversation')
    expect(secondCall.prompt).not.toContain('remember ORCHID')
    expect(secondCall.prompt).toContain('- [card] Queued docs.')
    expect(secondCall.prompt).toContain('- [notification] A task failed.')
    expect(result.messages[0]).toMatchObject({ body: 'ORCHID' })
  })

  it('bridges the recent thread when the harness changes', async () => {
    let settings = DEFAULT_ASSISTANT_SETTINGS
    const runOneShot = vi
      .fn()
      .mockResolvedValueOnce(output({ stdout: claudeOutput('session-1', { reply: 'noted', actions: [] }) }))
      .mockResolvedValueOnce(output({ stdout: codexOutput('thread-1', { reply: 'switched', actions: [] }) }))
    const { store, runTurn } = makeFixture({
      runOneShot,
      settings: () => settings
    })

    await runTurn('remember ORCHID')
    settings = { ...DEFAULT_ASSISTANT_SETTINGS, harnessPriority: ['codex'] }
    const result = await runTurn('what codeword?')

    const call = runOneShot.mock.calls.at(-1)?.[0] as { args: string[]; prompt: string }
    expect(call.args).toContain('--json')
    expect(call.args).not.toContain('--ephemeral')
    expect(call.prompt).toContain('## Recent conversation')
    expect(result.messages[0]).toMatchObject({ body: 'switched' })
    expect(
      store.listMessages('thread_main', { limit: 50 }).some(
        (message) =>
          message.role === 'system' &&
          message.body.includes('Switched to codex')
      )
    ).toBe(true)
    expect(store.findActiveConversation('thread_main')).toMatchObject({
      harness: 'codex',
      nativeSessionId: 'thread-1'
    })
    const conversations = store.listConversations('thread_main')
    expect(conversations).toHaveLength(2)
    expect(conversations[0]).toMatchObject({ harness: 'claude', endSeq: 1 })
    expect(conversations[1]).toMatchObject({ harness: 'codex', startSeq: 2 })
  })

  it('starts a clean conversation after a user reset', async () => {
    const runOneShot = vi
      .fn()
      .mockResolvedValueOnce(output({ stdout: claudeOutput('session-1', { reply: 'noted', actions: [] }) }))
      .mockResolvedValueOnce(output({ stdout: claudeOutput('session-2', { reply: 'fresh', actions: [] }) }))
    const { store, runTurn } = makeFixture({ runOneShot })

    await runTurn('remember ORCHID')
    expect(
      store.resetActiveConversation('thread_main', { reason: 'user', now: 2_000 })
    ).not.toBeNull()
    const result = await runTurn('what codeword?')

    const call = runOneShot.mock.calls.at(-1)?.[0] as { prompt: string }
    expect(call.prompt).not.toContain('## Recent conversation')
    expect(call.prompt).not.toContain('remember ORCHID')
    expect(result.messages[0]).toMatchObject({ body: 'fresh' })
  })

  it('retries once fresh when the native conversation is missing', async () => {
    const runOneShot = vi
      .fn()
      .mockResolvedValueOnce(output({ stdout: claudeOutput('session-1', { reply: 'noted', actions: [] }) }))
      .mockResolvedValueOnce(
        output({ exitCode: 1, stderr: 'No conversation found with session ID: session-1' })
      )
      .mockResolvedValueOnce(output({ stdout: claudeOutput('session-2', { reply: 'recovered', actions: [] }) }))
    const { store, runTurn } = makeFixture({ runOneShot })

    await runTurn('remember ORCHID')
    const result = await runTurn('what codeword?')

    expect(runOneShot).toHaveBeenCalledTimes(3)
    const fallbackCall = runOneShot.mock.calls.at(-1)?.[0] as { args: string[]; prompt: string }
    expect(fallbackCall.args).not.toContain('--resume')
    expect(fallbackCall.prompt).toContain('## Recent conversation')
    expect(result.messages[0]).toMatchObject({ body: 'recovered' })
    expect(store.findActiveConversation('thread_main')?.nativeSessionId).toBe('session-2')
    expect(
      store.listMessages('thread_main', { limit: 50 }).some(
        (message) => message.role === 'system' && message.body.includes('could not resume')
      )
    ).toBe(true)
  })

  it('does not execute a read twice when a read round falls back', async () => {
    const execute = vi.fn(async (action: { op: string }) => ({
      op: action.op,
      ok: true,
      message: 'read done',
      value: { tasks: [] }
    }))
    const runOneShot = vi
      .fn()
      .mockResolvedValueOnce(
        output({
          stdout: claudeOutput('session-1', {
            reply: 'Checking',
            actions: [{ op: 'tasks.listAll' }]
          })
        })
      )
      .mockResolvedValueOnce(
        output({ exitCode: 1, stderr: 'No conversation found with session ID: session-1' })
      )
      .mockResolvedValueOnce(
        output({ stdout: claudeOutput('session-2', { reply: 'done', actions: [] }) })
      )
    const { store, runTurn } = makeFixture({ runOneShot, execute })

    const result = await runTurn('check tasks')

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith({ op: 'tasks.listAll' })
    expect(store.findActiveConversation('thread_main')?.lastPromptSeq).toBe(1)
    const fallbackCall = runOneShot.mock.calls.at(-1)?.[0] as { prompt: string }
    expect(fallbackCall.prompt).toContain('## Tool results (this round)')
    expect(fallbackCall.prompt).toContain('read done')
    expect(result.messages[0]).toMatchObject({ body: 'done' })
  })

  it('persists an observed id before a mid-run failure', async () => {
    const runOneShot = vi.fn(async (options: { onStdoutChunk?: (chunk: string) => void }) => {
      options.onStdoutChunk?.(
        `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' })}\n`
      )
      throw new Error('harness crashed')
    })
    const { store, runTurn } = makeFixture({ runOneShot })

    await runTurn('remember ORCHID')
    expect(store.findActiveConversation('thread_main')?.nativeSessionId).toBe('session-1')
  })
})

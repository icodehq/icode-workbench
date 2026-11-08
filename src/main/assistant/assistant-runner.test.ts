import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantRunner } from './assistant-runner'
import { AssistantStore } from '../persistence/assistant-store'
import { makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'
import type { AssistantActionResult } from './assistant-actions'
import { newRepoId } from '../../shared/domain/ids'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const detection = {
  state: 'available',
  harness: 'claude',
  version: 'test',
  resolvedPath: '/bin/echo',
  diagnostics: {},
  command: { command: '/bin/echo', args: [] }
} as never

const oneShot = (stdout: string) => ({
  stdout,
  stderr: '',
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  outputOverflow: false
})

describe('AssistantRunner', () => {
  it('runs reads first, then writes, and returns the reply plus a card', async () => {
    const root = makeTempRoot()
    cleanups.push(() => root.cleanup())
    const db = openTempDatabase(root)
    cleanups.push(() => db.close())
    const store = new AssistantStore(db)
    const now = 1_000
    const thread = store.insertThread({
      id: 'thread_main',
      kind: 'main',
      title: 'Mira',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      lastReadSeq: 0,
      activeRunId: null,
      archivedAt: null
    })
    store.appendMessage({
      id: 'msg_user',
      threadId: thread.id,
      role: 'user',
      kind: 'text',
      body: 'Create a task',
      createdAt: now
    })
    store.createRun({
      id: 'run_1',
      threadId: thread.id,
      trigger: 'user',
      harness: 'claude',
      startedAt: now
    })

    const repoId = newRepoId()
    const execute = vi.fn(async (action: { op: string }): Promise<AssistantActionResult> => {
      if (action.op === 'tasks.create') {
        return {
          op: action.op,
          ok: true,
          message: 'Queued it.',
          card: {
            type: 'task',
            taskId: 'task_1',
            repoId: 'repo_x',
            title: 'Docs',
            status: 'queued',
            approval: 'approved',
            autoApproved: true
          }
        }
      }
      return { op: action.op, ok: true, message: 'Read done.', value: { tasks: [] } }
    })
    const runOneShot = vi
      .fn()
      .mockResolvedValueOnce(
        oneShot(JSON.stringify({ reply: 'Checking', actions: [{ op: 'tasks.listAll' }] }))
      )
      .mockResolvedValueOnce(
        oneShot(
          JSON.stringify({
            reply: 'Queued it.',
            actions: [{ op: 'tasks.create', repoId, prompt: 'Write docs.' }]
          })
        )
      )

    const runner = new AssistantRunner({
      store,
      actionsFor: () => ({ execute }) as never,
      taskStore: { list: () => [], countAutoDispatchedSince: () => 0 } as never,
      tasks: { maxConcurrent: () => 2 } as never,
      repositories: { list: () => [] } as never,
      sessions: { list: async () => ({ sessions: [], orphans: [] }) } as never,
      settings: () => DEFAULT_ASSISTANT_SETTINGS,
      detectHarness: async () => detection,
      listWslDistros: async () => ({ status: 'ok', distros: [], defaultRegistrationId: null }),
      readGuestHome: async () => null,
      wslRunner: {} as never,
      workspaceTrust: {
        prepare: async () => ({ status: 'unsupported' }),
        remove: async () => undefined
      },
      userDataDir: root.dir,
      runOneShot,
      now: () => now
    })

    const result = await runner.run({
      threadId: thread.id,
      runId: 'run_1',
      messageId: 'msg_user',
      startedAt: now,
      text: 'Create a task'
    })

    expect(runOneShot).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledWith({ op: 'tasks.listAll' })
    expect(execute).toHaveBeenCalledWith({
      op: 'tasks.create',
      repoId,
      prompt: 'Write docs.'
    })
    expect(result.harness).toBe('claude')
    expect(result.messages[0]).toMatchObject({ body: 'Queued it.' })
    expect(result.messages[1]).toMatchObject({
      kind: 'card',
      card: { type: 'task', taskId: 'task_1' }
    })
    expect(store.findRun('run_1')).toMatchObject({ status: 'running', round: 1 })
  })
})

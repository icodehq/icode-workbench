import { afterEach, describe, expect, it } from 'vitest'
import { AssistantRunner } from './assistant-runner'
import { AssistantStore } from '../persistence/assistant-store'
import { makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'
import { createHarnessDetector } from '../harness/harness-detector'
import { WslCommandRunner } from '../wsl/exec'
import type { OneShotRunOptions } from '../ai/harness-one-shot'
import { runHarnessOneShot } from '../ai/harness-one-shot'

const real = process.env.ICODE_ASSISTANT_REAL === '1'
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe.skipIf(!real)('Mira with real Claude', () => {
  it('returns a parsed envelope from the real headless harness', async () => {
    const root = makeTempRoot('icode-mira-real-')
    cleanups.push(() => root.cleanup())
    const db = openTempDatabase(root)
    cleanups.push(() => db.close())
    const store = new AssistantStore(db)
    const now = Date.now()
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
      body: 'Return REAL_OK',
      createdAt: now
    })
    store.createRun({
      id: 'run_1',
      threadId: thread.id,
      trigger: 'user',
      harness: 'claude',
      startedAt: now
    })
    const detector = createHarnessDetector()
    const runner = new AssistantRunner({
      store,
      actionsFor: () => ({ execute: async () => ({ op: 'state', ok: true, message: 'unused' }) }) as never,
      taskStore: { list: () => [], countAutoDispatchedSince: () => 0 } as never,
      tasks: { maxConcurrent: () => 1 } as never,
      repositories: { list: () => [] } as never,
      sessions: { list: async () => ({ sessions: [], orphans: [] }) } as never,
      settings: () => DEFAULT_ASSISTANT_SETTINGS,
      detectHarness: async (harness) => detector.detectOne(harness),
      listWslDistros: async () => ({ status: 'ok', distros: [], defaultRegistrationId: null }),
      readGuestHome: async () => null,
      wslRunner: new WslCommandRunner(),
      workspaceTrust: {
        prepare: async () => ({ status: 'unsupported' }),
        remove: async () => undefined
      },
      userDataDir: root.dir,
      now: () => Date.now()
    })

    const deltas: string[] = []
    const stages: string[] = []
    const result = await runner.run(
      {
        threadId: thread.id,
        runId: 'run_1',
        messageId: 'msg_user',
        startedAt: now,
        text: 'Return exactly this JSON and nothing else: {"reply":"REAL_OK","actions":[]}'
      },
      (event) => {
        if (event.type === 'delta') deltas.push(event.text)
        else if (event.type === 'progress') stages.push(event.stage)
      }
    )
    expect(result.harness).toBe('claude')
    expect(result.messages.some((message) => message.body.includes('REAL_OK'))).toBe(true)
    expect(stages).toContain('calling')
    expect(deltas.some((text) => text.includes('REAL_OK'))).toBe(true)
  }, 180_000)

  it('resumes the native conversation on the next user turn', async () => {
    const root = makeTempRoot('icode-mira-real-resume-')
    cleanups.push(() => root.cleanup())
    const db = openTempDatabase(root)
    cleanups.push(() => db.close())
    const store = new AssistantStore(db)
    const now = Date.now()
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
    const detector = createHarnessDetector()
    const calls: OneShotRunOptions[] = []
    const runner = new AssistantRunner({
      store,
      actionsFor: () => ({ execute: async () => ({ op: 'state', ok: true, message: 'unused' }) }) as never,
      taskStore: { list: () => [], countAutoDispatchedSince: () => 0 } as never,
      tasks: { maxConcurrent: () => 1 } as never,
      repositories: { list: () => [] } as never,
      sessions: { list: async () => ({ sessions: [], orphans: [] }) } as never,
      settings: () => DEFAULT_ASSISTANT_SETTINGS,
      detectHarness: async (harness) => detector.detectOne(harness),
      listWslDistros: async () => ({ status: 'ok', distros: [], defaultRegistrationId: null }),
      readGuestHome: async () => null,
      wslRunner: new WslCommandRunner(),
      workspaceTrust: {
        prepare: async () => ({ status: 'unsupported' }),
        remove: async () => undefined
      },
      userDataDir: root.dir,
      runOneShot: async (options) => {
        calls.push(options)
        return runHarnessOneShot(options)
      },
      now: () => Date.now()
    })

    const first = store.appendMessage({
      id: 'msg_1',
      threadId: thread.id,
      role: 'user',
      kind: 'text',
      body: 'Remember ORCHID',
      createdAt: now
    })!
    store.createRun({
      id: 'run_1',
      threadId: thread.id,
      trigger: 'user',
      harness: 'claude',
      startedAt: now
    })
    await runner.run({
      threadId: thread.id,
      runId: 'run_1',
      messageId: first.id,
      startedAt: now,
      text: 'Remember the codeword ORCHID. Reply with exactly this JSON and nothing else: {"reply":"noted","actions":[]}'
    })
    const sessionId = store.findActiveConversation(thread.id)?.nativeSessionId
    if (sessionId === null || sessionId === undefined) {
      throw new Error('Claude did not report a native session id.')
    }
    expect(sessionId.length).toBeGreaterThan(0)

    const second = store.appendMessage({
      id: 'msg_2',
      threadId: thread.id,
      role: 'user',
      kind: 'text',
      body: 'What codeword?',
      createdAt: now + 1
    })!
    store.createRun({
      id: 'run_2',
      threadId: thread.id,
      trigger: 'user',
      harness: 'claude',
      startedAt: now + 1
    })
    const result = await runner.run({
      threadId: thread.id,
      runId: 'run_2',
      messageId: second.id,
      startedAt: now + 1,
      text: 'What codeword did I ask you to remember? Reply with exactly this JSON and nothing else: {"reply":"<the codeword>","actions":[]}'
    })

    expect(calls).toHaveLength(2)
    expect(calls[1]?.args).toContain('--resume')
    expect(calls[1]?.args).toContain(sessionId)
    expect(calls[1]?.prompt).not.toContain('## Recent conversation')
    expect(result.messages[0]?.body).toContain('ORCHID')
  }, 180_000)
})

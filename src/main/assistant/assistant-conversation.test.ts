import { afterEach, describe, expect, it } from 'vitest'
import { AssistantStore } from '../persistence/assistant-store'
import { makeTempRoot, openTempDatabase } from '../persistence/persistence-test-fixtures'
import {
  resetConversationForUser,
  resolveConversation,
  retireForResumeFailure,
  type ConversationSelection
} from './assistant-conversation'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const LOCAL_CLAUDE: ConversationSelection = {
  harness: 'claude',
  targetKind: 'local',
  targetDistro: null
}

function fixture(): {
  store: AssistantStore
  threadId: string
  newId: (prefix: string) => string
} {
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
  let counter = 0
  return {
    store,
    threadId: 'thread_main',
    newId: (prefix) => `${prefix}_${String(++counter)}`
  }
}

function addUser(store: AssistantStore, id: string): number {
  return store.appendMessage({
    id,
    threadId: 'thread_main',
    role: 'user',
    kind: 'text',
    body: id,
    createdAt: 2_000
  })!.seq
}

function makeActive(
  store: AssistantStore,
  id: string,
  startSeq: number,
  overrides: Partial<Parameters<AssistantStore['insertConversation']>[0]> = {}
): void {
  store.insertConversation({
    id,
    threadId: 'thread_main',
    harness: 'claude',
    targetKind: 'local',
    targetDistro: null,
    historyMode: 'bridge',
    startSeq,
    createdAt: 2_000,
    ...overrides
  })
}

describe('Mira conversation segments', () => {
  it('starts the first segment at the welcome and bridges history', () => {
    const { store, threadId, newId } = fixture()
    addUser(store, 'u1')
    const plan = resolveConversation({
      store,
      threadId,
      selection: LOCAL_CLAUDE,
      startSeq: 1,
      now: 2_000,
      newId
    })
    expect(plan.conversation.startSeq).toBe(1)
    expect(plan.includeHistory).toBe(true)
    expect(plan.resumeSessionId).toBeNull()
    expect(plan.boundaryBody).toBeNull()
  })

  it('resumes the active conversation without creating a segment', () => {
    const { store, threadId, newId } = fixture()
    addUser(store, 'u1')
    makeActive(store, 'conv_existing', 1)
    store.setConversationSession('conv_existing', 'session_1', 2_000)
    addUser(store, 'u2')
    const plan = resolveConversation({
      store,
      threadId,
      selection: LOCAL_CLAUDE,
      startSeq: 2,
      now: 2_000,
      newId
    })
    expect(plan.conversation.id).toBe('conv_existing')
    expect(plan.resumeSessionId).toBe('session_1')
    expect(plan.includeHistory).toBe(false)
    expect(store.listConversations(threadId)).toHaveLength(1)
  })

  it('ends the old segment before the current user message on a harness switch', () => {
    const { store, threadId, newId } = fixture()
    addUser(store, 'u1')
    makeActive(store, 'conv_existing', 1)
    addUser(store, 'u2')
    const plan = resolveConversation({
      store,
      threadId,
      selection: { harness: 'codex', targetKind: 'local', targetDistro: null },
      startSeq: 2,
      now: 2_000,
      newId
    })
    expect(store.findConversation('conv_existing')).toMatchObject({
      state: 'reset',
      resetReason: 'harness-changed',
      endSeq: 1
    })
    expect(plan.conversation).toMatchObject({ harness: 'codex', startSeq: 2 })
    expect(plan.includeHistory).toBe(true)
    expect(plan.boundaryBody).toContain('Switched to codex')
  })

  it('closes the old segment at the boundary on a manual reset', () => {
    const { store, threadId, newId } = fixture()
    addUser(store, 'u1')
    makeActive(store, 'conv_existing', 1)
    const reset = resetConversationForUser({ store, threadId, now: 2_000, newId })
    expect(reset?.message).toMatchObject({ role: 'system', kind: 'status' })
    expect(reset?.message.seq).toBe(2)
    expect(store.findConversation('conv_existing')).toMatchObject({
      state: 'reset',
      resetReason: 'user',
      endSeq: 2
    })
    expect(store.findActiveConversation(threadId)).toBeNull()

    const plan = resolveConversation({
      store,
      threadId,
      selection: LOCAL_CLAUDE,
      startSeq: 3,
      now: 2_000,
      newId
    })
    expect(plan.conversation).toMatchObject({ startSeq: 3, historyMode: 'clean' })
    expect(plan.includeHistory).toBe(false)
    expect(store.findConversation('conv_existing')?.endSeq).toBe(2)
  })

  it('invalidates and bridges on a resume failure', () => {
    const { store, threadId, newId } = fixture()
    addUser(store, 'u1')
    makeActive(store, 'conv_existing', 1)
    store.setConversationSession('conv_existing', 'session_1', 2_000)
    addUser(store, 'u2')
    const result = retireForResumeFailure({
      store,
      threadId,
      activeConversationId: 'conv_existing',
      reason: 'resume-failed',
      selection: LOCAL_CLAUDE,
      startSeq: 2,
      now: 2_000,
      newId
    })
    expect(store.findConversation('conv_existing')).toMatchObject({
      state: 'invalid',
      resetReason: 'resume-failed',
      endSeq: 1
    })
    expect(result.conversation).toMatchObject({ startSeq: 2, state: 'active' })
    expect(result.boundaryBody).toContain('could not resume')
  })
})

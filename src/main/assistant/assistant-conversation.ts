import type { AssistantConversation } from '../../shared/domain/assistant'
import type {
  AssistantMessageRecord,
  AssistantStore
} from '../persistence/assistant-store'

export type ConversationSelection = {
  harness: AssistantConversation['harness']
  targetKind: AssistantConversation['targetKind']
  targetDistro: string | null
}

export type ConversationPlan = {
  conversation: AssistantConversation
  resumeSessionId: string | null
  includeHistory: boolean
  firstPromptMode: 'full' | 'resumed'
  boundaryBody: string | null
}

function targetLabel(selection: ConversationSelection): string {
  return selection.targetKind === 'wsl'
    ? `wsl:${selection.targetDistro ?? 'unknown'}`
    : 'local'
}

/**
 * Resolves which native conversation the next turn belongs to.
 *
 * An active row with the same harness and target is resumed. A changed
 * harness/target retires it and starts a bridged conversation. With no active
 * row, a just-retired `reset/user` row means a clean slate; every other case
 * bridges the recent thread so a harness switch is not amnesia.
 */
export function resolveConversation(input: {
  store: AssistantStore
  threadId: string
  selection: ConversationSelection
  /** Seq of the user message that started this turn. */
  startSeq: number
  now: number
  newId: (prefix: string) => string
}): ConversationPlan {
  const active = input.store.findActiveConversation(input.threadId)

  if (active !== null) {
    const harnessChanged = active.harness !== input.selection.harness
    const targetChanged =
      active.targetKind !== input.selection.targetKind ||
      active.targetDistro !== input.selection.targetDistro
    if (harnessChanged || targetChanged) {
      const reason = harnessChanged ? 'harness-changed' : 'target-changed'
      input.store.retireConversation(active.id, {
        state: 'reset',
        reason,
        now: input.now,
        endSeq: input.startSeq - 1
      })
      const created = input.store.insertConversation({
        id: input.newId('conv'),
        threadId: input.threadId,
        harness: input.selection.harness,
        targetKind: input.selection.targetKind,
        targetDistro: input.selection.targetDistro,
        historyMode: 'bridge',
        startSeq: input.startSeq,
        createdAt: input.now
      })
      return {
        conversation: created,
        resumeSessionId: null,
        includeHistory: true,
        firstPromptMode: 'full',
        boundaryBody: harnessChanged
          ? `Switched to ${input.selection.harness}. Mira started a new ${input.selection.harness} conversation and kept the recent thread as context.`
          : `Switched to ${targetLabel(input.selection)}. Mira started a new agent conversation and kept the recent thread as context.`
      }
    }

    if (active.nativeSessionId !== null) {
      return {
        conversation: active,
        resumeSessionId: active.nativeSessionId,
        includeHistory: false,
        firstPromptMode: 'resumed',
        boundaryBody: null
      }
    }

    return {
      conversation: active,
      resumeSessionId: null,
      includeHistory: active.historyMode === 'bridge',
      firstPromptMode: 'full',
      boundaryBody: null
    }
  }

  const latest = input.store.findLatestConversation(input.threadId)
  const clean = latest !== null && latest.state === 'reset' && latest.resetReason === 'user'
  const created = input.store.insertConversation({
    id: input.newId('conv'),
    threadId: input.threadId,
    harness: input.selection.harness,
    targetKind: input.selection.targetKind,
    targetDistro: input.selection.targetDistro,
    historyMode: clean ? 'clean' : 'bridge',
    // The first-ever segment includes the welcome; later segments start at
    // the user message that caused the split.
    startSeq: latest === null ? 1 : input.startSeq,
    createdAt: input.now
  })
  return {
    conversation: created,
    resumeSessionId: null,
    includeHistory: !clean,
    firstPromptMode: 'full',
    boundaryBody: null
  }
}

/** Manual "New conversation": retire the handle but keep the transcript. */
export function resetConversationForUser(input: {
  store: AssistantStore
  threadId: string
  now: number
  newId: (prefix: string) => string
}): { conversation: AssistantConversation; message: AssistantMessageRecord } | null {
  const active = input.store.findActiveConversation(input.threadId)
  if (active === null) return null
  // The boundary belongs to the segment being retired, so append it first and
  // then close the segment at the boundary's seq.
  const message = input.store.appendMessage({
    id: input.newId('msg'),
    threadId: input.threadId,
    role: 'system',
    kind: 'status',
    body: 'New conversation. Earlier messages stay in this thread, but Mira will not use them as context.',
    createdAt: input.now
  })
  const retired = input.store.retireConversation(active.id, {
    state: 'reset',
    reason: 'user',
    now: input.now,
    ...(message === null ? {} : { endSeq: message.seq })
  })
  return message === null || retired === null
    ? null
    : { conversation: retired, message }
}

/** A resume attempt failed: invalidate it and start a bridged conversation. */
export function retireForResumeFailure(input: {
  store: AssistantStore
  threadId: string
  activeConversationId: string
  reason: Extract<
    AssistantConversation['resetReason'],
    'resume-failed' | 'resume-unsupported'
  >
  selection: ConversationSelection
  /** Seq of the user message that started this turn. */
  startSeq: number
  now: number
  newId: (prefix: string) => string
}): { conversation: AssistantConversation; boundaryBody: string } {
  const retired = input.store.retireConversation(input.activeConversationId, {
    state: 'invalid',
    reason: input.reason,
    now: input.now,
    endSeq: input.startSeq - 1
  })
  if (retired === null) {
    const current = input.store.findActiveConversation(input.threadId)
    if (current !== null) return { conversation: current, boundaryBody: '' }
  }
  const created = input.store.insertConversation({
    id: input.newId('conv'),
    threadId: input.threadId,
    harness: input.selection.harness,
    targetKind: input.selection.targetKind,
    targetDistro: input.selection.targetDistro,
    historyMode: 'bridge',
    startSeq: input.startSeq,
    createdAt: input.now
  })
  const harness = retired?.harness ?? input.selection.harness
  return {
    conversation: created,
    boundaryBody:
      input.reason === 'resume-unsupported'
        ? `This ${harness} version cannot resume a conversation, so Mira will rebuild context from this thread each turn.`
        : `Mira could not resume the previous ${harness} conversation, so she started a new one. Recent messages are still available as context.`
  }
}

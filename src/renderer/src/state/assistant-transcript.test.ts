import { describe, expect, it } from 'vitest'
import type {
  AssistantConversationPayload,
  AssistantMessagePayload
} from '../../../shared/schemas/assistant'
import {
  computeHasMore,
  conversationLabel,
  defaultConversationId,
  isNotificationMessage,
  mergeNewest,
  prependOlder,
  visibleMessages
} from './assistant-transcript'

function message(
  id: string,
  seq: number,
  overrides: Partial<AssistantMessagePayload> = {}
): AssistantMessagePayload {
  return {
    id,
    threadId: 'thread_1',
    seq,
    runId: null,
    role: 'assistant',
    kind: 'text',
    body: id,
    card: null,
    notificationKind: null,
    notificationPriority: null,
    notificationState: null,
    createdAt: seq,
    ...overrides
  }
}

function conversation(
  id: string,
  startSeq: number,
  overrides: Partial<AssistantConversationPayload> = {}
): AssistantConversationPayload {
  return {
    id,
    threadId: 'thread_1',
    harness: 'claude',
    targetKind: 'local',
    targetDistro: null,
    state: 'reset',
    resetReason: 'user',
    startSeq,
    endSeq: null,
    createdAt: startSeq,
    updatedAt: startSeq,
    ...overrides
  }
}

describe('assistant transcript helpers', () => {
  it('chooses the active conversation, otherwise the highest start', () => {
    expect(defaultConversationId([])).toBeNull()
    expect(
      defaultConversationId([
        conversation('old', 1),
        conversation('active', 9, { state: 'active', resetReason: null }),
        conversation('newer-reset', 20)
      ])
    ).toBe('active')
    expect(defaultConversationId([conversation('old', 1), conversation('newer', 9)])).toBe(
      'newer'
    )
  })

  it('hides notifications except the focused deep-link target', () => {
    const notification = message('n1', 1, {
      kind: 'notification',
      notificationKind: 'task-failed'
    })
    expect(isNotificationMessage(notification)).toBe(true)
    expect(visibleMessages([message('m1', 2), notification], null).map((m) => m.id)).toEqual([
      'm1'
    ])
    expect(
      visibleMessages([message('m1', 2), notification], 'n1').map((m) => m.id)
    ).toEqual(['m1', 'n1'])
  })

  it('merges overlapping newest pages and replaces a disconnected one', () => {
    const b = message('b', 2)
    const current = [message('a', 1), b]
    expect(mergeNewest(current, [b, message('c', 3)]).map((m) => m.id)).toEqual([
      'a',
      'b',
      'c'
    ])
    expect(mergeNewest(current, [b])).toBe(current)
    expect(mergeNewest(current, [message('e', 9)]).map((m) => m.id)).toEqual(['e'])
    expect(mergeNewest([], [message('e', 9)])).toHaveLength(1)
  })

  it('prepends older pages without duplicates and sorts by seq', () => {
    const d = message('d', 4)
    const current = [d, message('e', 5)]
    expect(
      prependOlder(current, [message('b', 2), message('c', 3), d]).map((m) => m.id)
    ).toEqual(['b', 'c', 'd', 'e'])
    expect(prependOlder(current, [])).toBe(current)
    expect(prependOlder(current, [d])).toBe(current)
  })

  it('computes hasMore from the page and the segment start', () => {
    expect(
      computeHasMore([message('a', 10), message('b', 11)], conversation('c', 1), true)
    ).toBe(true)
    expect(
      computeHasMore([message('a', 1), message('b', 2)], conversation('c', 1), true)
    ).toBe(false)
    expect(computeHasMore([message('a', 10)], conversation('c', 1), false)).toBe(false)
    expect(computeHasMore([], conversation('c', 1), true)).toBe(false)
  })

  it('labels current, latest-retired and earlier segments', () => {
    expect(
      conversationLabel(
        conversation('active', 1, { state: 'active', resetReason: null }),
        true
      )
    ).toContain('Current conversation')
    expect(conversationLabel(conversation('retired', 1), true)).toContain(
      'Latest conversation'
    )
    const earlier = conversationLabel(conversation('old', 1), false)
    expect(earlier).toContain('Earlier')
    expect(earlier).toContain('new conversation')
    expect(earlier).toContain('claude/local')
  })
})

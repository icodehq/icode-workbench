import { describe, expect, it } from 'vitest'
import type { GroupThreadPayload } from '../../../shared/schemas/groups'
import { mergeLocalRead } from './group-thread-read'

function thread(overrides: Partial<GroupThreadPayload> = {}): GroupThreadPayload {
  return {
    id: 'thread_1',
    groupId: 'group_1',
    title: 'Thread',
    isDefault: false,
    lastReadSeq: 0,
    lastReadAt: 0,
    lastActivityAt: 0,
    latestAuthorName: null,
    latestText: null,
    latestAt: null,
    unread: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('merge local read', () => {
  it('keeps a stale refresh from resurrecting unread', () => {
    expect(mergeLocalRead(thread({ lastReadSeq: 2, unread: 2 }), 3)).toMatchObject({
      lastReadSeq: 3,
      unread: 1
    })
    expect(mergeLocalRead(thread({ lastReadSeq: 0, unread: 1 }), 1)).toMatchObject({
      lastReadSeq: 1,
      unread: 0
    })
  })

  it('trusts a payload that already read past the local watermark', () => {
    const payload = thread({ lastReadSeq: 8, unread: 2 })
    expect(mergeLocalRead(payload, 3)).toBe(payload)
  })

  it('ignores a thread this window never read', () => {
    const payload = thread({ lastReadSeq: 2, unread: 4 })
    expect(mergeLocalRead(payload, undefined)).toBe(payload)
  })
})

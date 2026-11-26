import { describe, expect, it } from 'vitest'
import { ITEM_GROUP_ORDER, itemIsSnoozed, itemIsStale, itemStatus } from './item'

const now = Date.UTC(2026, 10, 26)
const day = 24 * 60 * 60 * 1000

describe('item status', () => {
  it('maps the task queue and review gates', () => {
    expect(itemStatus({ status: 'queued', approval: 'pending' })).toBe('needs_you')
    expect(itemStatus({ status: 'queued', approval: 'approved' })).toBe('planned')
    expect(itemStatus({ status: 'dispatching' })).toBe('working')
    expect(itemStatus({ status: 'running' })).toBe('working')
    expect(itemStatus({ status: 'waiting' })).toBe('waiting')
    expect(itemStatus({ status: 'failed' })).toBe('needs_you')
    expect(itemStatus({ status: 'completed', reviewDecision: 'pending' })).toBe('needs_you')
    expect(itemStatus({ status: 'completed', reviewDecision: 'accepted' })).toBe('done')
    expect(itemStatus({ status: 'completed', reviewDecision: 'rejected' })).toBe('canceled')
    expect(itemStatus({ status: 'cancelled' })).toBe('canceled')
  })

  it('lets an open owner question override open work', () => {
    expect(itemStatus({ status: 'running' }, { openQuestion: true })).toBe('needs_you')
    expect(itemStatus({ status: 'waiting' }, { openQuestion: true })).toBe('needs_you')
    expect(itemStatus({ status: 'completed', reviewDecision: 'accepted' }, { openQuestion: true })).toBe(
      'done'
    )
  })

  it('keeps the panel group order stable', () => {
    expect(ITEM_GROUP_ORDER[0]).toBe('needs_you')
    expect(ITEM_GROUP_ORDER.at(-1)).toBe('canceled')
  })
})

describe('item staleness and snooze', () => {
  it('flags open items that have not moved, unless snoozed', () => {
    expect(itemIsStale('needs_you', now - 8 * day, now)).toBe(true)
    expect(itemIsStale('working', now - 6 * day, now)).toBe(false)
    expect(itemIsStale('done', now - 30 * day, now)).toBe(false)
    expect(itemIsStale('needs_you', now - 30 * day, now, { snoozedUntil: now + day })).toBe(false)
  })

  it('reads a snooze window', () => {
    expect(itemIsSnoozed(now + 1, now)).toBe(true)
    expect(itemIsSnoozed(now, now)).toBe(false)
    expect(itemIsSnoozed(null, now)).toBe(false)
  })
})

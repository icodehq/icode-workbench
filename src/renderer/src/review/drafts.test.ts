import { describe, expect, it, vi } from 'vitest'
import { afterAgentSend, EMPTY_DRAFT, WorkbenchDraftStore } from './drafts'

const note = {
  id: 'a:new:1:0',
  path: 'src/a.ts',
  side: 'new' as const,
  line: 1,
  text: 'Keep this branch'
}

describe('WorkbenchDraftStore', () => {
  it('keeps notes and commit text per session', () => {
    const store = new WorkbenchDraftStore()
    store.update('ses_a', {
      comments: [note],
      commitMessage: 'fix: preserve drafts'
    })

    expect(store.get('ses_a')).toEqual({
      comments: [note],
      commitMessage: 'fix: preserve drafts'
    })
    expect(store.get('ses_b')).toBe(EMPTY_DRAFT)
  })

  it('notifies subscribers and keeps the previous draft until replaced', () => {
    const store = new WorkbenchDraftStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.update('ses_a', { commitMessage: 'one' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get('ses_a').commitMessage).toBe('one')

    store.update('ses_a', (current) => ({ ...current, commitMessage: 'two' }))
    expect(store.get('ses_a').commitMessage).toBe('two')
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    store.update('ses_a', { commitMessage: 'three' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not wake the panel for a no-op update', () => {
    const store = new WorkbenchDraftStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.update('ses_a', { commitMessage: '' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('can clear only the comments that were actually sent', () => {
    const store = new WorkbenchDraftStore()
    const second = { ...note, id: 'a:new:2:1', line: 2, text: 'Newer note' }
    store.update('ses_a', { comments: [note, second] })

    store.update('ses_a', (current) => ({
      ...current,
      comments: current.comments.filter((comment) => comment.id !== note.id)
    }))

    expect(store.get('ses_a').comments).toEqual([second])
  })

  it('retains only the sessions that still exist', () => {
    const store = new WorkbenchDraftStore()
    store.update('ses_a', { commitMessage: 'a' })
    store.update('ses_b', { commitMessage: 'b' })

    store.retain(new Set(['ses_b']))

    expect(store.get('ses_a')).toBe(EMPTY_DRAFT)
    expect(store.get('ses_b').commitMessage).toBe('b')
  })
})

describe('afterAgentSend', () => {
  it('keeps every draft when the send failed', () => {
    const current = {
      comments: [note],
      commitMessage: 'draft commit'
    }
    expect(
      afterAgentSend(
        current,
        { commentIds: new Set([note.id]) },
        { ok: false, message: 'terminal closed' }
      )
    ).toBe(current)
  })

  it('clears only sent notes on success', () => {
    const newer = { ...note, id: 'a:new:2:1', line: 2, text: 'Newer note' }
    const current = {
      comments: [note, newer],
      commitMessage: 'draft commit'
    }
    const next = afterAgentSend(
      current,
      { commentIds: new Set([note.id]) },
      { ok: true }
    )
    expect(next.comments).toEqual([newer])
    expect(next.commitMessage).toBe('draft commit')
  })
})

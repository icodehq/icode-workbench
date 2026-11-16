import { describe, expect, it } from 'vitest'
import {
  beginResizeActivity,
  isResizeActive,
  subscribeResizeActivity
} from './resize-activity'

describe('resize activity', () => {
  it('notifies only on the transitions in and out of a drag', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeResizeActivity((active) => seen.push(active))

    const end = beginResizeActivity('sidebar')
    expect(isResizeActive()).toBe(true)
    expect(seen).toEqual([true])

    end()
    end()
    expect(isResizeActive()).toBe(false)
    expect(seen).toEqual([true, false])

    unsubscribe()
  })

  it('ref-counts overlapping drags', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeResizeActivity((active) => seen.push(active))

    const endSidebar = beginResizeActivity('sidebar')
    const endSplit = beginResizeActivity('split')
    expect(seen).toEqual([true])

    endSidebar()
    expect(isResizeActive()).toBe(true)
    expect(seen).toEqual([true])

    endSplit()
    expect(isResizeActive()).toBe(false)
    expect(seen).toEqual([true, false])

    unsubscribe()
  })

  it('stops notifying after unsubscribe', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeResizeActivity((active) => seen.push(active))
    unsubscribe()

    const end = beginResizeActivity('inspector')
    end()
    expect(seen).toEqual([])
  })

  it('isolates a throwing subscriber', () => {
    const seen: boolean[] = []
    const unsubscribeBad = subscribeResizeActivity(() => {
      throw new Error('subscriber failed')
    })
    const unsubscribeGood = subscribeResizeActivity((active) => seen.push(active))

    const end = beginResizeActivity('files-list')
    end()
    expect(seen).toEqual([true, false])

    unsubscribeBad()
    unsubscribeGood()
  })
})

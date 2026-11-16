import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth
} from './sidebar-layout'

function storage(initial: string | null = null) {
  let value = initial
  return {
    getItem: (key: string) => (key === SIDEBAR_WIDTH_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === SIDEBAR_WIDTH_KEY) value = next
    }
  }
}

describe('sidebar layout', () => {
  it('defaults to 300 and clamps into the drag bounds', () => {
    expect(loadSidebarWidth(storage())).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(loadSidebarWidth(storage('100'))).toBe(SIDEBAR_WIDTH_MIN)
    expect(loadSidebarWidth(storage('900'))).toBe(SIDEBAR_WIDTH_MAX)
    expect(loadSidebarWidth(storage('nope'))).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  it('round-trips the preferred width', () => {
    const store = storage()
    expect(saveSidebarWidth(360, store)).toBe(true)
    expect(loadSidebarWidth(store)).toBe(360)
    expect(saveSidebarWidth(999, store)).toBe(true)
    expect(loadSidebarWidth(store)).toBe(SIDEBAR_WIDTH_MAX)
  })

  it('reports a failed save without throwing', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(saveSidebarWidth(300, failing)).toBe(false)
  })

  it('rounds and clamps direct values', () => {
    expect(clampSidebarWidth(319.6)).toBe(320)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
})

import { describe, expect, it } from 'vitest'
import {
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  clampSplitRatio,
  paneSide,
  reconcileSplit,
  splitOn,
  swapPanes,
  toggleSplit,
  type SplitLayout
} from './session-split'

const AB: SplitLayout = { left: 'a', right: 'b' }
const IDS = ['a', 'b', 'c'] as const

describe('paneSide', () => {
  it('reports the side a session occupies', () => {
    expect(paneSide(AB, 'a')).toBe('left')
    expect(paneSide(AB, 'b')).toBe('right')
  })

  it('reports null for sessions outside the split or without a layout', () => {
    expect(paneSide(AB, 'c')).toBeNull()
    expect(paneSide(null, 'a')).toBeNull()
    expect(paneSide(AB, null)).toBeNull()
  })
})

describe('toggleSplit', () => {
  it('opens the first other visible session on the right', () => {
    expect(toggleSplit(null, 'a', IDS)).toEqual({ left: 'a', right: 'b' })
    expect(toggleSplit(null, 'b', IDS)).toEqual({ left: 'b', right: 'a' })
  })

  it('closes an open split', () => {
    expect(toggleSplit(AB, 'a', IDS)).toBeNull()
  })

  it('does nothing without another visible session', () => {
    expect(toggleSplit(null, 'a', ['a'])).toBeNull()
    expect(toggleSplit(null, 'missing', IDS)).toBeNull()
    expect(toggleSplit(null, null, IDS)).toBeNull()
  })
})

describe('splitOn', () => {
  it('places the tab in the requested slot around the active session', () => {
    expect(splitOn(null, 'left', 'b', 'a', IDS)).toEqual({
      layout: { left: 'b', right: 'a' },
      select: null
    })
    expect(splitOn(null, 'right', 'b', 'a', IDS)).toEqual({
      layout: { left: 'a', right: 'b' },
      select: null
    })
  })

  it('refuses to split a session with itself', () => {
    expect(splitOn(null, 'right', 'a', 'a', IDS)).toEqual({ layout: null, select: null })
    expect(splitOn(null, 'left', 'a', 'a', IDS)).toEqual({ layout: null, select: null })
  })

  it('ignores sessions that are not visible', () => {
    expect(splitOn(null, 'left', 'missing', 'a', IDS)).toEqual({ layout: null, select: null })
    expect(splitOn(AB, 'left', 'missing', 'a', IDS)).toEqual({ layout: AB, select: null })
  })

  it('swaps when the tab already belongs to the other pane', () => {
    expect(splitOn(AB, 'left', 'b', 'a', IDS)).toEqual({
      layout: { left: 'b', right: 'a' },
      select: null
    })
    expect(splitOn(AB, 'right', 'a', 'a', IDS)).toEqual({
      layout: { left: 'b', right: 'a' },
      select: null
    })
  })

  it('leaves the pair untouched when the tab is already in that pane', () => {
    expect(splitOn(AB, 'left', 'a', 'a', IDS)).toEqual({ layout: AB, select: null })
    expect(splitOn(AB, 'right', 'b', 'a', IDS)).toEqual({ layout: AB, select: null })
  })

  it('selects the replacement when it takes the active session’s pane', () => {
    expect(splitOn(AB, 'left', 'c', 'a', IDS)).toEqual({
      layout: { left: 'c', right: 'b' },
      select: 'c'
    })
    expect(splitOn(AB, 'right', 'c', 'b', IDS)).toEqual({
      layout: { left: 'a', right: 'c' },
      select: 'c'
    })
  })

  it('keeps the active session when the other pane is replaced', () => {
    expect(splitOn(AB, 'right', 'c', 'a', IDS)).toEqual({
      layout: { left: 'a', right: 'c' },
      select: null
    })
    expect(splitOn(AB, 'left', 'c', 'b', IDS)).toEqual({
      layout: { left: 'c', right: 'b' },
      select: null
    })
  })
})

describe('swapPanes', () => {
  it('exchanges the two sides', () => {
    expect(swapPanes(AB)).toEqual({ left: 'b', right: 'a' })
  })

  it('keeps a single pane unchanged', () => {
    expect(swapPanes(null)).toBeNull()
  })
})

describe('reconcileSplit', () => {
  it('keeps the pair when the selected tab is already in a pane', () => {
    expect(reconcileSplit(AB, 'a', 'b', IDS)).toBe(AB)
    expect(reconcileSplit(AB, 'b', 'a', IDS)).toBe(AB)
  })

  it('opens a newly selected tab in the previously active pane', () => {
    expect(reconcileSplit(AB, 'c', 'a', IDS)).toEqual({ left: 'c', right: 'b' })
    expect(reconcileSplit(AB, 'c', 'b', IDS)).toEqual({ left: 'a', right: 'c' })
  })

  it('falls back to the left pane when the previous session is unknown', () => {
    expect(reconcileSplit(AB, 'c', 'missing', IDS)).toEqual({ left: 'c', right: 'b' })
  })

  it('collapses when a pane session is no longer visible', () => {
    expect(reconcileSplit(AB, 'a', 'a', ['a', 'c'])).toBeNull()
    expect(reconcileSplit(AB, 'b', 'b', ['b', 'c'])).toBeNull()
  })

  it('collapses without an active session', () => {
    expect(reconcileSplit(AB, null, 'a', IDS)).toBeNull()
    expect(reconcileSplit(null, 'a', 'a', IDS)).toBeNull()
  })

  it('leaves the pair pending while the selected tab is not visible yet', () => {
    expect(reconcileSplit(AB, 'c', 'a', ['a', 'b'])).toBe(AB)
  })
})

describe('clampSplitRatio', () => {
  it('keeps the divider inside the usable range', () => {
    expect(clampSplitRatio(0.5)).toBe(0.5)
    expect(clampSplitRatio(0)).toBe(SPLIT_MIN_RATIO)
    expect(clampSplitRatio(1)).toBe(SPLIT_MAX_RATIO)
  })
})

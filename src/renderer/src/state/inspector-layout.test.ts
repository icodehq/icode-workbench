import { describe, expect, it } from 'vitest'
import {
  INSPECTOR_WIDTH_DEFAULT,
  INSPECTOR_WIDTH_KEY,
  INSPECTOR_WIDTH_MAX,
  INSPECTOR_WIDTH_MIN,
  clampInspectorWidth,
  loadInspectorWidth,
  saveInspectorWidth
} from './inspector-layout'

function storage(initial: string | null = null) {
  let value = initial
  return {
    getItem: (key: string) => (key === INSPECTOR_WIDTH_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === INSPECTOR_WIDTH_KEY) value = next
    }
  }
}

describe('inspector layout', () => {
  it('defaults to Termio’s width and clamps into the drag bounds', () => {
    expect(loadInspectorWidth(storage())).toBe(INSPECTOR_WIDTH_DEFAULT)
    expect(loadInspectorWidth(storage('200'))).toBe(INSPECTOR_WIDTH_MIN)
    expect(loadInspectorWidth(storage('5000'))).toBe(INSPECTOR_WIDTH_MAX)
    expect(loadInspectorWidth(storage('nope'))).toBe(INSPECTOR_WIDTH_DEFAULT)
  })

  it('leaves room for the terminal when the surface is small', () => {
    // 900px surface - 360px terminal = 540px at most.
    expect(clampInspectorWidth(640, 900)).toBe(540)
    // Never below the minimum, even in a surface narrower than the sum.
    expect(clampInspectorWidth(640, 500)).toBe(INSPECTOR_WIDTH_MIN)
    expect(clampInspectorWidth(640, 1600)).toBe(640)
  })

  it('round-trips the preferred width', () => {
    const store = storage()
    expect(saveInspectorWidth(812, store)).toBe(true)
    expect(loadInspectorWidth(store)).toBe(812)
  })

  it('reports a failed save without throwing', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(saveInspectorWidth(640, failing)).toBe(false)
  })
})

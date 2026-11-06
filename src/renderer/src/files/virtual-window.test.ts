import { describe, expect, it } from 'vitest'
import { computeVirtualWindow, scrollTopForRow } from './virtual-window'

describe('Files virtual window', () => {
  it('mounts only the visible slice plus overscan', () => {
    const window = computeVirtualWindow({
      rowCount: 10_000,
      scrollTop: 2800,
      viewportHeight: 560,
      rowHeight: 28,
      overscan: 8
    })
    expect(window.start).toBe(92)
    expect(window.end).toBe(128)
    expect(window.paddingTop).toBe(92 * 28)
    expect(window.paddingBottom).toBe((10_000 - 128) * 28)
    expect(window.end - window.start).toBeLessThanOrEqual(80)
  })

  it('clamps at the start, the end and an empty tree', () => {
    expect(
      computeVirtualWindow({ rowCount: 5, scrollTop: 0, viewportHeight: 100 })
    ).toMatchObject({ start: 0, end: 5, paddingTop: 0, paddingBottom: 0 })
    expect(
      computeVirtualWindow({ rowCount: 5, scrollTop: 9999, viewportHeight: 100 })
    ).toMatchObject({ start: 0, end: 5 })
    expect(
      computeVirtualWindow({ rowCount: 0, scrollTop: 0, viewportHeight: 100 })
    ).toEqual({ start: 0, end: 0, paddingTop: 0, paddingBottom: 0 })
  })

  it('scrolls the nearest edge into view for keyboard and reveal', () => {
    expect(
      scrollTopForRow({ index: 2, rowCount: 100, scrollTop: 280, viewportHeight: 280 })
    ).toBe(56)
    expect(
      scrollTopForRow({ index: 0, rowCount: 100, scrollTop: 280, viewportHeight: 280 })
    ).toBe(0)
    expect(
      scrollTopForRow({ index: 50, rowCount: 100, scrollTop: 0, viewportHeight: 280 })
    ).toBe(50 * 28 + 28 - 280)
  })
})

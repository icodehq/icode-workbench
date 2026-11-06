import { describe, expect, it } from 'vitest'
import { menuPosition } from './context-menu-position'

const viewport = { viewportWidth: 1000, viewportHeight: 800 }

describe('menuPosition', () => {
  it('keeps a cursor position that fits', () => {
    expect(
      menuPosition({ x: 100, y: 120, width: 192, height: 100, ...viewport })
    ).toEqual({ left: 100, top: 120, placement: 'below' })
  })

  it('clamps to the left and top margins', () => {
    expect(
      menuPosition({ x: -20, y: -20, width: 192, height: 100, ...viewport })
    ).toEqual({ left: 8, top: 8, placement: 'below' })
  })

  it('clamps the right edge for the compact width', () => {
    expect(
      menuPosition({ x: 950, y: 100, width: 192, height: 100, ...viewport })
    ).toEqual({ left: 800, top: 100, placement: 'below' })
  })

  it('clamps the right edge for the shared width', () => {
    expect(
      menuPosition({ x: 950, y: 100, width: 248, height: 100, ...viewport })
    ).toEqual({ left: 744, top: 100, placement: 'below' })
  })

  it('aligns an end-anchored menu to the trigger right edge', () => {
    expect(
      menuPosition({
        x: 0,
        y: 0,
        width: 192,
        height: 100,
        anchor: { top: 180, bottom: 200, left: 100, right: 300 },
        align: 'end',
        ...viewport
      })
    ).toEqual({ left: 108, top: 204, placement: 'below' })
  })

  it('aligns a start-anchored menu to the trigger left edge', () => {
    expect(
      menuPosition({
        x: 0,
        y: 0,
        width: 192,
        height: 100,
        anchor: { top: 180, bottom: 200, left: 100, right: 300 },
        align: 'start',
        ...viewport
      })
    ).toEqual({ left: 100, top: 204, placement: 'below' })
  })

  it('flips above when the menu would overflow the bottom', () => {
    expect(
      menuPosition({
        x: 0,
        y: 0,
        width: 192,
        height: 200,
        anchor: { top: 620, bottom: 640, left: 100, right: 300 },
        ...viewport
      })
    ).toEqual({ left: 100, top: 416, placement: 'above' })
  })

  it('clamps to the top when neither side fits', () => {
    expect(
      menuPosition({
        x: 0,
        y: 0,
        width: 192,
        height: 600,
        anchor: { top: 10, bottom: 60, left: 100, right: 300 },
        viewportWidth: 1000,
        viewportHeight: 600
      })
    ).toEqual({ left: 100, top: 8, placement: 'below' })
  })
})

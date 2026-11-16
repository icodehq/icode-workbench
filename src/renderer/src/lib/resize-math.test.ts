import { describe, expect, it } from 'vitest'
import { ratioFromRect, valueFromPointer } from './resize-math'

describe('valueFromPointer', () => {
  it('adds the pointer delta to the starting value', () => {
    expect(
      valueFromPointer({ startValue: 300, startPointer: 100, pointer: 160 })
    ).toBe(360)
    expect(
      valueFromPointer({ startValue: 300, startPointer: 100, pointer: 40 })
    ).toBe(240)
  })

  it('inverts the delta for a leading seam', () => {
    expect(
      valueFromPointer({
        startValue: 640,
        startPointer: 100,
        pointer: 40,
        direction: -1
      })
    ).toBe(700)
  })

  it('scales pointer pixels into value units', () => {
    expect(
      valueFromPointer({
        startValue: 0.5,
        startPointer: 200,
        pointer: 300,
        scale: 1 / 1000
      })
    ).toBeCloseTo(0.6)
  })

  it('falls back to the starting value for non-finite input', () => {
    expect(
      valueFromPointer({
        startValue: 320,
        startPointer: Number.NaN,
        pointer: 400
      })
    ).toBe(320)
    expect(
      valueFromPointer({
        startValue: 320,
        startPointer: 100,
        pointer: Number.POSITIVE_INFINITY
      })
    ).toBe(320)
    expect(
      valueFromPointer({
        startValue: 320,
        startPointer: 100,
        pointer: 200,
        scale: Number.NaN
      })
    ).toBe(320)
  })
})

describe('ratioFromRect', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 }

  it('maps a pointer to a horizontal ratio', () => {
    expect(ratioFromRect(rect, true, 300, 50)).toBeCloseTo(0.5)
    expect(ratioFromRect(rect, true, 100, 50)).toBe(0)
    expect(ratioFromRect(rect, true, 500, 50)).toBe(1)
  })

  it('maps a pointer to a vertical ratio', () => {
    expect(ratioFromRect(rect, false, 0, 150)).toBeCloseTo(0.5)
  })

  it('returns null for a collapsed container', () => {
    expect(ratioFromRect({ ...rect, width: 0 }, true, 100, 50)).toBeNull()
    expect(ratioFromRect({ ...rect, height: 0 }, false, 100, 50)).toBeNull()
  })

  it('returns null for a non-finite pointer', () => {
    expect(ratioFromRect(rect, true, Number.NaN, 50)).toBeNull()
  })
})

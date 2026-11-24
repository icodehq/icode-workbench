import { afterEach, describe, expect, it } from 'vitest'
import { holdOverlay, isOverlayOpen, resetOverlayLayers } from './overlay-layer'

afterEach(() => resetOverlayLayers())

describe('overlay layers', () => {
  it('starts with no open overlay', () => {
    expect(isOverlayOpen()).toBe(false)
  })

  it('stays open until every holder releases', () => {
    const menu = holdOverlay()
    const popover = holdOverlay()
    expect(isOverlayOpen()).toBe(true)
    menu()
    expect(isOverlayOpen()).toBe(true)
    popover()
    expect(isOverlayOpen()).toBe(false)
  })

  it('ignores a repeated release', () => {
    const release = holdOverlay()
    release()
    release()
    expect(isOverlayOpen()).toBe(false)
  })

  it('resets leaked holds', () => {
    holdOverlay()
    resetOverlayLayers()
    expect(isOverlayOpen()).toBe(false)
  })
})

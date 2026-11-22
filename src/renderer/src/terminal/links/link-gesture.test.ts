import { describe, expect, it } from 'vitest'
import { isLinkModifierClick, shouldActivateLinkGesture } from './link-gesture'

const base = {
  moved: false,
  hadSelection: false,
  hasSelection: false,
  button: 0,
  mouseTracking: false,
  modifier: false
}

describe('link gesture policy', () => {
  it('activates a plain click when nothing moved or was selected', () => {
    expect(shouldActivateLinkGesture(base)).toBe(true)
  })

  it('rejects drags, selections, non-left clicks, and unmodified TUI clicks', () => {
    expect(shouldActivateLinkGesture({ ...base, moved: true })).toBe(false)
    expect(shouldActivateLinkGesture({ ...base, hadSelection: true })).toBe(false)
    expect(shouldActivateLinkGesture({ ...base, hasSelection: true })).toBe(false)
    expect(shouldActivateLinkGesture({ ...base, button: 1 })).toBe(false)
    expect(shouldActivateLinkGesture({ ...base, mouseTracking: true })).toBe(false)
    expect(
      shouldActivateLinkGesture({ ...base, mouseTracking: true, modifier: true })
    ).toBe(true)
  })

  it('uses Cmd on macOS and Ctrl elsewhere', () => {
    expect(isLinkModifierClick({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(isLinkModifierClick({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(isLinkModifierClick({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(isLinkModifierClick({ metaKey: true, ctrlKey: false }, false)).toBe(false)
  })
})

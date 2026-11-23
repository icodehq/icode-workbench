import { describe, expect, it } from 'vitest'
import { isLinkModifierClick, shouldActivateLinkGesture } from './link-gesture'

const base = {
  moved: false,
  hadSelection: false,
  hasSelection: false,
  button: 0,
  shiftKey: false,
  altKey: false
}

describe('link gesture policy', () => {
  it('activates a plain click when nothing moved or was selected', () => {
    expect(shouldActivateLinkGesture(base)).toBe(true)
  })

  it('rejects drags, selections, modified clicks, and non-left clicks', () => {
    expect(shouldActivateLinkGesture({ ...base, moved: true })).toBe(false)
    expect(shouldActivateLinkGesture({ ...base, hadSelection: true })).toBe(false)
    expect(shouldActivateLinkGesture({ ...base, hasSelection: true })).toBe(false)
    expect(shouldActivateLinkGesture({ ...base, button: 1 })).toBe(false)
    expect(shouldActivateLinkGesture({ ...base, shiftKey: true })).toBe(false)
    expect(shouldActivateLinkGesture({ ...base, altKey: true })).toBe(false)
  })

  it('uses Cmd on macOS and Ctrl elsewhere', () => {
    expect(isLinkModifierClick({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(isLinkModifierClick({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(isLinkModifierClick({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(isLinkModifierClick({ metaKey: true, ctrlKey: false }, false)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { resolveTerminalKeyAction, type TerminalKeyEvent } from './key-router'

function key(overrides: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent {
  return {
    type: 'keydown',
    key: 'c',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('terminal key policy', () => {
  it('macOS copies with Cmd and leaves Ctrl+C as SIGINT', () => {
    expect(resolveTerminalKeyAction(key({ metaKey: true }), { isMac: true, hasSelection: true })).toBe(
      'copy'
    )
    expect(resolveTerminalKeyAction(key({ ctrlKey: true }), { isMac: true, hasSelection: true })).toBe(
      null
    )
  })

  it('Windows/Linux copy with Ctrl+Shift+C or Ctrl+C when a selection exists', () => {
    expect(
      resolveTerminalKeyAction(key({ ctrlKey: true, shiftKey: true }), {
        isMac: false,
        hasSelection: false
      })
    ).toBe('copy')
    expect(
      resolveTerminalKeyAction(key({ ctrlKey: true }), { isMac: false, hasSelection: true })
    ).toBe('copy')
    expect(
      resolveTerminalKeyAction(key({ ctrlKey: true }), { isMac: false, hasSelection: false })
    ).toBe('interrupt')
  })

  it('recognizes paste and find chords without stealing shell variants', () => {
    expect(
      resolveTerminalKeyAction(key({ key: 'v', metaKey: true }), { isMac: true, hasSelection: false })
    ).toBe('paste')
    expect(
      resolveTerminalKeyAction(key({ key: 'v', ctrlKey: true, shiftKey: true }), {
        isMac: false,
        hasSelection: false
      })
    ).toBe('paste')
    expect(
      resolveTerminalKeyAction(key({ key: 'f', ctrlKey: true }), { isMac: false, hasSelection: false })
    ).toBe('find')
    expect(
      resolveTerminalKeyAction(key({ key: 'f', ctrlKey: true, shiftKey: true }), {
        isMac: false,
        hasSelection: false
      })
    ).toBe(null)
    expect(
      resolveTerminalKeyAction(key({ key: 'f', ctrlKey: true, altKey: true }), {
        isMac: false,
        hasSelection: false
      })
    ).toBe(null)
  })

  it('ignores keyup and non-clipboard keys', () => {
    expect(resolveTerminalKeyAction(key({ type: 'keyup', metaKey: true }), {
      isMac: true,
      hasSelection: true
    })).toBe(null)
    expect(resolveTerminalKeyAction(key({ key: 'a', metaKey: true }), {
      isMac: true,
      hasSelection: true
    })).toBe(null)
  })
})

import { describe, expect, it } from 'vitest'
import { isSendEnter, messageWithAttachments } from './composer-input'

function enter(overrides: {
  shiftKey?: boolean
  isComposing?: boolean
  keyCode?: number
} = {}): React.KeyboardEvent {
  return {
    key: 'Enter',
    shiftKey: overrides.shiftKey ?? false,
    nativeEvent: {
      isComposing: overrides.isComposing ?? false,
      keyCode: overrides.keyCode ?? 13
    }
  } as unknown as React.KeyboardEvent
}

describe('composer input', () => {
  it('sends on Enter and keeps Shift+Enter for a newline', () => {
    expect(isSendEnter(enter())).toBe(true)
    expect(isSendEnter(enter({ shiftKey: true }))).toBe(false)
    expect(isSendEnter({ ...enter(), key: 'a' } as React.KeyboardEvent)).toBe(false)
  })

  it('sends attached file paths after the owner text', () => {
    expect(
      messageWithAttachments('Look at these', [
        { id: '1', name: 'a.ts', path: '/repo/a.ts', preview: null }
      ])
    ).toBe('Look at these\n\nAttached files:\n- /repo/a.ts (a.ts)')
    expect(
      messageWithAttachments('', [{ id: '1', name: 'a.ts', path: '/repo/a.ts', preview: null }])
    ).toContain('Attached files:')
    expect(messageWithAttachments('Hello', [])).toBe('Hello')
  })

  it('never sends while an IME owns the key', () => {
    expect(isSendEnter(enter({ isComposing: true }))).toBe(false)
    expect(isSendEnter(enter({ keyCode: 229 }))).toBe(false)
  })
})

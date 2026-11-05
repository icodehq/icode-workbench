import { describe, expect, it } from 'vitest'
import {
  isFocusTerminalShortcut,
  modifierLabel,
  shortcutHint,
  shortcutLabel
} from './platform'

describe('platform shortcut labels', () => {
  it('uses Cmd on macOS and Ctrl elsewhere', () => {
    expect(modifierLabel('darwin')).toBe('Cmd')
    expect(modifierLabel('win32')).toBe('Ctrl')
    expect(modifierLabel('linux')).toBe('Ctrl')
  })

  it('formats menu and search hints', () => {
    expect(shortcutLabel('K', 'darwin')).toBe('Cmd+K')
    expect(shortcutLabel('K', 'win32')).toBe('Ctrl+K')
    expect(shortcutHint('K', 'darwin')).toBe('Cmd K')
    expect(shortcutHint('K', 'linux')).toBe('Ctrl K')
  })

  it('recognizes only the platform modifier as the focus shortcut', () => {
    const base = { key: 'j', metaKey: false, ctrlKey: false }
    expect(isFocusTerminalShortcut({ ...base, metaKey: true }, 'darwin')).toBe(true)
    expect(isFocusTerminalShortcut({ ...base, ctrlKey: true }, 'darwin')).toBe(false)
    expect(isFocusTerminalShortcut({ ...base, ctrlKey: true }, 'linux')).toBe(true)
    expect(isFocusTerminalShortcut({ ...base, metaKey: true }, 'linux')).toBe(false)
    expect(isFocusTerminalShortcut({ ...base, ctrlKey: true, shiftKey: true }, 'linux')).toBe(
      false
    )
    expect(isFocusTerminalShortcut({ ...base, ctrlKey: true, altKey: true }, 'linux')).toBe(false)
    expect(isFocusTerminalShortcut({ ...base, key: 'k', ctrlKey: true }, 'linux')).toBe(false)
  })
})

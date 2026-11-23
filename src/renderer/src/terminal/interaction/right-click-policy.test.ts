import { describe, expect, it } from 'vitest'
import {
  shouldWithholdRightButton,
  terminalRightClickIntent,
  type TerminalRightClickInput
} from './right-click-policy'

const BASE: TerminalRightClickInput = {
  button: 2,
  altKey: false,
  ctrlKey: false,
  mouseTracking: false,
  hasSelection: false,
  rightClickPaste: false
}

function intent(patch: Partial<TerminalRightClickInput>): string {
  return terminalRightClickIntent({ ...BASE, ...patch })
}

describe('terminalRightClickIntent', () => {
  it('treats non-right buttons as a context menu, never a copy', () => {
    expect(intent({ button: 0, hasSelection: true })).toBe('menu')
    expect(intent({ button: 1, hasSelection: true })).toBe('menu')
    expect(intent({ button: -1, hasSelection: true })).toBe('menu')
  })

  it('lets Ctrl open the menu even with a selection or in a TUI', () => {
    expect(intent({ ctrlKey: true, hasSelection: true })).toBe('menu')
    expect(intent({ ctrlKey: true, altKey: true, mouseTracking: true })).toBe('menu')
    expect(intent({ ctrlKey: true, rightClickPaste: true, hasSelection: true })).toBe('menu')
  })

  it('passes Alt through only while a program owns the mouse', () => {
    expect(intent({ altKey: true, mouseTracking: true })).toBe('passthrough')
    expect(intent({ altKey: true, mouseTracking: true, hasSelection: true })).toBe('passthrough')
    expect(intent({ altKey: true, mouseTracking: false, hasSelection: true })).toBe('copy')
    expect(intent({ altKey: true, mouseTracking: false })).toBe('menu')
  })

  it('copies a live selection before considering right-click paste', () => {
    expect(intent({ hasSelection: true })).toBe('copy')
    expect(intent({ hasSelection: true, rightClickPaste: true })).toBe('copy')
    expect(intent({ hasSelection: true, mouseTracking: true })).toBe('copy')
  })

  it('keeps right-click paste for the no-selection case', () => {
    expect(intent({ rightClickPaste: true })).toBe('paste')
    expect(intent({ rightClickPaste: true, mouseTracking: true })).toBe('paste')
  })

  it('opens the menu when there is nothing to copy or paste', () => {
    expect(intent({})).toBe('menu')
    expect(intent({ mouseTracking: true })).toBe('menu')
  })
})

describe('shouldWithholdRightButton', () => {
  it('withholds every intent that iCode handles itself', () => {
    expect(shouldWithholdRightButton({ mouseTracking: true, ctrlKey: false, altKey: false })).toBe(true)
    expect(shouldWithholdRightButton({ mouseTracking: true, ctrlKey: true, altKey: false })).toBe(true)
    expect(shouldWithholdRightButton({ mouseTracking: true, ctrlKey: true, altKey: true })).toBe(true)
  })

  it('passes Alt through and never withholds without mouse tracking', () => {
    expect(shouldWithholdRightButton({ mouseTracking: true, ctrlKey: false, altKey: true })).toBe(false)
    expect(shouldWithholdRightButton({ mouseTracking: false, ctrlKey: false, altKey: false })).toBe(false)
  })
})

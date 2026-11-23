import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_SETTINGS_STORAGE_KEY,
  loadTerminalSettings,
  saveTerminalSettings,
  updateTerminalSettings
} from './terminal-settings'

function storage(initial: string | null = null) {
  let value = initial
  return {
    getItem: (key: string) => (key === TERMINAL_SETTINGS_STORAGE_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === TERMINAL_SETTINGS_STORAGE_KEY) value = next
    }
  }
}

describe('terminal settings', () => {
  it('uses behavior-preserving defaults', () => {
    expect(DEFAULT_TERMINAL_SETTINGS).toMatchObject({
      fontSize: 12,
      lineHeight: 1.2,
      cursorStyle: 'block',
      cursorBlink: true,
      scrollback: 5000,
      copyOnSelect: false,
      rightClickPaste: false,
      pasteImage: true,
      pasteMaxBytes: 1024 * 1024,
      osc52: true,
      osc52MaxBytes: 128 * 1024,
      selectionTrim: true,
      quickCommands: []
    })
  })

  it('round-trips patches and quick commands', () => {
    const store = storage()
    const next = updateTerminalSettings(
      DEFAULT_TERMINAL_SETTINGS,
      {
        fontSize: 16,
        copyOnSelect: true,
        rightClickPaste: true,
        scrollback: 2000,
        quickCommands: [
          {
            id: 'cmd-1',
            label: 'Test',
            command: 'pnpm test',
            appendEnter: true,
            repoId: 'repo_1'
          }
        ]
      },
      store
    )
    expect(loadTerminalSettings(store)).toEqual(next)
    expect(next.fontSize).toBe(16)
    expect(next.copyOnSelect).toBe(true)
    expect(next.quickCommands[0]?.command).toBe('pnpm test')
  })

  it('falls back on malformed or out-of-range storage', () => {
    expect(loadTerminalSettings(storage('{'))).toEqual(DEFAULT_TERMINAL_SETTINGS)
    expect(loadTerminalSettings(storage('[]'))).toEqual(DEFAULT_TERMINAL_SETTINGS)
    expect(
      loadTerminalSettings(
        storage(JSON.stringify({ fontSize: 2, scrollback: 99_999, cursorStyle: 'nope' }))
      )
    ).toEqual(DEFAULT_TERMINAL_SETTINGS)
  })

  it('reports a failed save without throwing', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(saveTerminalSettings(DEFAULT_TERMINAL_SETTINGS, failing)).toBe(false)
  })
})

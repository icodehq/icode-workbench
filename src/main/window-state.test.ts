import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  captureWindowState,
  clampWindowState,
  DEFAULT_WINDOW_STATE,
  loadWindowState,
  parseWindowState,
  saveWindowState
} from './window-state'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'icode-window-state-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('window state', () => {
  it('opens maximized on a fresh profile', () => {
    expect(loadWindowState(directory)).toEqual(DEFAULT_WINDOW_STATE)
  })

  it('accepts a persisted size and rejects malformed values', () => {
    expect(parseWindowState({ width: 1440, height: 900, maximized: false })).toEqual({
      width: 1440,
      height: 900,
      maximized: false
    })
    expect(parseWindowState({ width: 0, height: 900, maximized: false })).toBeNull()
    expect(parseWindowState({ width: 1440, height: 900 })).toBeNull()
    expect(parseWindowState(null)).toBeNull()
  })

  it('clamps below the app minimum and to the current work area', () => {
    expect(
      clampWindowState({ width: 500, height: 300, maximized: false }, { width: 1463, height: 866 })
    ).toEqual({ width: 760, height: 480, maximized: false })
    expect(
      clampWindowState({ width: 2000, height: 1200, maximized: false }, { width: 1463, height: 866 })
    ).toEqual({ width: 1463, height: 866, maximized: false })
  })

  it('saves and reloads the user choice, and ignores a corrupt file', () => {
    saveWindowState(directory, { width: 1300, height: 820, maximized: false })
    expect(loadWindowState(directory)).toEqual({
      width: 1300,
      height: 820,
      maximized: false
    })
    expect(JSON.parse(readFileSync(join(directory, 'window-state.json'), 'utf8'))).toEqual({
      width: 1300,
      height: 820,
      maximized: false
    })

    writeFileSync(join(directory, 'window-state.json'), '{not json', 'utf8')
    expect(loadWindowState(directory)).toEqual(DEFAULT_WINDOW_STATE)
  })

  it('captures the normal bounds while maximized', () => {
    const window = {
      getNormalBounds: () => ({ x: 0, y: 0, width: 1240, height: 800 }),
      isMaximized: () => true
    } as unknown as BrowserWindow
    expect(captureWindowState(window)).toEqual({
      width: 1240,
      height: 800,
      maximized: true
    })
  })
})

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/**
 * The session workbench is terminal-first, so the window opens maximized on a
 * fresh profile. Once the user resizes or restores it, that choice wins on the
 * next launch.
 */
export type WindowState = {
  width: number
  height: number
  maximized: boolean
}

export const MIN_WINDOW_WIDTH = 760
export const MIN_WINDOW_HEIGHT = 480
export const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1180,
  height: 760,
  maximized: true
}

const WINDOW_STATE_FILE = 'window-state.json'

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** Parses a persisted record, rejecting anything we would not want to apply. */
export function parseWindowState(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const { width, height, maximized } = record
  if (!isFiniteNumber(width) || width < 1) return null
  if (!isFiniteNumber(height) || height < 1) return null
  if (typeof maximized !== 'boolean') return null
  return {
    width: Math.max(MIN_WINDOW_WIDTH, Math.round(width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.round(height)),
    maximized
  }
}

/** Fits a saved size to the current display; the OS handles the position. */
export function clampWindowState(
  state: WindowState,
  workArea: { width: number; height: number }
): WindowState {
  return {
    ...state,
    width: Math.max(MIN_WINDOW_WIDTH, Math.min(Math.round(state.width), Math.floor(workArea.width))),
    height: Math.max(
      MIN_WINDOW_HEIGHT,
      Math.min(Math.round(state.height), Math.floor(workArea.height))
    )
  }
}

export function loadWindowState(directory: string): WindowState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, WINDOW_STATE_FILE), 'utf8'))
    return parseWindowState(parsed) ?? DEFAULT_WINDOW_STATE
  } catch {
    return DEFAULT_WINDOW_STATE
  }
}

/**
 * Window geometry is a convenience, never a startup dependency. A read-only
 * profile must still open the app.
 */
export function saveWindowState(directory: string, state: WindowState): void {
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, WINDOW_STATE_FILE),
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8'
    )
  } catch {
    // A persisted preference is not worth failing a launch over.
  }
}

export function captureWindowState(window: BrowserWindow): WindowState {
  const bounds = window.getNormalBounds()
  return {
    width: bounds.width,
    height: bounds.height,
    maximized: window.isMaximized()
  }
}

/** Persists the normal bounds, so restoring after a maximized launch is exact. */
export function trackWindowState(window: BrowserWindow, directory: string): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const persist = (): void => {
    timer = null
    saveWindowState(directory, captureWindowState(window))
  }
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(persist, 250)
  }
  window.on('resize', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)
  window.on('close', () => {
    if (timer !== null) clearTimeout(timer)
    persist()
  })
  window.on('closed', () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  })
}

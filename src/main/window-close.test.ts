import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { installWindowCloseGuard, respondToWindowClose } from './window-close'

vi.mock('electron', () => ({
  app: { on: vi.fn(), removeListener: vi.fn(), quit: vi.fn() },
  BrowserWindow: class {},
  dialog: { showMessageBox: vi.fn() }
}))

class FakeWindow extends EventEmitter {
  webContents = { isDestroyed: () => false, send: vi.fn() }
  close = vi.fn()
  isDestroyed = (): boolean => false
}

function requestClose(window: FakeWindow): { prevented: boolean } {
  let prevented = false
  window.emit('close', {
    preventDefault: () => {
      prevented = true
    }
  })
  return { prevented }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('window close guard', () => {
  it('asks the renderer and does not close until it agrees', () => {
    vi.useFakeTimers()
    const window = new FakeWindow()
    installWindowCloseGuard(window as unknown as BrowserWindow)

    expect(requestClose(window).prevented).toBe(true)
    expect(window.webContents.send).toHaveBeenCalledWith('icode:window:before-close')
    expect(window.close).not.toHaveBeenCalled()

    // A second close request while pending does not send a second prompt.
    requestClose(window)
    expect(window.webContents.send).toHaveBeenCalledTimes(1)

    expect(respondToWindowClose(window as unknown as BrowserWindow, 'ack')).toBe(true)
    expect(respondToWindowClose(window as unknown as BrowserWindow, 'close')).toBe(true)
    expect(window.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the window open on cancel and can ask again', () => {
    vi.useFakeTimers()
    const window = new FakeWindow()
    installWindowCloseGuard(window as unknown as BrowserWindow)

    requestClose(window)
    expect(respondToWindowClose(window as unknown as BrowserWindow, 'cancel')).toBe(true)
    expect(window.close).not.toHaveBeenCalled()

    requestClose(window)
    expect(window.webContents.send).toHaveBeenCalledTimes(2)
  })

  it('a close response without a pending request is ignored', () => {
    const window = new FakeWindow()
    installWindowCloseGuard(window as unknown as BrowserWindow)
    expect(respondToWindowClose(window as unknown as BrowserWindow, 'close')).toBe(false)
    expect(window.close).not.toHaveBeenCalled()
  })

  it('can be disabled for the hidden holder window', () => {
    const window = new FakeWindow()
    installWindowCloseGuard(window as unknown as BrowserWindow, { enabled: false })
    expect(requestClose(window).prevented).toBe(false)
    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('re-issues an app quit after the close prompt confirms it', () => {
    vi.useFakeTimers()
    const window = new FakeWindow()
    installWindowCloseGuard(window as unknown as BrowserWindow)
    const beforeQuit = vi.mocked(app.on).mock.calls.at(-1)?.[1] as (() => void) | undefined
    expect(beforeQuit).toBeDefined()
    beforeQuit?.()

    requestClose(window)
    respondToWindowClose(window as unknown as BrowserWindow, 'close')
    expect(app.quit).not.toHaveBeenCalled()
    window.emit('closed')
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('cancelling a quit prompt does not quit later', () => {
    vi.useFakeTimers()
    const window = new FakeWindow()
    installWindowCloseGuard(window as unknown as BrowserWindow)
    const beforeQuit = vi.mocked(app.on).mock.calls.at(-1)?.[1] as (() => void) | undefined
    beforeQuit?.()

    requestClose(window)
    respondToWindowClose(window as unknown as BrowserWindow, 'cancel')
    requestClose(window)
    respondToWindowClose(window as unknown as BrowserWindow, 'close')
    window.emit('closed')
    expect(app.quit).not.toHaveBeenCalled()
  })
})

import { app, BrowserWindow, dialog } from 'electron'
import { IPC_CHANNELS } from '../shared/schemas/ipc'
import { t } from '../shared/i18n'
import type { Locale } from '../shared/i18n'
import { getMainLocale } from './i18n/main-i18n'

/**
 * Asks the renderer before closing so unsaved file tabs can be saved.
 *
 * Electron's `beforeunload` cannot show a useful prompt, and a blocked close
 * would make the window unclosable if the renderer is broken. This guard gives
 * the renderer a bounded chance to answer, then falls back to a native dialog.
 *
 * On macOS, Cmd+Q emits `before-quit` before the window close. The quit is
 * remembered here and re-issued after the user resolves the prompt; runtime
 * shutdown itself moved to `will-quit` so a cancelled quit cannot tear the app
 * down under the window.
 */

export type PrepareCloseResult = 'ready' | 'cancelled' | 'timeout' | 'unavailable'

type PreparingClose = {
  promise: Promise<PrepareCloseResult>
  resolve: (result: PrepareCloseResult) => void
  timer: NodeJS.Timeout
}

type CloseGuard = {
  allowClose: boolean
  pending: boolean
  quitRequested: boolean
  timer: NodeJS.Timeout | null
  preparing: PreparingClose | null
  getLocale: () => Locale
  onBeforeQuit: () => void
}

const guards = new WeakMap<BrowserWindow, CloseGuard>()

function closeWindow(window: BrowserWindow, guard: CloseGuard): void {
  if (guard.quitRequested) {
    // The original quit was cancelled by this close guard; finish it once the
    // window is gone, so `will-quit` and runtime shutdown still run.
    window.once('closed', () => app.quit())
  }
  guard.allowClose = true
  window.close()
}

export function installWindowCloseGuard(
  window: BrowserWindow,
  options: { enabled?: boolean; timeoutMs?: number; locale?: Locale } = {}
): void {
  if (options.enabled === false) return
  const guard: CloseGuard = {
    allowClose: false,
    pending: false,
    quitRequested: false,
    timer: null,
    preparing: null,
    // An explicit locale pins the dialog (tests); the app follows the live
    // setting so a language change also reaches the native fallback prompt.
    getLocale: () => options.locale ?? getMainLocale(),
    onBeforeQuit: () => {
      guard.quitRequested = true
    }
  }
  guards.set(window, guard)
  app.on('before-quit', guard.onBeforeQuit)

  window.on('close', (event) => {
    if (guard.allowClose) return
    if (window.webContents.isDestroyed()) {
      // Nothing can answer; let the window close rather than trap it.
      guard.allowClose = true
      return
    }
    event.preventDefault()
    if (guard.pending) return
    guard.pending = true
    window.webContents.send(IPC_CHANNELS.windowBeforeClose)
    guard.timer = setTimeout(() => {
      void fallbackPrompt(window, guard)
    }, options.timeoutMs ?? 5000)
  })

  window.on('closed', () => {
    if (guard.timer !== null) clearTimeout(guard.timer)
    if (guard.preparing !== null) {
      clearTimeout(guard.preparing.timer)
      guard.preparing.resolve('unavailable')
      guard.preparing = null
    }
    app.removeListener('before-quit', guard.onBeforeQuit)
    guards.delete(window)
  })
}

/**
 * Ask a window to save before an update teardown, without closing it.
 *
 * The renderer answers through the same `windowBeforeClose` protocol used by a
 * normal close, so Files gets its Save All/Discard/Cancel prompt. The window
 * stays open; the caller destroys it only after every other teardown step
 * succeeds.
 */
export function prepareWindowForClose(
  window: BrowserWindow,
  timeoutMs: number = 10 * 60 * 1000
): Promise<PrepareCloseResult> {
  const guard = guards.get(window)
  if (guard === undefined || window.webContents.isDestroyed()) {
    return Promise.resolve('unavailable')
  }
  if (guard.preparing !== null) return guard.preparing.promise
  // A native close prompt or another close is already in flight. The update
  // restarts later rather than racing that prompt.
  if (guard.pending) return Promise.resolve('timeout')

  let resolvePromise: (result: PrepareCloseResult) => void = () => undefined
  const promise = new Promise<PrepareCloseResult>((resolve) => {
    resolvePromise = resolve
  })
  const timer = setTimeout(() => {
    if (guard.preparing?.promise !== promise) return
    guard.preparing = null
    guard.pending = false
    resolvePromise('timeout')
  }, timeoutMs)
  timer.unref?.()

  guard.preparing = { promise, resolve: resolvePromise, timer }
  guard.pending = true
  window.webContents.send(IPC_CHANNELS.windowBeforeClose)
  return promise
}

/**
 * Let every guarded window close without another prompt.
 *
 * Called only after `prepareWindowForClose` has resolved for each window and
 * the runtime has already been shut down.
 */
export function beginUpdateInstall(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const guard = guards.get(window)
    if (guard === undefined) continue
    if (guard.timer !== null) clearTimeout(guard.timer)
    guard.timer = null
    if (guard.preparing !== null) {
      clearTimeout(guard.preparing.timer)
      guard.preparing.resolve('ready')
      guard.preparing = null
    }
    guard.pending = false
    guard.allowClose = true
  }
}

/** Called by the trusted renderer after its save prompt resolves. */
export function respondToWindowClose(
  window: BrowserWindow,
  action: 'ack' | 'close' | 'cancel'
): boolean {
  const guard = guards.get(window)
  if (guard === undefined || !guard.pending) return false
  if (guard.preparing !== null) {
    if (action === 'ack') return true
    const preparing = guard.preparing
    clearTimeout(preparing.timer)
    guard.preparing = null
    guard.pending = false
    if (action === 'close') {
      preparing.resolve('ready')
    } else {
      // Cancelling the save prompt also cancels a pending app quit, matching
      // the normal close-guard behavior.
      guard.quitRequested = false
      preparing.resolve('cancelled')
    }
    return true
  }
  if (action === 'ack') {
    // The renderer is showing its own prompt. Give it a long safety window;
    // the short 5 s fallback is only for a renderer that never answers.
    if (guard.timer !== null) clearTimeout(guard.timer)
    guard.timer = setTimeout(() => {
      void fallbackPrompt(window, guard)
    }, 10 * 60 * 1000)
    return true
  }
  if (guard.timer !== null) clearTimeout(guard.timer)
  guard.timer = null
  guard.pending = false
  if (action === 'close') {
    closeWindow(window, guard)
  } else {
    guard.quitRequested = false
  }
  return true
}

async function fallbackPrompt(window: BrowserWindow, guard: CloseGuard): Promise<void> {
  if (window.isDestroyed() || !guard.pending) return
  const locale = guard.getLocale()
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: [t(locale, 'dialog.close.closeAnyway'), t(locale, 'dialog.close.cancel')],
    defaultId: 1,
    cancelId: 1,
    message: t(locale, 'dialog.close.title'),
    detail: t(locale, 'dialog.close.detail')
  })
  if (guard.allowClose || window.isDestroyed()) return
  if (result.response === 0) {
    guard.pending = false
    closeWindow(window, guard)
  } else {
    guard.pending = false
    guard.quitRequested = false
  }
}

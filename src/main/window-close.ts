import { app, BrowserWindow, dialog } from 'electron'
import { IPC_CHANNELS } from '../shared/schemas/ipc'

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

type CloseGuard = {
  allowClose: boolean
  pending: boolean
  quitRequested: boolean
  timer: NodeJS.Timeout | null
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
  options: { enabled?: boolean; timeoutMs?: number } = {}
): void {
  if (options.enabled === false) return
  const guard: CloseGuard = {
    allowClose: false,
    pending: false,
    quitRequested: false,
    timer: null,
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
    app.removeListener('before-quit', guard.onBeforeQuit)
    guards.delete(window)
  })
}

/** Called by the trusted renderer after its save prompt resolves. */
export function respondToWindowClose(
  window: BrowserWindow,
  action: 'ack' | 'close' | 'cancel'
): boolean {
  const guard = guards.get(window)
  if (guard === undefined || !guard.pending) return false
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
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Close anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Close iCode?',
    detail:
      'Files did not answer the unsaved-changes check. Closing now may discard unsaved editor text.'
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

/**
 * The subset of `BrowserWindow` needed to bring a window forward.
 *
 * Kept structural so tests can pass a fake and so the Electron import stays a
 * type-only dependency.
 */
export type PresentableWindow = {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

/**
 * Brings a window to the foreground from any state.
 *
 * `show()` alone does not un-minimize a window on Windows, so callers that
 * react to an OS notification click must restore first. Returns false when the
 * window no longer exists.
 */
export function presentWindow(window: PresentableWindow): boolean {
  if (window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
}

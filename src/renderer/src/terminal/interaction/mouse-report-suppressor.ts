import type { Terminal } from '@xterm/xterm'

/**
 * Short-lived ownership of xterm's `mouseEventsRequireAlt`.
 *
 * The xterm beta uses this option to withhold pointer reports from a
 * mouse-aware program while a terminal-side gesture is in progress. The link
 * click and the right-click menu both need it, so ownership is depth-counted:
 * the first `suppress()` saves the original value and writes `true`, and only
 * the last `release()` restores it. A second owner must never save the
 * already-true value, or a lost release would leave TUI mouse input broken.
 */

export type MouseReportSuppressorTarget = {
  read(): boolean | undefined
  write(value: boolean | undefined): void
}

export type MouseReportSuppressor = {
  suppress(): void
  release(): void
  /** Force the saved value back and drop every outstanding owner. */
  restore(): void
  isActive(): boolean
}

export function createMouseReportSuppressor(
  target: MouseReportSuppressorTarget
): MouseReportSuppressor {
  let depth = 0
  // `null` means nothing has been saved yet; `undefined` is a real saved value
  // because xterm treats an unset option as its documented default.
  let saved: boolean | undefined | null = null

  const restoreSaved = (): void => {
    if (saved === null) return
    const previous = saved
    saved = null
    depth = 0
    target.write(previous)
  }

  return {
    suppress: () => {
      if (depth === 0) {
        saved = target.read()
        target.write(true)
      }
      depth += 1
    },
    release: () => {
      if (depth === 0) return
      depth -= 1
      if (depth === 0) restoreSaved()
    },
    restore: () => {
      restoreSaved()
    },
    isActive: () => depth > 0
  }
}

export function createTerminalMouseReportSuppressor(term: Terminal): MouseReportSuppressor {
  return createMouseReportSuppressor({
    read: () => term.options.mouseEventsRequireAlt,
    write: (value) => {
      term.options.mouseEventsRequireAlt = value
    }
  })
}

export type RightButtonSuppressionOptions = {
  /** Return false to let the program receive the right button (for example Alt). */
  shouldSuppress?: (event: MouseEvent) => boolean
  /** Safety net for a mouseup lost outside the window; defaults to 10 seconds. */
  maxHoldMs?: number
}

export type TerminalRightButtonSuppression = {
  dispose(): void
}

const DEFAULT_MAX_HOLD_MS = 10_000

/**
 * Withhold the right button from a mouse-aware program before xterm reports it.
 *
 * The capture listener runs before xterm's bubble-phase mouse handler, so the
 * press never reaches the PTY. The DOM `contextmenu` event is untouched and
 * still opens the iCode menu. Release is deferred by a microtask so xterm's
 * synchronous mouseup reporting still observes the suppression.
 */
export function installTerminalRightButtonSuppression(
  term: Terminal,
  suppressor: MouseReportSuppressor,
  options: RightButtonSuppressionOptions = {}
): TerminalRightButtonSuppression {
  const element = term.element
  const doc = element?.ownerDocument
  const win = doc?.defaultView ?? null
  let suppressed = false
  let watchdog: ReturnType<typeof setTimeout> | null = null

  const clearWatchdog = (): void => {
    if (watchdog === null) return
    clearTimeout(watchdog)
    watchdog = null
  }

  const releaseDeferred = (): void => {
    clearWatchdog()
    if (!suppressed) return
    suppressed = false
    queueMicrotask(() => suppressor.release())
  }

  const releaseNow = (): void => {
    clearWatchdog()
    if (!suppressed) return
    suppressed = false
    suppressor.release()
  }

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 2 || suppressed) return
    if (term.modes.mouseTrackingMode === 'none') return
    if (options.shouldSuppress?.(event) === false) return
    suppressed = true
    suppressor.suppress()
    clearWatchdog()
    watchdog = setTimeout(() => {
      watchdog = null
      if (!suppressed) return
      suppressed = false
      suppressor.release()
    }, options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS)
  }
  const onMouseUp = (): void => releaseDeferred()
  const onBlur = (): void => releaseNow()

  element?.addEventListener('mousedown', onMouseDown, true)
  doc?.addEventListener('mouseup', onMouseUp)
  win?.addEventListener('blur', onBlur)

  return {
    dispose: () => {
      element?.removeEventListener('mousedown', onMouseDown, true)
      doc?.removeEventListener('mouseup', onMouseUp)
      win?.removeEventListener('blur', onBlur)
      releaseNow()
    }
  }
}

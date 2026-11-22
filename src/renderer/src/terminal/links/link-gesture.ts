import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * Distinguishes a link click from a text selection or a TUI mouse report.
 *
 * Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.),
 * `terminal-link-pointer-gesture.ts` and `terminal-link-activation.ts`.
 */

export const LINK_DRAG_THRESHOLD_PX = 4

export type LinkGestureDecisionInput = {
  moved: boolean
  hadSelection: boolean
  hasSelection: boolean
  button: number
  mouseTracking: boolean
  modifier: boolean
}

export function shouldActivateLinkGesture(input: LinkGestureDecisionInput): boolean {
  if (input.button !== 0 || input.moved) return false
  if (input.hadSelection || input.hasSelection) return false
  // A mouse-aware TUI owns plain clicks; the modifier is the explicit override.
  if (input.mouseTracking && !input.modifier) return false
  return true
}

export function isLinkModifierClick(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>,
  isMac: boolean
): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

type PendingGesture = {
  x: number
  y: number
  hadSelection: boolean
  moved: boolean
}

export type TerminalLinkGesture = IDisposable & {
  canActivate: (event: MouseEvent) => boolean
}

type TerminalLinkGestureOptions = {
  /**
   * Called on left mousedown. Returning true while a mouse-aware program is
   * running temporarily requires Alt for PTY mouse reports, so the link click
   * does not also reach the child TUI. The previous value is restored after
   * mouseup or blur.
   */
  shouldSuppressMouseReport?: (event: MouseEvent) => boolean
}

export function installTerminalLinkPointerGesture(
  term: Terminal,
  isMac: boolean,
  options: TerminalLinkGestureOptions = {}
): TerminalLinkGesture {
  const element = term.element
  const doc = element?.ownerDocument
  const win = doc?.defaultView ?? null
  let pending: PendingGesture | null = null
  let savedMouseEventsRequireAlt: boolean | undefined | null = null

  const clear = (): void => {
    pending = null
  }
  const restoreMouseReports = (): void => {
    if (savedMouseEventsRequireAlt === null) return
    term.options.mouseEventsRequireAlt = savedMouseEventsRequireAlt
    savedMouseEventsRequireAlt = null
  }

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) {
      clear()
      return
    }
    pending = {
      x: event.clientX,
      y: event.clientY,
      hadSelection: term.hasSelection(),
      moved: false
    }
    // A modified click on a link in a mouse-aware TUI must not also become a
    // PTY mouse report (for example a Ctrl-click in tmux or vim).
    if (
      term.modes.mouseTrackingMode !== 'none' &&
      !event.altKey &&
      options.shouldSuppressMouseReport?.(event) === true
    ) {
      savedMouseEventsRequireAlt = term.options.mouseEventsRequireAlt
      term.options.mouseEventsRequireAlt = true
    }
  }
  const onMouseMove = (event: MouseEvent): void => {
    if (pending === null) return
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > LINK_DRAG_THRESHOLD_PX) {
      pending.moved = true
    }
  }
  const onMouseUp = (): void => {
    queueMicrotask(() => {
      clear()
      restoreMouseReports()
    })
  }
  const onBlur = (): void => {
    clear()
    restoreMouseReports()
  }

  element?.addEventListener('mousedown', onMouseDown, true)
  doc?.addEventListener('mousemove', onMouseMove)
  doc?.addEventListener('mouseup', onMouseUp)
  win?.addEventListener('blur', onBlur)

  return {
    canActivate: (event) => {
      if (pending === null) return false
      return shouldActivateLinkGesture({
        moved: pending.moved,
        hadSelection: pending.hadSelection,
        hasSelection: term.hasSelection(),
        button: event.button,
        mouseTracking: term.modes.mouseTrackingMode !== 'none',
        modifier: isLinkModifierClick(event, isMac)
      })
    },
    dispose: () => {
      clear()
      restoreMouseReports()
      element?.removeEventListener('mousedown', onMouseDown, true)
      doc?.removeEventListener('mousemove', onMouseMove)
      doc?.removeEventListener('mouseup', onMouseUp)
      win?.removeEventListener('blur', onBlur)
    }
  }
}

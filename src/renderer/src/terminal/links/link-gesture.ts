import type { IDisposable, Terminal } from '@xterm/xterm'
import {
  createTerminalMouseReportSuppressor,
  type MouseReportSuppressor
} from '../interaction/mouse-report-suppressor'

/**
 * Distinguishes a link click from a text selection or a modified click.
 *
 * A click in a mouse-aware TUI is still a link click when it lands on a link;
 * the PTY mouse-report suppression below keeps the TUI from acting on it.
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
  shiftKey: boolean
  altKey: boolean
}

export function shouldActivateLinkGesture(input: LinkGestureDecisionInput): boolean {
  if (input.button !== 0 || input.moved) return false
  if (input.shiftKey || input.altKey) return false
  if (input.hadSelection || input.hasSelection) return false
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
  /**
   * Shared with the right-click suppression so both gestures use one
   * depth-counted save slot. A private suppressor is created when omitted.
   */
  mouseReportSuppressor?: MouseReportSuppressor
}

export function installTerminalLinkPointerGesture(
  term: Terminal,
  options: TerminalLinkGestureOptions = {}
): TerminalLinkGesture {
  const element = term.element
  const doc = element?.ownerDocument
  const win = doc?.defaultView ?? null
  const suppressor =
    options.mouseReportSuppressor ?? createTerminalMouseReportSuppressor(term)
  let pending: PendingGesture | null = null
  let suppressedByGesture = false

  const clear = (): void => {
    pending = null
  }
  const releaseSuppression = (): void => {
    if (!suppressedByGesture) return
    suppressedByGesture = false
    suppressor.release()
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
      !suppressedByGesture &&
      term.modes.mouseTrackingMode !== 'none' &&
      !event.altKey &&
      !pending.hadSelection &&
      options.shouldSuppressMouseReport?.(event) === true
    ) {
      suppressedByGesture = true
      suppressor.suppress()
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
      releaseSuppression()
    })
  }
  const onBlur = (): void => {
    clear()
    releaseSuppression()
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
        shiftKey: event.shiftKey,
        altKey: event.altKey
      })
    },
    dispose: () => {
      clear()
      releaseSuppression()
      element?.removeEventListener('mousedown', onMouseDown, true)
      doc?.removeEventListener('mousemove', onMouseMove)
      doc?.removeEventListener('mouseup', onMouseUp)
      win?.removeEventListener('blur', onBlur)
    }
  }
}

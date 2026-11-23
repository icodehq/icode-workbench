/**
 * Right-click intent for a terminal pane.
 *
 * The pane handles the contextmenu event; xterm's native handler has already
 * run by then. The intent is derived synchronously from the pointer event and
 * the terminal's live selection/mouse state, so it never depends on React
 * state that may lag a drag.
 */

export type TerminalRightClickIntent = 'copy' | 'paste' | 'menu' | 'passthrough'

export type TerminalRightClickInput = {
  /** DOM MouseEvent.button; 2 for a real right click. */
  button: number
  altKey: boolean
  ctrlKey: boolean
  mouseTracking: boolean
  hasSelection: boolean
  rightClickPaste: boolean
}

export function terminalRightClickIntent(
  input: TerminalRightClickInput
): TerminalRightClickIntent {
  // A keyboard contextmenu (Shift+F10) or a macOS Ctrl-click reports another
  // button; it must never turn into a copy.
  if (input.button !== 2) return 'menu'
  // Ctrl is the escape hatch for the menu and wins over Alt.
  if (input.ctrlKey) return 'menu'
  // Alt is the app's passthrough: no iCode menu, and the PTY keeps the click.
  if (input.altKey && input.mouseTracking) return 'passthrough'
  if (input.hasSelection) return 'copy'
  if (input.rightClickPaste) return 'paste'
  return 'menu'
}

export type RightButtonWithholdInput = {
  mouseTracking: boolean
  ctrlKey: boolean
  altKey: boolean
}

/**
 * True when iCode handles the right button itself (menu, copy or paste).
 * Mouse tracking must be active for there to be a report to withhold; Alt
 * without Ctrl is the passthrough exception.
 */
export function shouldWithholdRightButton(input: RightButtonWithholdInput): boolean {
  return input.mouseTracking && (input.ctrlKey || !input.altKey)
}

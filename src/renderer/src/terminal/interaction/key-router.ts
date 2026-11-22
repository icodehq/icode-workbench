import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * Clipboard and find chords the terminal claims before xterm encodes them.
 *
 * xterm does not copy a selection by itself, and a plain Ctrl+C must still reach
 * the shell as SIGINT. The platform split follows the native terminal
 * conventions: macOS copies with Cmd, while Windows/Linux copy with Ctrl+Shift+C
 * or Ctrl+C only when a selection exists.
 */

export type TerminalKeyEvent = {
  type: string
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type TerminalKeyAction = 'copy' | 'paste' | 'interrupt' | 'find' | null

export type TerminalKeyPolicy = {
  isMac: boolean
  hasSelection: boolean
}

function isCopyChord(event: TerminalKeyEvent, isMac: boolean): boolean {
  if (event.altKey) return false
  if (isMac) {
    return event.metaKey && !event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'c'
  }
  if (event.ctrlKey && !event.metaKey && event.shiftKey && event.key.toLowerCase() === 'c') {
    return true
  }
  return event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'c'
}

function isPasteChord(event: TerminalKeyEvent, isMac: boolean): boolean {
  if (event.altKey) return false
  if (isMac) {
    return event.metaKey && !event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'v'
  }
  if (!event.ctrlKey || event.metaKey) return false
  return event.key.toLowerCase() === 'v'
}

function isFindChord(event: TerminalKeyEvent, isMac: boolean): boolean {
  if (event.altKey || event.shiftKey) return false
  if (isMac) return event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'f'
  return event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'f'
}

export function resolveTerminalKeyAction(
  event: TerminalKeyEvent,
  policy: TerminalKeyPolicy
): TerminalKeyAction {
  if (event.type !== 'keydown') return null
  if (isFindChord(event, policy.isMac)) return 'find'
  if (isPasteChord(event, policy.isMac)) return 'paste'
  if (isCopyChord(event, policy.isMac)) {
    // Ctrl+C without a selection is SIGINT, not a blocked copy.
    if (!policy.isMac && !event.shiftKey && !policy.hasSelection) return 'interrupt'
    return 'copy'
  }
  return null
}

export type TerminalKeyRouterOptions = {
  isMac: boolean
  hasSelection: () => boolean
  copySelection: () => void
  openFind: () => void
}

export function installTerminalKeyRouter(
  term: Terminal,
  options: TerminalKeyRouterOptions
): IDisposable {
  term.attachCustomKeyEventHandler((event) => {
    const action = resolveTerminalKeyAction(event, {
      isMac: options.isMac,
      hasSelection: options.hasSelection()
    })
    if (action === null || action === 'interrupt') return true
    if (action === 'copy') {
      event.preventDefault()
      options.copySelection()
      return false
    }
    if (action === 'find') {
      event.preventDefault()
      options.openFind()
      return false
    }
    // Paste stays native: xterm's textarea listener applies bracketed paste.
    return false
  })
  return {
    dispose: () => term.attachCustomKeyEventHandler(() => true)
  }
}

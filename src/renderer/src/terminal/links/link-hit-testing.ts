/**
 * Maps terminal pointer events to buffer cells and tests URL link ranges.
 *
 * Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.),
 * `terminal-mouse-buffer-position.ts` and the HTTP link hit-testing helpers.
 */

import type { Terminal } from '@xterm/xterm'
import { extractTerminalHttpLinks } from './url-extraction'
import { buildWrappedLogicalLine, rangeForParsedLink } from './wrapped-line'
import type { TerminalLinkBufferRange } from './terminal-link-buffer'

export type TerminalBufferPosition = { x: number; y: number }

/** Returns a 1-based active-buffer cell for a pointer event, or null outside the grid. */
export function terminalBufferPositionForMouseEvent(
  term: Terminal,
  event: Pick<MouseEvent, 'clientX' | 'clientY'>
): TerminalBufferPosition | null {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen || term.cols <= 0 || term.rows <= 0) return null
  const rect = screen.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const relativeX = event.clientX - rect.left
  const relativeY = event.clientY - rect.top
  if (relativeX < 0 || relativeY < 0 || relativeX >= rect.width || relativeY >= rect.height) {
    return null
  }
  return {
    x: Math.floor((relativeX / rect.width) * term.cols) + 1,
    y: Math.floor((relativeY / rect.height) * term.rows) + term.buffer.active.viewportY + 1
  }
}

/** True when a 1-based buffer cell falls inside xterm's 1-based inclusive range. */
export function cellIsInBufferRange(
  position: TerminalBufferPosition,
  range: TerminalLinkBufferRange
): boolean {
  if (position.y < range.start.y || position.y > range.end.y) return false
  if (position.y === range.start.y && position.x < range.start.x) return false
  if (position.y === range.end.y && position.x > range.end.x) return false
  return true
}

/** Finds an HTTP(S) URL at a 1-based active-buffer cell. */
export function findTerminalHttpLinkAtPosition(
  term: Pick<Terminal, 'buffer'>,
  position: TerminalBufferPosition
): string | null {
  const logicalLine = buildWrappedLogicalLine(term.buffer.active, position.y)
  if (logicalLine === null) return null
  for (const parsed of extractTerminalHttpLinks(logicalLine.text)) {
    const range = rangeForParsedLink(logicalLine, parsed.startIndex, parsed.endIndex)
    if (range !== null && cellIsInBufferRange(position, range)) return parsed.url
  }
  return null
}

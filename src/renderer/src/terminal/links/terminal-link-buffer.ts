/**
 * Structural subset of xterm's buffer API used by link detection.
 *
 * Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.),
 * `src/shared/terminal/links/terminal-link-buffer.ts`.
 */

export type TerminalLinkBufferCell = {
  getWidth?(): number
  getChars?(): string
}

export type TerminalLinkBufferLine = {
  readonly isWrapped: boolean
  readonly length: number
  getCell?(x: number): TerminalLinkBufferCell | undefined
  translateToString(
    trimRight: boolean,
    startColumn?: number,
    endColumn?: number,
    outColumns?: number[]
  ): string
}

export type TerminalLinkBuffer = {
  getLine(y: number): TerminalLinkBufferLine | undefined
}

export type TerminalLinkBufferRange = {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

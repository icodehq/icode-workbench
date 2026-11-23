/**
 * Clipboard text for the visible terminal viewport.
 *
 * `getTranscript` returns the whole active buffer (scrollback in the normal
 * buffer; the TUI screen in the alt buffer). Copy Screen Content deliberately
 * copies only what the user can see right now.
 */

/** Matches the existing Copy Context cap. */
export const TERMINAL_CLIPBOARD_MAX_CHARS = 36_000

export type ScreenTextBuffer = {
  readonly viewportY: number
  readonly length: number
  getLine(row: number): { translateToString(trimRight?: boolean): string } | undefined
}

export function readScreenText(buffer: ScreenTextBuffer, rows: number): string {
  if (rows <= 0) return ''
  const start = Math.max(0, buffer.viewportY)
  const end = Math.min(buffer.length, start + rows)
  const lines: string[] = []
  for (let row = start; row < end; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
  }
  return lines.join('\n').replace(/\n+$/u, '')
}

export function capClipboardText(
  text: string,
  maxChars = TERMINAL_CLIPBOARD_MAX_CHARS
): string {
  return text.length > maxChars ? text.slice(-maxChars) : text
}

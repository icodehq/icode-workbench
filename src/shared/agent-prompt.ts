/**
 * PTY prompt framing shared by the renderer and the main process.
 *
 * A direct PTY paste is not an xterm paste: newlines must be CR, and an
 * embedded ESC could close the bracketed-paste frame early. The paste and the
 * submit Enter are separate writes because Claude Code treats a paste-end and
 * Enter in the same write as editable text, never as a submitted turn.
 */
export const AGENT_PASTE_START = '\u001b[200~'
export const AGENT_PASTE_END = '\u001b[201~'

/** Generous enough for the TUI to finish ingesting a multi-line paste. */
export const AGENT_SUBMIT_DELAY_MS = 500

const ESCAPE = '\u001b'
const INERT_ESCAPE = '␛'

/** The prompt itself, without the trailing newlines an editor may add. */
export function normalizeAgentPromptText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
}

/** Frame one prompt for a bracketed-paste-capable TUI. */
export function buildAgentPromptPaste(text: string): string {
  const body = normalizeAgentPromptText(text).replace(/\n/gu, '\r')
  const safe = body.split(ESCAPE).join(INERT_ESCAPE)
  return `${AGENT_PASTE_START}${safe}${AGENT_PASTE_END}`
}

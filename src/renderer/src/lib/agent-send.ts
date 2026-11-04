/**
 * A review send is only complete when the paste and the submit Enter were both
 * accepted by the PTY.
 *
 * The panel uses the failure message to keep the draft visible and explain the
 * refusal inline; a blank success would make "Sent" a lie.
 */
export type AgentSendResult =
  | { ok: true }
  | { ok: false; message: string }

export type AgentTextWriter = (data: string) => Promise<AgentSendResult>

export const AGENT_PASTE_START = '\u001b[200~'
export const AGENT_PASTE_END = '\u001b[201~'

/**
 * Claude Code leaves a bracketed paste as editable text when paste-end and
 * Enter arrive in the same PTY write. Real-app verification on Claude Code
 * 2.1.314 showed the previous single write left the notes in the composer and
 * never started a turn; a separate Enter submitted them. Keep the delay
 * generous enough for the TUI to finish ingesting the paste.
 */
export const AGENT_SUBMIT_DELAY_MS = 500

const ESCAPE = '\u001b'
const INERT_ESCAPE = '␛'

/** The prompt itself, without the trailing newlines an editor may add. */
export function normalizeAgentPromptText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
}

/**
 * A direct PTY paste is not an xterm paste: newlines must be CR, and an
 * embedded ESC could close the bracketed-paste frame early. Neutralize ESC
 * with the printable substitute (␛, U+241B), exactly as a terminal paste does.
 */
export function buildAgentPromptPaste(text: string): string {
  const body = normalizeAgentPromptText(text).replace(/\n/gu, '\r')
  const safe = body.split(ESCAPE).join(INERT_ESCAPE)
  return `${AGENT_PASTE_START}${safe}${AGENT_PASTE_END}`
}

/**
 * Deliver one multi-line prompt to an agent TUI.
 *
 * The paste and the Enter are deliberately separate writes. A single write
 * containing both is treated as a paste that never submits. If either write
 * fails, the caller keeps the notes; if the paste lands but Enter fails, the
 * composer still holds the text for a manual submit.
 */
export async function sendAgentText(
  text: string,
  write: AgentTextWriter,
  options: {
    submitDelayMs?: number
    sleep?: (ms: number) => Promise<void>
  } = {}
): Promise<AgentSendResult> {
  if (normalizeAgentPromptText(text).trim().length === 0) {
    return { ok: false, message: 'There are no notes to send.' }
  }
  const pasted = await write(buildAgentPromptPaste(text))
  if (!pasted.ok) return pasted
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  await sleep(options.submitDelayMs ?? AGENT_SUBMIT_DELAY_MS)
  return write('\r')
}


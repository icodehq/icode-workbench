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

export {
  AGENT_PASTE_END,
  AGENT_PASTE_START,
  AGENT_SUBMIT_DELAY_MS,
  buildAgentPromptPaste,
  normalizeAgentPromptText
} from '../../../shared/agent-prompt'

import {
  AGENT_SUBMIT_DELAY_MS,
  buildAgentPromptPaste,
  normalizeAgentPromptText
} from '../../../shared/agent-prompt'

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


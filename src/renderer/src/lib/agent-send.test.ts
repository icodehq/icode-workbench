import { describe, expect, it } from 'vitest'
import {
  AGENT_PASTE_END,
  AGENT_PASTE_START,
  AGENT_SUBMIT_DELAY_MS,
  buildAgentPromptPaste,
  normalizeAgentPromptText,
  sendAgentText
} from './agent-send'

describe('agent prompt paste', () => {
  it('frames the prompt, trims trailing newlines and uses CR for line breaks', () => {
    expect(normalizeAgentPromptText('line one\nline two\r\n\n')).toBe('line one\nline two')
    expect(buildAgentPromptPaste('line one\nline two\n')).toBe(
      `${AGENT_PASTE_START}line one\rline two${AGENT_PASTE_END}`
    )
  })

  it('neutralizes an embedded ESC so it cannot close the paste frame', () => {
    expect(buildAgentPromptPaste('before\u001b[201~after')).toBe(
      `${AGENT_PASTE_START}before␛[201~after${AGENT_PASTE_END}`
    )
  })
})

describe('sendAgentText', () => {
  it('writes the paste, waits, then writes a separate Enter', async () => {
    const writes: string[] = []
    let waited = 0
    const result = await sendAgentText(
      'one note',
      async (data) => {
        writes.push(data)
        return { ok: true }
      },
      {
        sleep: async (ms) => {
          waited = ms
        }
      }
    )
    expect(result).toEqual({ ok: true })
    expect(writes).toEqual([`${AGENT_PASTE_START}one note${AGENT_PASTE_END}`, '\r'])
    expect(waited).toBe(AGENT_SUBMIT_DELAY_MS)
  })

  it('does not write Enter when the paste fails', async () => {
    const writes: string[] = []
    const result = await sendAgentText('one note', async (data) => {
      writes.push(data)
      return { ok: false, message: 'terminal unavailable' }
    })
    expect(result).toEqual({ ok: false, message: 'terminal unavailable' })
    expect(writes).toHaveLength(1)
  })

  it('keeps the failure when the submit Enter fails', async () => {
    let calls = 0
    const result = await sendAgentText(
      'one note',
      async () => {
        calls += 1
        return calls === 1 ? { ok: true } : { ok: false, message: 'submit refused' }
      },
      { sleep: async () => {} }
    )
    expect(result).toEqual({ ok: false, message: 'submit refused' })
    expect(calls).toBe(2)
  })

  it('refuses an empty prompt', async () => {
    let called = false
    const result = await sendAgentText('  \n', async () => {
      called = true
      return { ok: true }
    })
    expect(result).toEqual({ ok: false, message: 'There are no notes to send.' })
    expect(called).toBe(false)
  })
})

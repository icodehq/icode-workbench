import { describe, expect, it } from 'vitest'
import { parseAssistantEnvelope } from './assistant-envelope'

describe('Mira response envelope', () => {
  it('parses a plain JSON object', () => {
    const parsed = parseAssistantEnvelope(
      '{"reply":"Hello","actions":[{"op":"tasks.listAll","limit":5}]}'
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.reply).toBe('Hello')
      expect(parsed.value.actions).toHaveLength(1)
    }
  })

  it('extracts a fenced or prefixed object', () => {
    const parsed = parseAssistantEnvelope(
      'Here is the result:\n```json\n{"reply":"Done","actions":[{"op":"state"}]}\n```\n'
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.reply).toBe('Done')
  })

  it('accepts the task continuation action', () => {
    const parsed = parseAssistantEnvelope(
      '{"reply":"Continuing.","actions":[{"op":"tasks.resume","taskId":"task_1"}]}'
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.actions).toEqual([{ op: 'tasks.resume', taskId: 'task_1' }])
    }
  })

  it('rejects an incomplete or invalid envelope', () => {
    expect(parseAssistantEnvelope('{"reply":"unterminated"').ok).toBe(false)
    expect(parseAssistantEnvelope('{"reply":"x","actions":[{"op":"delete.everything"}]}').ok).toBe(false)
    expect(parseAssistantEnvelope('{"reply":"x","unexpected":true}').ok).toBe(false)
  })
})

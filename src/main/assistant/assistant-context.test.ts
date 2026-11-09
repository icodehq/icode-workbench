import { describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../shared/domain/assistant'
import {
  buildAssistantContinuationPrompt,
  buildAssistantPrompt,
  type AssistantSnapshot
} from './assistant-context'

const snapshot: AssistantSnapshot = {
  now: 0,
  maxConcurrent: 3,
  projects: [],
  tasks: [],
  sessions: [],
  needs: { pendingApproval: 0, waiting: 0, failed: 0, reviewReady: 0 },
  memory: []
}

function build(overrides: Partial<Parameters<typeof buildAssistantPrompt>[0]> = {}) {
  return buildAssistantPrompt({
    personaName: 'Mira',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    snapshot,
    history: [{ role: 'user', body: 'remember ORCHID' }],
    userText: 'what codeword?',
    ...overrides
  })
}

describe('assistant prompt builder', () => {
  it('includes the standing header, snapshot, history and user text', () => {
    const built = build()
    expect(built.text).toContain('You are Mira')
    expect(built.text).toContain('## Current state')
    expect(built.text).toContain('## Recent conversation')
    expect(built.text).toContain('USER: remember ORCHID')
    expect(built.text).toContain('## User\nwhat codeword?')
    expect(built.text).toContain('Return exactly one JSON object')
  })

  it('omits replay history when the native conversation already holds it', () => {
    const built = build({ includeHistory: false })
    expect(built.text).not.toContain('## Recent conversation')
    expect(built.text).not.toContain('remember ORCHID')
    expect(built.text).toContain('## Current state')
    expect(built.text).toContain('## User\nwhat codeword?')
  })

  it('injects up to ten messages written since the previous turn', () => {
    const built = build({
      includeHistory: false,
      sinceLastTurn: Array.from({ length: 12 }, (_, index) => ({
        kind: 'notification',
        body: `notice-${String(index)}`
      }))
    })
    expect(built.text).toContain('## Since your last turn')
    expect(built.text.match(/- \[notification\]/gu)).toHaveLength(10)
    expect(built.text).toContain('notice-11')
    expect(built.text).not.toContain('notice-0')
  })

  it('builds a continuation that carries only new tool results', () => {
    expect(
      buildAssistantContinuationPrompt({ readResults: ['{"ok":true}'] })
    ).toBe(
      '## Tool results (this round)\n{"ok":true}\n\nContinue. Return only the JSON object.'
    )
    expect(
      buildAssistantContinuationPrompt({ readResults: [], corrective: 'Return valid JSON.' })
    ).toBe('Return valid JSON.')
  })

  it('caps the assembled prompt at the configured character limit', () => {
    const built = build({ userText: 'x'.repeat(70_000) })
    expect(built.text.endsWith('\n…[context truncated]')).toBe(true)
    expect(built.text.length).toBeLessThan(70_000)
    expect(built.truncated).toBe(true)
  })
})

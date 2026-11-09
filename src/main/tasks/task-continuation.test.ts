import { describe, expect, it } from 'vitest'
import { buildContinuationPrompt } from './task-continuation'

describe('buildContinuationPrompt', () => {
  it('carries the predecessor error, the inspect guidance and the original instruction', () => {
    const prompt = buildContinuationPrompt({
      originalPrompt: 'Implement the parser and run its tests.',
      previousError: 'The harness exited with code 1.',
      previousErrorDetail: 'Open the session to read its last output.'
    })

    expect(prompt).toContain('The harness exited with code 1.')
    expect(prompt).toContain('Inspect the current state')
    expect(prompt).toContain('do not redo completed work')
    expect(prompt).toContain('Implement the parser and run its tests.')
    expect(prompt).not.toContain('undefined')
  })

  it('uses the detail when no short error was recorded', () => {
    const prompt = buildContinuationPrompt({
      originalPrompt: 'Fix the build.',
      previousError: null,
      previousErrorDetail: 'The host lost the PTY.'
    })

    expect(prompt).toContain('The host lost the PTY.')
  })

  it('has a deterministic fallback when no failure text exists', () => {
    const prompt = buildContinuationPrompt({
      originalPrompt: 'Fix the build.',
      previousError: null,
      previousErrorDetail: null
    })

    expect(prompt).toContain('The previous attempt stopped before finishing.')
    expect(prompt).toContain('Fix the build.')
  })
})

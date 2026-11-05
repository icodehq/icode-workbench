import { describe, expect, it } from 'vitest'
import { commitMessageArgs, shouldRetryCodexWithoutEphemeral } from './harness-args'

describe('commit-message harness arguments', () => {
  it('uses each agent non-interactive mode', () => {
    expect(commitMessageArgs('claude')).toEqual([
      '-p',
      '--output-format',
      'text',
      '--permission-mode',
      'plan'
    ])
    expect(commitMessageArgs('codex')).toContain('exec')
    expect(commitMessageArgs('codex')).toContain('read-only')
    expect(commitMessageArgs('opencode')).toContain('--format')
    expect(commitMessageArgs('shell')).toBeNull()
  })

  it('retries Codex only when the rejected flag is --ephemeral', () => {
    expect(shouldRetryCodexWithoutEphemeral("error: unexpected argument '--ephemeral' found")).toBe(
      true
    )
    expect(shouldRetryCodexWithoutEphemeral('error: unexpected argument --sandbox found')).toBe(
      false
    )
    expect(shouldRetryCodexWithoutEphemeral('authentication failed')).toBe(false)
  })
})

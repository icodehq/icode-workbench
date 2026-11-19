import { describe, expect, it } from 'vitest'
import { presetsFor } from './provider-presets'

describe('provider presets', () => {
  it('keeps the curated harness-specific presets', () => {
    expect(presetsFor('claude').every((preset) => preset.harness === 'claude')).toBe(
      true
    )
    expect(presetsFor('codex').every((preset) => preset.harness === 'codex')).toBe(
      true
    )
    expect(
      presetsFor('opencode').every((preset) => preset.harness === 'opencode')
    ).toBe(true)
    expect(presetsFor('claude').length).toBeGreaterThan(0)
    expect(presetsFor('codex').length).toBeGreaterThan(0)
    expect(presetsFor('opencode').length).toBeGreaterThan(0)
  })

  it('gives Anthropic-family harnesses the Anthropic relays', () => {
    const presets = presetsFor('openclaude')
    expect(presets.length).toBeGreaterThan(0)
    expect(presets.every((preset) => preset.protocol === 'anthropic')).toBe(true)
    expect(presets.every((preset) => preset.authStyle === 'auth_token')).toBe(true)
  })

  it('gives OpenAI-chat harnesses the OpenAI-compatible family', () => {
    for (const harness of ['qwen-code', 'aider', 'copilot', 'kilo'] as const) {
      const presets = presetsFor(harness)
      expect(presets.length).toBeGreaterThan(0)
      expect(presets.every((preset) => preset.protocol === 'openai-chat')).toBe(
        true
      )
    }
  })

  it('gives Gemini the Google GenAI family', () => {
    const presets = presetsFor('gemini')
    expect(presets).toHaveLength(1)
    expect(presets[0]).toMatchObject({
      protocol: 'google-genai',
      baseUrl: 'https://generativelanguage.googleapis.com'
    })
  })

  it('does not leak a family preset into a harness with its own list', () => {
    expect(presetsFor('codex').some((preset) => preset.id.startsWith('family-'))).toBe(
      false
    )
  })
})

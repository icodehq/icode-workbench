import { describe, expect, it } from 'vitest'
import {
  PROVIDER_PREVIEW_MASK,
  providerHintKey,
  providerPreview,
  providerUsesGeneratedHome,
  providerUsesKeyFile
} from './provider-settings-view'

describe('provider settings view', () => {
  it('previews the masked args and env for an env recipe', () => {
    const preview = providerPreview({
      harness: 'claude',
      baseUrl: 'https://relay.example.com',
      model: 'claude-sonnet-5',
      authStyle: 'auth_token'
    })
    expect(preview).toContain('ANTHROPIC_BASE_URL')
    expect(preview).toContain(PROVIDER_PREVIEW_MASK)
    expect(preview).not.toContain('sk-')
    expect(JSON.parse(preview)).toMatchObject({
      args: ['--model', 'claude-sonnet-5'],
      files: []
    })
  })

  it('previews generated files for a file recipe', () => {
    const preview = providerPreview({
      harness: 'copilot',
      baseUrl: 'https://relay.example.com',
      model: 'gpt-5.1',
      authStyle: 'auth_token'
    })
    const parsed = JSON.parse(preview) as {
      args: string[]
      env: Record<string, string>
      files: Array<{ path: string; content: string }>
    }
    expect(parsed.args).toEqual(['--model', 'icode/gpt-5.1'])
    expect(parsed.env.COPILOT_PROVIDERS_CONFIG).toBe('<generated file>')
    expect(parsed.files[0]?.path).toBe('providers.json')
    expect(parsed.files[0]?.content).toContain(PROVIDER_PREVIEW_MASK)
  })

  it('shows a placeholder path for a pathArgs recipe', () => {
    const parsed = JSON.parse(
      providerPreview({
        harness: 'continue',
        baseUrl: 'https://relay.example.com',
        model: 'gpt-5.1',
        authStyle: 'auth_token'
      })
    ) as { args: string[]; files: Array<{ path: string }> }
    expect(parsed.args).toEqual(['--config', '<generated file>'])
    expect(parsed.files[0]?.path).toBe('config.yaml')
  })

  it('selects hints only for the recipes that need them', () => {
    expect(providerHintKey('codebuddy')).toBe('settings.providers.hint.codebuddy')
    expect(providerHintKey('goose')).toBe('settings.providers.hint.goose')
    expect(providerHintKey('gemini')).toBe('settings.providers.hint.gemini')
    expect(providerHintKey('aider')).toBe('settings.providers.hint.aider')
    expect(providerHintKey('claude')).toBeNull()
  })

  it('marks key-file and generated-home recipes', () => {
    expect(providerUsesKeyFile('copilot')).toBe(true)
    expect(providerUsesKeyFile('zcode')).toBe(true)
    expect(providerUsesKeyFile('continue')).toBe(true)
    expect(providerUsesKeyFile('pi')).toBe(false)

    expect(providerUsesGeneratedHome('pi')).toBe(true)
    expect(providerUsesGeneratedHome('omp')).toBe(true)
    expect(providerUsesGeneratedHome('ante')).toBe(true)
    expect(providerUsesGeneratedHome('mistral-vibe')).toBe(true)
    expect(providerUsesGeneratedHome('gemini')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  PROVIDER_KEY_ENV,
  nativeLaunchSpec,
  providerLaunchSpec,
  withClaudeProviderEnv,
  type ProviderLaunchInput
} from './provider-launch'

const claude: ProviderLaunchInput = {
  harness: 'claude',
  baseUrl: 'https://relay.example.com',
  model: 'claude-sonnet-5',
  authStyle: 'auth_token',
  apiKey: 'sk-test'
}

describe('provider launch spec', () => {
  it('returns an empty spec for native configuration', () => {
    expect(nativeLaunchSpec()).toEqual({ args: [], env: {}, claudeEnv: {} })
  })

  it('passes Claude provider data in the environment and model in argv', () => {
    const spec = providerLaunchSpec(claude)
    expect(spec.args).toEqual(['--model', 'claude-sonnet-5'])
    expect(spec.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://relay.example.com',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-5',
      ANTHROPIC_AUTH_TOKEN: 'sk-test',
      ANTHROPIC_API_KEY: ''
    })
    expect(spec.args.join(' ')).not.toContain('sk-test')
    expect(spec.claudeEnv).toEqual({})
  })

  it('uses ANTHROPIC_API_KEY when the Claude auth style asks for it', () => {
    const spec = providerLaunchSpec({ ...claude, authStyle: 'api_key' })
    expect(spec.env.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('')
  })

  it('passes Codex dotted config overrides and keeps the key out of argv', () => {
    const spec = providerLaunchSpec({ ...claude, harness: 'codex', authStyle: null })
    const pairs = spec.args.reduce<string[]>((acc, value, index, all) => {
      if (value === '-c' && all[index + 1] !== undefined) acc.push(all[index + 1]!)
      return acc
    }, [])

    expect(pairs).toContain('model_provider="icode"')
    expect(pairs).toContain('model="claude-sonnet-5"')
    expect(pairs).toContain('model_providers.icode.base_url="https://relay.example.com"')
    expect(pairs).toContain('model_providers.icode.wire_api="responses"')
    expect(pairs).toContain(`model_providers.icode.env_key="${PROVIDER_KEY_ENV}"`)
    expect(spec.args.join(' ')).not.toContain('sk-test')
    expect(spec.env).toEqual({ [PROVIDER_KEY_ENV]: 'sk-test' })
  })

  it('escapes TOML strings', () => {
    const spec = providerLaunchSpec({
      ...claude,
      harness: 'codex',
      authStyle: null,
      model: 'm"o\\del'
    })
    expect(spec.args.join(' ')).toContain('model="m\\"o\\\\del"')
  })

  it('builds an inline OpenCode config with the provider and model', () => {
    const spec = providerLaunchSpec({ ...claude, harness: 'opencode', authStyle: null })
    const config = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT!) as {
      provider: Record<string, { options: { baseURL: string; apiKey: string } }>
      model: string
    }
    expect(config.provider.icode!.options).toEqual({
      baseURL: 'https://relay.example.com',
      apiKey: 'sk-test'
    })
    expect(config.model).toBe('icode/claude-sonnet-5')
  })

  it('merges provider env into a Claude overlay without dropping hooks', () => {
    const merged = withClaudeProviderEnv(
      {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node hook.cjs' }] }] },
        env: { KEEP_ME: '1', ANTHROPIC_MODEL: 'old' }
      },
      { ANTHROPIC_MODEL: 'new' }
    )

    expect(merged.hooks).toBeDefined()
    expect(merged.env).toEqual({ KEEP_ME: '1', ANTHROPIC_MODEL: 'new' })
  })
})

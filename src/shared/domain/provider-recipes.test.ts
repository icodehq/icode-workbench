import { describe, expect, it } from 'vitest'
import { HARNESS_IDS, MODEL_HARNESSES } from './harness'
import {
  PROVIDER_HARNESSES,
  PROVIDER_RECIPE_HARNESSES,
  PROVIDER_RECIPES,
  isProviderHarness,
  providerLaunchPlan,
  type ProviderLaunchInput,
  type ProviderRecipeHarness
} from './provider-recipes'

const claude: ProviderLaunchInput = {
  harness: 'claude',
  baseUrl: 'https://relay.example.com',
  model: 'claude-sonnet-5',
  authStyle: 'auth_token',
  apiKey: 'sk-test'
}

describe('provider recipes', () => {
  it('keeps shipped provider harnesses independent from model harnesses', () => {
    expect(PROVIDER_HARNESSES).not.toBe(MODEL_HARNESSES)
    for (const id of PROVIDER_HARNESSES) {
      expect(HARNESS_IDS).toContain(id)
      expect(PROVIDER_RECIPE_HARNESSES).toContain(id)
      expect(isProviderHarness(id)).toBe(true)
    }
    // Implemented but not yet live-verified recipes are not shipped.
    expect(PROVIDER_RECIPE_HARNESSES.length).toBeGreaterThan(
      PROVIDER_HARNESSES.length
    )
    expect(isProviderHarness('openclaude')).toBe(false)
  })

  it('has one exhaustive recipe per implemented harness', () => {
    expect(Object.keys(PROVIDER_RECIPES)).toEqual([
      ...PROVIDER_RECIPE_HARNESSES
    ])
    for (const id of PROVIDER_RECIPE_HARNESSES) {
      const recipe = PROVIDER_RECIPES[id]
      expect(recipe.harness).toBe(id)
      expect(recipe.docsUrl.length).toBeGreaterThan(0)
      expect(recipe.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
      expect(recipe.verifiedCliVersion.length).toBeGreaterThan(0)
    }
    expect(isProviderHarness('shell')).toBe(false)
    expect(isProviderHarness('not-a-harness')).toBe(false)
  })

  it('declares auth choices only where the harness supports them', () => {
    expect(PROVIDER_RECIPES.claude.authStyles).toEqual(['auth_token', 'api_key'])
    expect(PROVIDER_RECIPES.openclaude.authStyles).toEqual([
      'auth_token',
      'api_key'
    ])
    for (const id of PROVIDER_RECIPE_HARNESSES.filter(
      (harness) => harness !== 'claude' && harness !== 'openclaude'
    )) {
      expect(PROVIDER_RECIPES[id].authStyles).toEqual([])
    }
  })

  it('keeps the key out of argv for every recipe', () => {
    for (const id of PROVIDER_RECIPE_HARNESSES) {
      const plan = providerLaunchPlan({
        ...claude,
        harness: id,
        authStyle: PROVIDER_RECIPES[id].authStyles.length > 0 ? 'auth_token' : null
      })
      expect(plan.args.join(' ')).not.toContain('sk-test')
      // Env or a generated config file carries the key; argv never does.
      expect(JSON.stringify(plan)).toContain('sk-test')
    }
  })

  it('builds the environment recipes with their documented variables', () => {
    const input = (
      harness: ProviderRecipeHarness,
      overrides: Partial<ProviderLaunchInput> = {}
    ): ProviderLaunchInput => ({
      ...claude,
      harness,
      authStyle: null,
      ...overrides
    })

    const openclaude = providerLaunchPlan(
      input('openclaude', { authStyle: 'api_key' })
    )
    expect(openclaude.args).toEqual(['--model', 'claude-sonnet-5'])
    expect(openclaude.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://relay.example.com',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_AUTH_TOKEN: ''
    })

    const codebuddy = providerLaunchPlan(
      input('codebuddy', { baseUrl: 'https://gateway.example.com' })
    )
    expect(codebuddy.env).toEqual({
      CODEBUDDY_BASE_URL: 'https://gateway.example.com/v1',
      CODEBUDDY_API_KEY: 'sk-test',
      CODEBUDDY_MODEL: 'claude-sonnet-5'
    })

    const kimi = providerLaunchPlan(input('kimi'))
    expect(kimi.env).toEqual({
      KIMI_MODEL_BASE_URL: 'https://relay.example.com',
      KIMI_MODEL_API_KEY: 'sk-test',
      KIMI_MODEL_NAME: 'claude-sonnet-5',
      KIMI_MODEL_PROVIDER_TYPE: 'openai'
    })

    const qwen = providerLaunchPlan(input('qwen-code'))
    expect(qwen.args).toEqual(['--auth-type', 'openai'])
    expect(qwen.env).toMatchObject({
      OPENAI_BASE_URL: 'https://relay.example.com',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_MODEL: 'claude-sonnet-5'
    })

    const kilo = providerLaunchPlan(input('kilo'))
    const kiloConfig = JSON.parse(kilo.env.KILO_CONFIG_CONTENT!) as {
      provider: Record<string, { options: { baseURL: string; apiKey: string } }>
      model: string
    }
    expect(kiloConfig.provider.icode!.options).toEqual({
      baseURL: 'https://relay.example.com',
      apiKey: 'sk-test'
    })
    expect(kiloConfig.model).toBe('icode/claude-sonnet-5')

    const aider = providerLaunchPlan(
      input('aider', {
        baseUrl: 'https://relay.example.com/chat/completions'
      })
    )
    expect(aider.args).toEqual(['--model', 'openai/claude-sonnet-5'])
    expect(aider.env).toEqual({
      OPENAI_API_BASE: 'https://relay.example.com',
      OPENAI_API_KEY: 'sk-test'
    })

    const goose = providerLaunchPlan(
      input('goose', { baseUrl: 'https://gateway.example.com/v1' })
    )
    expect(goose.env).toMatchObject({
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'claude-sonnet-5',
      OPENAI_HOST: 'https://gateway.example.com',
      OPENAI_BASE_PATH: 'v1/chat/completions',
      OPENAI_API_KEY: 'sk-test'
    })

    const grok = providerLaunchPlan(input('grok'))
    expect(grok.args).toEqual(['-m', 'claude-sonnet-5'])
    expect(grok.env).toMatchObject({
      GROK_MODELS_BASE_URL: 'https://relay.example.com/v1',
      XAI_API_KEY: 'sk-test',
      GROK_DEFAULT_MODEL: 'claude-sonnet-5'
    })

    const gemini = providerLaunchPlan(input('gemini'))
    expect(gemini.args).toEqual(['--model', 'claude-sonnet-5'])
    expect(gemini.env).toEqual({
      GOOGLE_GEMINI_BASE_URL: 'https://relay.example.com',
      GEMINI_API_KEY: 'sk-test'
    })
  })

  it('builds generated file and directory recipes', () => {
    const input = (harness: ProviderRecipeHarness): ProviderLaunchInput => ({
      ...claude,
      harness,
      authStyle: null
    })
    const fileContents = (harness: ProviderRecipeHarness): string => {
      const delivery = providerLaunchPlan(input(harness)).delivery
      if (delivery?.kind !== 'file') throw new Error(`${harness} is not a file recipe`)
      return delivery.contents
    }

    const zcode = providerLaunchPlan(input('zcode'))
    expect(zcode.delivery).toMatchObject({
      kind: 'file',
      pathEnv: 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'
    })
    const zcodeConfig = JSON.parse(fileContents('zcode')) as {
      config: { providerConfigRules: { providerRules: Array<Record<string, unknown>> } }
      defaultModelSelection: { modelId: string }
    }
    expect(zcodeConfig.config.providerConfigRules.providerRules[0]).toMatchObject({
      providerId: 'icode',
      access: { type: 'api-key', apiKey: 'sk-test' },
      api: { type: 'openai-chat-completions', baseUrl: 'https://relay.example.com' },
      personalModelIds: ['claude-sonnet-5']
    })
    expect(zcodeConfig.defaultModelSelection.modelId).toBe('claude-sonnet-5')

    const continuePlan = providerLaunchPlan(input('continue'))
    expect(continuePlan.delivery).toMatchObject({
      kind: 'file',
      pathArgs: ['--config', '{path}']
    })
    expect(fileContents('continue')).toContain('apiBase: "https://relay.example.com/v1"')

    const copilot = providerLaunchPlan(input('copilot'))
    expect(copilot.args).toEqual(['--model', 'icode/claude-sonnet-5'])
    const copilotConfig = JSON.parse(fileContents('copilot')) as {
      providers: Array<Record<string, unknown>>
      models: Array<Record<string, unknown>>
    }
    expect(copilotConfig.providers[0]).toMatchObject({
      name: 'icode',
      type: 'openai',
      wireApi: 'completions',
      apiKey: 'sk-test'
    })
    expect(copilotConfig.models[0]).toMatchObject({
      id: 'claude-sonnet-5',
      provider: 'icode',
      wireModel: 'claude-sonnet-5'
    })

    const pi = providerLaunchPlan(input('pi'))
    expect(pi.args).toEqual(['--provider', 'icode', '--model', 'claude-sonnet-5'])
    expect(pi.delivery).toMatchObject({ kind: 'dir', pathEnv: 'PI_CODING_AGENT_DIR' })
    const piDelivery = pi.delivery
    if (piDelivery?.kind !== 'dir') throw new Error('pi is not a dir recipe')
    expect(JSON.parse(piDelivery.files[0]!.contents)).toEqual({
      providers: {
        icode: {
          baseUrl: 'https://relay.example.com',
          api: 'openai-completions',
          apiKey: 'sk-test',
          models: [{ id: 'claude-sonnet-5' }]
        }
      }
    })

    const omp = providerLaunchPlan(input('omp'))
    expect(omp.args).toEqual(['--model', 'icode/claude-sonnet-5'])
    if (omp.delivery?.kind !== 'dir') throw new Error('omp is not a dir recipe')
    expect(omp.delivery.files[0]!.contents).toContain('api: openai-completions')

    const ante = providerLaunchPlan(input('ante'))
    expect(ante.args).toEqual(['--provider', 'icode', '--model', 'claude-sonnet-5'])
    expect(ante.env.ICODE_PROVIDER_API_KEY).toBe('sk-test')
    if (ante.delivery?.kind !== 'dir') throw new Error('ante is not a dir recipe')
    const anteCatalog = JSON.parse(ante.delivery.files[0]!.contents) as {
      providers: { icode: { auth: { bearer: { env_key: string } } } }
    }
    expect(anteCatalog.providers.icode.auth.bearer.env_key).toBe(
      'ICODE_PROVIDER_API_KEY'
    )

    const vibe = providerLaunchPlan(input('mistral-vibe'))
    expect(vibe.env.ICODE_PROVIDER_API_KEY).toBe('sk-test')
    if (vibe.delivery?.kind !== 'dir') throw new Error('vibe is not a dir recipe')
    expect(vibe.delivery.files[0]!.contents).toContain(
      'api_key_env_var = "ICODE_PROVIDER_API_KEY"'
    )

    for (const harness of [
      'zcode',
      'continue',
      'pi',
      'omp',
      'ante',
      'copilot',
      'mistral-vibe'
    ] as const) {
      expect(PROVIDER_RECIPES[harness].seed).toBeDefined()
    }
  })

  it('produces the same Claude env through the registry', () => {
    const plan = providerLaunchPlan(claude)
    expect(plan.args).toEqual(['--model', 'claude-sonnet-5'])
    expect(plan.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://relay.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-test',
      ANTHROPIC_API_KEY: ''
    })
    expect(plan.claudeEnv).toEqual({})
  })
})

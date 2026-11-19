import {
  PROVIDER_RECIPES,
  providerLaunchPlan,
  type ProviderAuthStyle,
  type ProviderRecipeHarness
} from '../../../shared/domain/provider-recipes'

export const PROVIDER_PREVIEW_MASK = '••••••••'

const HINT_KEYS = {
  codebuddy: 'settings.providers.hint.codebuddy',
  goose: 'settings.providers.hint.goose',
  gemini: 'settings.providers.hint.gemini',
  aider: 'settings.providers.hint.aider'
} as const

export type ProviderHintKey = (typeof HINT_KEYS)[keyof typeof HINT_KEYS]

const HINT_KEY_BY_HARNESS: Partial<Record<ProviderRecipeHarness, ProviderHintKey>> =
  HINT_KEYS

const KEY_FILE_HARNESSES: ReadonlySet<ProviderRecipeHarness> = new Set([
  'copilot',
  'zcode',
  'continue'
])

const GENERATED_HOME_HARNESSES: ReadonlySet<ProviderRecipeHarness> = new Set([
  'pi',
  'omp',
  'ante',
  'mistral-vibe'
])

export function providerHintKey(harness: ProviderRecipeHarness): ProviderHintKey | null {
  return HINT_KEY_BY_HARNESS[harness] ?? null
}

export function providerUsesKeyFile(harness: ProviderRecipeHarness): boolean {
  return KEY_FILE_HARNESSES.has(harness)
}

export function providerUsesGeneratedHome(harness: ProviderRecipeHarness): boolean {
  return GENERATED_HOME_HARNESSES.has(harness)
}

/**
 * The Settings preview. It never receives the real key: a fixed mask is fed
 * through the same recipe builder the launch path uses, so the shape is real
 * and the secret is not in the DOM.
 */
export function providerPreview(input: {
  harness: ProviderRecipeHarness
  baseUrl: string
  model: string
  authStyle: ProviderAuthStyle
}): string {
  const plan = providerLaunchPlan({
    harness: input.harness,
    baseUrl: input.baseUrl || 'https://api.example.com',
    model: input.model || 'model',
    authStyle:
      PROVIDER_RECIPES[input.harness].authStyles.length > 0
        ? input.authStyle
        : null,
    apiKey: PROVIDER_PREVIEW_MASK
  })
  const delivery = plan.delivery
  const env = { ...plan.env }
  const args = [...plan.args]
  if (delivery?.kind === 'file') {
    if (delivery.pathEnv !== undefined) env[delivery.pathEnv] = '<generated file>'
    for (const arg of delivery.pathArgs ?? []) {
      args.push(arg.replaceAll('{path}', '<generated file>'))
    }
  } else if (delivery?.kind === 'dir') {
    env[delivery.pathEnv] = '<generated home>'
  }
  const files =
    delivery?.kind === 'file'
      ? [{ path: delivery.relativePath, content: delivery.contents }]
      : delivery?.kind === 'dir'
        ? delivery.files.map((file) => ({
            path: file.relativePath,
            content: file.contents
          }))
        : []
  return JSON.stringify({ args, env, files }, null, 2)
}

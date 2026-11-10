import type {
  ProviderAuthStyle,
  ProviderHarness
} from './schemas/provider'

/**
 * Turns a provider into the inputs a harness understands.
 *
 * iCode launches every session, so a provider is injected at process start and
 * never written into the user's global config. Each harness has its own
 * mechanism, but credentials always travel in the PTY environment so they never
 * appear in argv, shell history, or a key-bearing file:
 *
 *   Claude Code  ANTHROPIC_* environment + `--model` (the hook overlay stays keyless)
 *   Codex        `-c` TOML overrides + ICODE_PROVIDER_API_KEY
 *   OpenCode     OPENCODE_CONFIG_CONTENT inline JSON
 *
 * The translator is pure and shared with the Settings preview. The preview
 * passes a masked key; it never has the real one.
 */

export type ProviderLaunchInput = {
  harness: ProviderHarness
  baseUrl: string
  model: string
  authStyle: ProviderAuthStyle | null
  apiKey: string
}

export type ProviderLaunchSpec = {
  args: string[]
  env: Record<string, string>
  /**
   * Fallback only: environment for a merged Claude `--settings` overlay.
   * Empty in the normal env-first path.
   */
  claudeEnv: Record<string, string>
}

export const PROVIDER_KEY_ENV = 'ICODE_PROVIDER_API_KEY'

/** Flip only if a measured Claude version ignores provider process env. */
export const CLAUDE_PROVIDER_DELIVERY: 'env' | 'settings-overlay' = 'env'

const CODEX_ROUTE_ID = 'icode'

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}"`
}

export function nativeLaunchSpec(): ProviderLaunchSpec {
  return { args: [], env: {}, claudeEnv: {} }
}

function claudeEnv(provider: ProviderLaunchInput): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_MODEL: provider.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: provider.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: provider.model
  }
  if (provider.authStyle === 'api_key') {
    env.ANTHROPIC_API_KEY = provider.apiKey
    // Empty rather than absent: Claude warns when both are set, and an empty
    // value is treated as unset by its env checks.
    env.ANTHROPIC_AUTH_TOKEN = ''
  } else {
    env.ANTHROPIC_AUTH_TOKEN = provider.apiKey
    env.ANTHROPIC_API_KEY = ''
  }
  return env
}

function claudeSpec(provider: ProviderLaunchInput): ProviderLaunchSpec {
  if (CLAUDE_PROVIDER_DELIVERY === 'settings-overlay') {
    return {
      args: [],
      env: {},
      claudeEnv: claudeEnv(provider)
    }
  }
  return {
    // The flag wins over a `model` in the user's settings.json.
    args: ['--model', provider.model],
    env: claudeEnv(provider),
    claudeEnv: {}
  }
}

function codexSpec(provider: ProviderLaunchInput): ProviderLaunchSpec {
  return {
    args: [
      '-c',
      `model_provider=${tomlString(CODEX_ROUTE_ID)}`,
      '-c',
      `model=${tomlString(provider.model)}`,
      '-c',
      `model_providers.${CODEX_ROUTE_ID}.name=${tomlString('iCode')}`,
      '-c',
      `model_providers.${CODEX_ROUTE_ID}.base_url=${tomlString(provider.baseUrl)}`,
      // Codex 0.167 only supports the Responses API for custom providers.
      '-c',
      `model_providers.${CODEX_ROUTE_ID}.wire_api=${tomlString('responses')}`,
      '-c',
      `model_providers.${CODEX_ROUTE_ID}.env_key=${tomlString(PROVIDER_KEY_ENV)}`
    ],
    env: { [PROVIDER_KEY_ENV]: provider.apiKey },
    claudeEnv: {}
  }
}

function opencodeSpec(provider: ProviderLaunchInput): ProviderLaunchSpec {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [CODEX_ROUTE_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'iCode',
        options: {
          baseURL: provider.baseUrl,
          apiKey: provider.apiKey
        },
        models: {
          [provider.model]: { name: provider.model }
        }
      }
    },
    model: `${CODEX_ROUTE_ID}/${provider.model}`
  }
  return {
    args: [],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    claudeEnv: {}
  }
}

export function providerLaunchSpec(provider: ProviderLaunchInput): ProviderLaunchSpec {
  switch (provider.harness) {
    case 'claude':
      return claudeSpec(provider)
    case 'codex':
      return codexSpec(provider)
    case 'opencode':
      return opencodeSpec(provider)
  }
}

/**
 * Fallback only: applies provider env to an existing Claude overlay document.
 *
 * The hook overlay and the provider must arrive in one `--settings` file:
 * multiple overlays do not deep-merge `env` (measured), so passing two would
 * silently drop whichever env block is read first.
 */
export function withClaudeProviderEnv(
  overlay: Record<string, unknown>,
  env: Record<string, string>
): Record<string, unknown> {
  if (Object.keys(env).length === 0) return overlay
  const existing =
    overlay.env !== null && typeof overlay.env === 'object' && !Array.isArray(overlay.env)
      ? (overlay.env as Record<string, unknown>)
      : {}
  return { ...overlay, env: { ...existing, ...env } }
}

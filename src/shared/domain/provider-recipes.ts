/**
 * The provider recipe registry.
 *
 * A provider turns a base URL, model, and key into harness-specific launch
 * inputs. This module is pure data: it never touches the filesystem, the
 * process environment, or the harness's saved config. Main materializes any
 * generated files described by a recipe at launch time.
 *
 * `PROVIDER_HARNESSES` is deliberately its own list, not `MODEL_HARNESSES`.
 * The latter also drives Mira, AI commit messages, and supervisor priority,
 * so widening provider support must never widen those capabilities.
 */

import type { HarnessId } from './harness-catalog'

export const PROVIDER_AUTH_STYLES = ['auth_token', 'api_key'] as const
export type ProviderAuthStyle = (typeof PROVIDER_AUTH_STYLES)[number]

/**
 * Every implemented recipe, whether or not it has passed live verification.
 * The support matrix and the recipe tests iterate this list.
 */
export const PROVIDER_RECIPE_HARNESSES = [
  'claude',
  'codex',
  'opencode',
  'openclaude',
  'codebuddy',
  'kimi',
  'zcode',
  'qwen-code',
  'kilo',
  'continue',
  'pi',
  'omp',
  'ante',
  'copilot',
  'gemini',
  'aider',
  'goose',
  'grok',
  'mistral-vibe'
] as const satisfies readonly HarnessId[]
export type ProviderRecipeHarness = (typeof PROVIDER_RECIPE_HARNESSES)[number]

/**
 * Shipped harnesses: only recipes whose hands-on check passed. A recipe is
 * added here after `pnpm verify:providers` records a passing matrix row.
 */
export const PROVIDER_HARNESSES = [
  'claude',
  'codex',
  'opencode'
] as const satisfies readonly ProviderRecipeHarness[]
export type ProviderHarness = (typeof PROVIDER_HARNESSES)[number]

export const PROVIDER_PROTOCOLS = [
  'anthropic',
  'openai-chat',
  'openai-responses',
  'google-genai'
] as const
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number]

export type ProviderLaunchInput = {
  harness: ProviderRecipeHarness
  baseUrl: string
  model: string
  authStyle: ProviderAuthStyle | null
  apiKey: string
}

export type ProviderFileFormat = 'json' | 'jsonc' | 'yaml' | 'toml' | 'text'

export type GeneratedFile = {
  /** Path relative to the generated file/directory root. */
  relativePath: string
  contents: string
  /** POSIX mode for platforms that honor it. */
  mode?: number
}

/** One candidate source for a user config file or directory. */
export type ProviderSeedSource = {
  /** Environment variable holding an absolute file or directory. */
  env?: string
  /** Path segments appended when the env value names a directory. */
  envSegments?: readonly string[]
  /** Candidate home-relative paths, in priority order. */
  homePaths?: readonly (readonly string[])[]
}

/** Where a generated delivery may seed unrelated settings from. */
export type ProviderSeedSpec = ProviderSeedSource & {
  /** Generated file (relative path) that the seed text is merged into. */
  target?: string
  /**
   * Files copied into a generated directory home before the generated files
   * are written (auth, settings). Missing sources are skipped.
   */
  copy?: readonly (ProviderSeedSource & { target: string })[]
  /**
   * Existing directories linked into a generated home so extensions survive
   * relocation. A failed link is ignored; it must not block a launch.
   */
  link?: readonly (ProviderSeedSource & { target: string })[]
}

export type ProviderDelivery =
  | { kind: 'env' }
  | {
      kind: 'file'
      /** Env var that receives the generated file's path. */
      pathEnv?: string
      /** Args appended with `{path}` replaced by the generated file's path. */
      pathArgs?: string[]
      relativePath: string
      contents: string
      format: ProviderFileFormat
    }
  | {
      kind: 'dir'
      /** Env var that receives the generated directory's path. */
      pathEnv: string
      files: GeneratedFile[]
    }

export type ProviderVerifySpec = {
  versionArgs: string[]
  promptArgs: string[]
  stdin?: string
  timeoutMs: number
}

export type ProviderLaunchPlan = {
  args: string[]
  env: Record<string, string>
  /**
   * Fallback only: environment for a merged Claude `--settings` overlay.
   * Empty in the normal env-first path.
   */
  claudeEnv?: Record<string, string>
  delivery?: ProviderDelivery
}

export type ProviderRecipe = {
  harness: ProviderRecipeHarness
  protocol: ProviderProtocol
  authStyles: readonly ProviderAuthStyle[]
  docsUrl: string
  verifiedAt: string
  verifiedCliVersion: string
  build(input: ProviderLaunchInput): ProviderLaunchPlan
  /** User config merged into a generated file/directory, when one exists. */
  seed?: ProviderSeedSpec
  verify?: ProviderVerifySpec
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

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '')
}

/** OpenAI-compatible CLIs that want `/v1` as part of the base URL. */
function withV1(baseUrl: string): string {
  const base = trimBaseUrl(baseUrl)
  return /\/v1$/u.test(base) ? base : `${base}/v1`
}

function withoutChatCompletions(baseUrl: string): string {
  return trimBaseUrl(baseUrl).replace(/\/chat\/completions$/u, '')
}

function prefixedModel(model: string, prefix: string): string {
  return model.startsWith(prefix) ? model : `${prefix}${model}`
}

/**
 * Goose wants the origin in OPENAI_HOST and the path (default
 * `v1/chat/completions`) in OPENAI_BASE_PATH; putting `/v1` in the host is the
 * classic double-path failure.
 */
function gooseEndpoint(baseUrl: string): { host: string; basePath: string } {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/^\/+/u, '').replace(/\/+$/u, '')
  const host = `${url.protocol}//${url.host}`
  if (path.length === 0) return { host, basePath: 'v1/chat/completions' }
  return {
    host,
    basePath: path.endsWith('/chat/completions')
      ? path
      : `${path}/chat/completions`
  }
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

function claudeSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  if (CLAUDE_PROVIDER_DELIVERY === 'settings-overlay') {
    return {
      args: [],
      env: {},
      claudeEnv: claudeEnv(provider),
      delivery: { kind: 'env' }
    }
  }
  return {
    // The flag wins over a `model` in the user's settings.json.
    args: ['--model', provider.model],
    env: claudeEnv(provider),
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function codexSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
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
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function opencodeSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
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
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function openClaudeSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  return {
    args: ['--model', provider.model],
    env: claudeEnv(provider),
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function codebuddySpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  return {
    args: [],
    env: {
      CODEBUDDY_BASE_URL: withV1(provider.baseUrl),
      CODEBUDDY_API_KEY: provider.apiKey,
      CODEBUDDY_MODEL: provider.model
    },
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function kimiSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  return {
    args: [],
    env: {
      KIMI_MODEL_BASE_URL: trimBaseUrl(provider.baseUrl),
      KIMI_MODEL_API_KEY: provider.apiKey,
      KIMI_MODEL_NAME: provider.model,
      KIMI_MODEL_PROVIDER_TYPE: 'openai'
    },
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function qwenSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  return {
    args: ['--auth-type', 'openai'],
    env: {
      OPENAI_BASE_URL: trimBaseUrl(provider.baseUrl),
      OPENAI_API_KEY: provider.apiKey,
      OPENAI_MODEL: provider.model
    },
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function kiloSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  const config = {
    provider: {
      icode: {
        npm: '@ai-sdk/openai-compatible',
        name: 'iCode',
        options: {
          baseURL: trimBaseUrl(provider.baseUrl),
          apiKey: provider.apiKey
        },
        models: {
          [provider.model]: { name: provider.model }
        }
      }
    },
    model: `icode/${provider.model}`
  }
  return {
    args: [],
    env: { KILO_CONFIG_CONTENT: JSON.stringify(config) },
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function aiderSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  return {
    args: ['--model', prefixedModel(provider.model, 'openai/')],
    env: {
      OPENAI_API_BASE: withoutChatCompletions(provider.baseUrl),
      OPENAI_API_KEY: provider.apiKey
    },
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function gooseSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  const endpoint = gooseEndpoint(provider.baseUrl)
  return {
    args: [],
    env: {
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: provider.model,
      OPENAI_HOST: endpoint.host,
      OPENAI_BASE_PATH: endpoint.basePath,
      OPENAI_API_KEY: provider.apiKey
    },
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function grokSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  return {
    args: ['-m', provider.model],
    env: {
      GROK_MODELS_BASE_URL: withV1(provider.baseUrl),
      XAI_API_KEY: provider.apiKey,
      GROK_DEFAULT_MODEL: provider.model
    },
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

function geminiSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  return {
    args: ['--model', provider.model],
    env: {
      GOOGLE_GEMINI_BASE_URL: trimBaseUrl(provider.baseUrl),
      GEMINI_API_KEY: provider.apiKey
    },
    claudeEnv: {},
    delivery: { kind: 'env' }
  }
}

/** JSON strings are valid YAML double-quoted scalars. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

function zcodeSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  const config = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: 'icode',
            providerName: 'iCode',
            config: { group: 'standard-personal' },
            access: { type: 'api-key', apiKey: provider.apiKey },
            api: {
              type: 'openai-chat-completions',
              baseUrl: trimBaseUrl(provider.baseUrl)
            },
            personalModelIds: [provider.model],
            providerModelRules: [],
            manualProviderModelRules: []
          }
        ]
      }
    },
    defaultModelSelection: {
      providerId: 'icode',
      modelId: provider.model
    }
  }
  return {
    args: [],
    env: {},
    claudeEnv: {},
    delivery: {
      kind: 'file',
      pathEnv: 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',
      relativePath: 'provider_config.json',
      contents: `${JSON.stringify(config, null, 2)}\n`,
      format: 'json'
    }
  }
}

function continueSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  const contents =
    [
      'models:',
      '  - name: iCode',
      '    provider: openai',
      `    model: ${yamlString(provider.model)}`,
      `    apiBase: ${yamlString(withV1(provider.baseUrl))}`,
      `    apiKey: ${yamlString(provider.apiKey)}`
    ].join('\n') + '\n'
  return {
    args: [],
    env: {},
    claudeEnv: {},
    delivery: {
      kind: 'file',
      pathArgs: ['--config', '{path}'],
      relativePath: 'config.yaml',
      contents,
      format: 'yaml'
    }
  }
}

function copilotSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  const config = {
    providers: [
      {
        name: 'icode',
        type: 'openai',
        baseUrl: trimBaseUrl(provider.baseUrl),
        apiKey: provider.apiKey,
        wireApi: 'completions'
      }
    ],
    models: [
      {
        id: provider.model,
        provider: 'icode',
        wireModel: provider.model
      }
    ]
  }
  return {
    args: ['--model', `icode/${provider.model}`],
    env: {},
    claudeEnv: {},
    delivery: {
      kind: 'file',
      pathEnv: 'COPILOT_PROVIDERS_CONFIG',
      relativePath: 'providers.json',
      contents: `${JSON.stringify(config, null, 2)}\n`,
      format: 'json'
    }
  }
}

function piSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  const config = {
    providers: {
      icode: {
        baseUrl: trimBaseUrl(provider.baseUrl),
        api: 'openai-completions',
        apiKey: provider.apiKey,
        models: [{ id: provider.model }]
      }
    }
  }
  return {
    args: ['--provider', 'icode', '--model', provider.model],
    env: {},
    claudeEnv: {},
    delivery: {
      kind: 'dir',
      pathEnv: 'PI_CODING_AGENT_DIR',
      files: [
        {
          relativePath: 'models.json',
          contents: `${JSON.stringify(config, null, 2)}\n`,
          mode: 0o600
        }
      ]
    }
  }
}

function ompSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  const contents =
    [
      'providers:',
      '  icode:',
      `    baseUrl: ${yamlString(trimBaseUrl(provider.baseUrl))}`,
      '    api: openai-completions',
      `    apiKey: ${yamlString(provider.apiKey)}`,
      '    models:',
      `      - id: ${yamlString(provider.model)}`
    ].join('\n') + '\n'
  return {
    args: ['--model', `icode/${provider.model}`],
    env: {},
    claudeEnv: {},
    delivery: {
      kind: 'dir',
      pathEnv: 'PI_CODING_AGENT_DIR',
      files: [{ relativePath: 'models.yml', contents, mode: 0o600 }]
    }
  }
}

function anteSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  const config = {
    providers: {
      icode: {
        base_url: trimBaseUrl(provider.baseUrl),
        wire_style: 'OpenAiCompatible',
        auth: { bearer: { env_key: PROVIDER_KEY_ENV } },
        preferred_models: [provider.model]
      }
    }
  }
  return {
    args: ['--provider', 'icode', '--model', provider.model],
    env: { [PROVIDER_KEY_ENV]: provider.apiKey },
    claudeEnv: {},
    delivery: {
      kind: 'dir',
      pathEnv: 'ANTE_HOME',
      files: [
        {
          relativePath: 'catalog.json',
          contents: `${JSON.stringify(config, null, 2)}\n`,
          mode: 0o600
        }
      ]
    }
  }
}

function vibeSpec(provider: ProviderLaunchInput): ProviderLaunchPlan {
  const contents =
    [
      `active_model = ${tomlString(provider.model)}`,
      '',
      '[[providers]]',
      'name = "icode"',
      `api_base = ${tomlString(trimBaseUrl(provider.baseUrl))}`,
      'api_style = "openai"',
      `api_key_env_var = "${PROVIDER_KEY_ENV}"`,
      'backend = "generic"',
      '',
      '[[models]]',
      `name = ${tomlString(provider.model)}`,
      'provider = "icode"',
      `alias = ${tomlString(provider.model)}`
    ].join('\n') + '\n'
  return {
    args: [],
    env: { [PROVIDER_KEY_ENV]: provider.apiKey },
    claudeEnv: {},
    delivery: {
      kind: 'dir',
      pathEnv: 'VIBE_HOME',
      files: [{ relativePath: 'config.toml', contents, mode: 0o600 }]
    }
  }
}

export const PROVIDER_RECIPES: Record<ProviderRecipeHarness, ProviderRecipe> = {
  claude: {
    harness: 'claude',
    protocol: 'anthropic',
    authStyles: PROVIDER_AUTH_STYLES,
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'existing',
    build: claudeSpec
  },
  codex: {
    harness: 'codex',
    protocol: 'openai-responses',
    authStyles: [],
    docsUrl: 'https://github.com/openai/codex',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'existing',
    build: codexSpec
  },
  opencode: {
    harness: 'opencode',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://opencode.ai/docs/',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'existing',
    build: opencodeSpec
  },
  openclaude: {
    harness: 'openclaude',
    protocol: 'anthropic',
    authStyles: PROVIDER_AUTH_STYLES,
    docsUrl: 'https://github.com/Gitlawb/openclaude',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: openClaudeSpec
  },
  codebuddy: {
    harness: 'codebuddy',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://www.codebuddy.ai/docs/cli/env-vars',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: codebuddySpec
  },
  kimi: {
    harness: 'kimi',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl:
      'https://www.kimi.com/code/docs/kimi-code-cli/configuration/env-vars.html',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: kimiSpec
  },
  zcode: {
    harness: 'zcode',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://github.com/zai-org/ZCode',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: zcodeSpec,
    seed: {
      homePaths: [['.zcode', 'v2', 'provider_config.json']]
    }
  },
  'qwen-code': {
    harness: 'qwen-code',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl:
      'https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/model-providers.md',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: qwenSpec
  },
  kilo: {
    harness: 'kilo',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://github.com/Kilo-Org/kilocode',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: kiloSpec
  },
  continue: {
    harness: 'continue',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://docs.continue.dev/cli/quickstart',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: continueSpec,
    seed: {
      env: 'CONTINUE_GLOBAL_DIR',
      envSegments: ['config.yaml'],
      homePaths: [['.continue', 'config.yaml']]
    }
  },
  pi: {
    harness: 'pi',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://docs.pi.dev/latest/configuration',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: piSpec,
    seed: {
      env: 'PI_CODING_AGENT_DIR',
      envSegments: ['models.json'],
      homePaths: [['.pi', 'agent', 'models.json']],
      target: 'models.json',
      copy: [
        {
          env: 'PI_CODING_AGENT_DIR',
          envSegments: ['auth.json'],
          homePaths: [['.pi', 'agent', 'auth.json']],
          target: 'auth.json'
        },
        {
          env: 'PI_CODING_AGENT_DIR',
          envSegments: ['settings.json'],
          homePaths: [['.pi', 'agent', 'settings.json']],
          target: 'settings.json'
        }
      ],
      link: [
        {
          env: 'PI_CODING_AGENT_DIR',
          envSegments: ['extensions'],
          homePaths: [['.pi', 'agent', 'extensions']],
          target: 'extensions'
        }
      ]
    }
  },
  omp: {
    harness: 'omp',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://github.com/can1357/oh-my-pi/blob/main/docs/models.md',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: ompSpec,
    seed: {
      env: 'PI_CODING_AGENT_DIR',
      envSegments: ['models.yml'],
      homePaths: [
        ['.pi', 'agent', 'models.yml'],
        ['.pi', 'agent', 'models.yaml'],
        ['.omp', 'agent', 'models.yml'],
        ['.omp', 'agent', 'models.yaml']
      ],
      target: 'models.yml',
      copy: [
        {
          env: 'PI_CODING_AGENT_DIR',
          envSegments: ['auth.json'],
          homePaths: [
            ['.pi', 'agent', 'auth.json'],
            ['.omp', 'agent', 'auth.json']
          ],
          target: 'auth.json'
        },
        {
          env: 'PI_CODING_AGENT_DIR',
          envSegments: ['settings.json'],
          homePaths: [
            ['.pi', 'agent', 'settings.json'],
            ['.omp', 'agent', 'settings.json']
          ],
          target: 'settings.json'
        }
      ],
      link: [
        {
          env: 'PI_CODING_AGENT_DIR',
          envSegments: ['extensions'],
          homePaths: [
            ['.pi', 'agent', 'extensions'],
            ['.omp', 'agent', 'extensions']
          ],
          target: 'extensions'
        }
      ]
    }
  },
  ante: {
    harness: 'ante',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://docs.antigma.ai/reference/catalog-reference/',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: anteSpec,
    seed: {
      env: 'ANTE_HOME',
      envSegments: ['catalog.json'],
      homePaths: [['.ante', 'catalog.json']],
      target: 'catalog.json'
    }
  },
  copilot: {
    harness: 'copilot',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl:
      'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: copilotSpec,
    seed: {
      env: 'COPILOT_PROVIDERS_CONFIG',
      homePaths: [['.copilot', 'providers.json']]
    }
  },
  gemini: {
    harness: 'gemini',
    protocol: 'google-genai',
    authStyles: [],
    docsUrl:
      'https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: geminiSpec
  },
  aider: {
    harness: 'aider',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://aider.chat/docs/llms/openai-compat.html',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: aiderSpec
  },
  goose: {
    harness: 'goose',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl:
      'https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/providers.md',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: gooseSpec
  },
  grok: {
    harness: 'grok',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://docs.x.ai/build/settings/reference',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: grokSpec
  },
  'mistral-vibe': {
    harness: 'mistral-vibe',
    protocol: 'openai-chat',
    authStyles: [],
    docsUrl: 'https://docs.mistral.ai/vibe/code/cli/configuration',
    verifiedAt: '2026-11-19',
    verifiedCliVersion: 'pending',
    build: vibeSpec,
    seed: {
      env: 'VIBE_HOME',
      envSegments: ['config.toml'],
      homePaths: [['.vibe', 'config.toml']],
      target: 'config.toml'
    }
  }
}

const PROVIDER_SET: ReadonlySet<string> = new Set(PROVIDER_HARNESSES)
const RECIPE_SET: ReadonlySet<string> = new Set(PROVIDER_RECIPE_HARNESSES)

/** True only for harnesses that have passed live verification and ship. */
export function isProviderHarness(value: string): value is ProviderHarness {
  return PROVIDER_SET.has(value)
}

/** True for every implemented recipe, verified or not. */
export function isProviderRecipeHarness(
  value: string
): value is ProviderRecipeHarness {
  return RECIPE_SET.has(value)
}

export function providerRecipe(harness: ProviderRecipeHarness): ProviderRecipe {
  return PROVIDER_RECIPES[harness]
}

export function providerLaunchPlan(input: ProviderLaunchInput): ProviderLaunchPlan {
  return PROVIDER_RECIPES[input.harness].build(input)
}

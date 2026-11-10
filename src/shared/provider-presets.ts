import type { ProviderAuthStyle, ProviderHarness } from './schemas/provider'

/**
 * Curated provider starting points.
 *
 * These are facts about public endpoints, not a catalog copied from another
 * project. Each entry is limited to the protocol its harness speaks: Claude
 * needs Anthropic Messages, Codex needs the Responses API, and OpenCode's
 * iCode translator uses OpenAI Chat Completions. Model IDs drift; every field
 * stays editable, and the form says so.
 *
 * No referral/tracking parameters and no vendor logos.
 */
export type ProviderPreset = {
  id: string
  harness: ProviderHarness
  name: string
  baseUrl: string
  model: string
  authStyle: ProviderAuthStyle | null
  docsUrl: string
  /** The date the endpoint/model pair was last checked. */
  verifiedAt: string
}

const VERIFIED_AT = '2026-11-10'

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // ── Claude Code: Anthropic Messages-compatible endpoints ──────────────────
  {
    id: 'claude-anthropic',
    harness: 'claude',
    name: 'Anthropic API',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5',
    authStyle: 'api_key',
    docsUrl: 'https://docs.anthropic.com',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'claude-deepseek',
    harness: 'claude',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash[1M]',
    authStyle: 'auth_token',
    docsUrl: 'https://platform.deepseek.com',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'claude-kimi-coding',
    harness: 'claude',
    name: 'Kimi For Coding',
    baseUrl: 'https://api.kimi.com/coding/',
    model: 'kimi-for-coding',
    authStyle: 'auth_token',
    docsUrl: 'https://www.kimi.com/code',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'claude-zhipu',
    harness: 'claude',
    name: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.3[1M]',
    authStyle: 'auth_token',
    docsUrl: 'https://open.bigmodel.cn',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'claude-zai',
    harness: 'claude',
    name: 'Z.ai GLM',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.3[1M]',
    authStyle: 'auth_token',
    docsUrl: 'https://z.ai',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'claude-opencode-zen',
    harness: 'claude',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen',
    model: 'claude-sonnet-5-5',
    authStyle: 'api_key',
    docsUrl: 'https://opencode.ai/zen',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'claude-packycode',
    harness: 'claude',
    name: 'PackyCode',
    baseUrl: 'https://www.packyapi.ai',
    model: 'claude-sonnet-5',
    authStyle: 'auth_token',
    docsUrl: 'https://www.packyapi.ai',
    verifiedAt: VERIFIED_AT
  },

  // ── Codex: Responses API-compatible endpoints ─────────────────────────────
  {
    id: 'codex-openai',
    harness: 'codex',
    name: 'OpenAI API',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.1-codex',
    authStyle: null,
    docsUrl: 'https://platform.openai.com/docs',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'codex-kimi',
    harness: 'codex',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    authStyle: null,
    docsUrl: 'https://platform.moonshot.cn',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'codex-kimi-coding',
    harness: 'codex',
    name: 'Kimi For Coding',
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'kimi-for-coding',
    authStyle: null,
    docsUrl: 'https://www.kimi.com/code',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'codex-packycode',
    harness: 'codex',
    name: 'PackyCode',
    baseUrl: 'https://www.packyapi.ai/v1',
    model: 'gpt-5.1-codex',
    authStyle: null,
    docsUrl: 'https://www.packyapi.ai',
    verifiedAt: VERIFIED_AT
  },

  // ── OpenCode: OpenAI Chat Completions-compatible endpoints ────────────────
  {
    id: 'opencode-openai',
    harness: 'opencode',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.1',
    authStyle: null,
    docsUrl: 'https://platform.openai.com/docs',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'opencode-deepseek',
    harness: 'opencode',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    authStyle: null,
    docsUrl: 'https://platform.deepseek.com',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'opencode-kimi',
    harness: 'opencode',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    authStyle: null,
    docsUrl: 'https://platform.moonshot.cn',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'opencode-zhipu',
    harness: 'opencode',
    name: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5',
    authStyle: null,
    docsUrl: 'https://open.bigmodel.cn',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'opencode-qwen',
    harness: 'opencode',
    name: 'Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-coder-plus',
    authStyle: null,
    docsUrl: 'https://bailian.console.aliyun.com',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'opencode-openrouter',
    harness: 'opencode',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.5',
    authStyle: null,
    docsUrl: 'https://openrouter.ai/docs',
    verifiedAt: VERIFIED_AT
  },
  {
    id: 'opencode-local',
    harness: 'opencode',
    name: 'Local (Ollama)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3-coder',
    authStyle: null,
    docsUrl: 'https://ollama.com',
    verifiedAt: VERIFIED_AT
  }
]

export function presetsFor(harness: ProviderHarness): readonly ProviderPreset[] {
  return PROVIDER_PRESETS.filter((preset) => preset.harness === harness)
}

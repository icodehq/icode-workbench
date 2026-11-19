/**
 * The managed status-hook provider registry.
 *
 * This is the single source of truth for which agent harnesses have an iCode
 * hook installer, which config shape each one uses, and where its default
 * config lives. It is pure data so the renderer can consume the provider
 * state union without pulling in Node APIs.
 */

import type { HarnessId } from './harness-catalog'

export const MANAGED_HOOK_FORMATS = [
  'json',
  'jsonc',
  'zcode',
  'antigravity',
  'muse',
  'kiro',
  'jcode-toml',
  'dsh',
  'hermes',
  'kimi-toml',
  'amp-plugin'
] as const
export type ManagedHookFormat = (typeof MANAGED_HOOK_FORMATS)[number]

export const MANAGED_HOOK_PROVIDER_STATES = [
  'installed',
  'partial',
  'not-installed',
  'cli-not-found',
  'disabled',
  'failed'
] as const
export type ManagedHookProviderState = (typeof MANAGED_HOOK_PROVIDER_STATES)[number]

/** Harnesses with a managed status-hook installer, in UI/install order. */
export const MANAGED_HOOK_PROVIDER_IDS = [
  'gemini',
  'qwen-code',
  'cursor',
  'copilot',
  'grok',
  'kimi',
  'amp',
  'droid',
  'openclaude',
  'qoder',
  'qoder-cn',
  'codebuddy',
  'antigravity',
  'command-code',
  'devin',
  'muse',
  'zcode',
  'kiro',
  'dsh',
  'jcode',
  'hermes'
] as const satisfies readonly HarnessId[]

export type ManagedHookProvider = (typeof MANAGED_HOOK_PROVIDER_IDS)[number]

export type ManagedHookProviderMetadata = {
  format: ManagedHookFormat
  /** Default config path segments under `$HOME`, shared by local and guest. */
  homePath: readonly string[]
  /**
   * Managed-hook availability usually follows harness detection. Set this only
   * when the hook installer deliberately uses a narrower command set.
   */
  detectCommands?: readonly string[]
}

export const MANAGED_HOOK_PROVIDER_METADATA: Record<
  ManagedHookProvider,
  ManagedHookProviderMetadata
> = {
  gemini: { format: 'json', homePath: ['.gemini', 'settings.json'] },
  'qwen-code': { format: 'json', homePath: ['.qwen', 'settings.json'] },
  cursor: { format: 'json', homePath: ['.cursor', 'hooks.json'] },
  copilot: { format: 'json', homePath: ['.copilot', 'hooks', 'icode.json'] },
  grok: { format: 'json', homePath: ['.grok', 'hooks', 'icode-status.json'] },
  kimi: { format: 'kimi-toml', homePath: ['.kimi-code', 'config.toml'] },
  amp: {
    format: 'amp-plugin',
    homePath: ['.config', 'amp', 'plugins', 'icode-agent-status.ts']
  },
  droid: { format: 'json', homePath: ['.factory', 'settings.json'] },
  openclaude: { format: 'json', homePath: ['.openclaude', 'settings.json'] },
  qoder: { format: 'json', homePath: ['.qoder', 'settings.json'] },
  'qoder-cn': { format: 'json', homePath: ['.qoder-cn', 'settings.json'] },
  codebuddy: { format: 'json', homePath: ['.codebuddy', 'settings.json'] },
  antigravity: {
    format: 'antigravity',
    homePath: ['.gemini', 'config', 'hooks.json']
  },
  'command-code': { format: 'json', homePath: ['.commandcode', 'settings.json'] },
  devin: { format: 'jsonc', homePath: ['.config', 'devin', 'config.json'] },
  muse: { format: 'muse', homePath: ['.config', 'muse', 'settings.json'] },
  zcode: { format: 'zcode', homePath: ['.zcode', 'cli', 'config.json'] },
  kiro: { format: 'kiro', homePath: ['.kiro', 'hooks', 'icode-agent-status.json'] },
  dsh: {
    format: 'dsh',
    homePath: ['.dsh', 'cordis.patch.yml'],
    detectCommands: ['dsh-tui']
  },
  jcode: { format: 'jcode-toml', homePath: ['.jcode', 'config.toml'] },
  hermes: { format: 'hermes', homePath: ['.hermes', 'config.yaml'] }
}

const PROVIDER_SET: ReadonlySet<string> = new Set(MANAGED_HOOK_PROVIDER_IDS)

export function isManagedHookProvider(value: string): value is ManagedHookProvider {
  return PROVIDER_SET.has(value)
}

export function managedHookHomePath(provider: ManagedHookProvider): readonly string[] {
  return MANAGED_HOOK_PROVIDER_METADATA[provider].homePath
}

/** Guest default path; guest installs never read host env overrides. */
export function managedHookGuestConfigPath(
  provider: ManagedHookProvider,
  guestHome: string
): string {
  return `${guestHome.replace(/\/+$/u, '')}/${managedHookHomePath(provider).join('/')}`
}

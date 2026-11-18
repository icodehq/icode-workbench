/**
 * Managed status hooks for provider CLIs with Claude-shaped JSON configs.
 *
 * Each provider has its own config shape but the same job: run a small Node
 * script with a canonical event name, normalize the provider payload, and post
 * it to iCode's existing activity ingress. Only iCode-owned hook entries are
 * added or removed; user hooks and every other config key are preserved.
 *
 * Formats that are not nested JSON live in sibling installers (Kimi TOML, Amp
 * plugin, Antigravity bundle, Muse hooks file, Kiro list hooks, JCode TOML,
 * DSH patch layer and Hermes Python plugin). This module remains local-target
 * only; each sibling owns its guest implementation.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ActivityEventName } from '../../shared/domain/activity'
import type { HarnessId } from '../../shared/domain/harness'

export const MANAGED_HOOK_PROVIDERS = [
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
] as const
export type ManagedHookProvider = (typeof MANAGED_HOOK_PROVIDERS)[number]

/**
 * `ask` preserves Antigravity's permission policy on PreToolUse; `stop` is the
 * empty-decision reply its Stop hook expects. `none` emits nothing at all,
 * which providers that inject stdout into model context (Kiro, DSH) require.
 */
export type ManagedHookResponse = 'json' | 'none' | 'continue' | 'ask' | 'stop'

export type ManagedHookEvent = {
  /** Event name the provider uses in its own config. */
  providerEvent: string
  /** Event name iCode's activity model understands. */
  canonicalEvent: ActivityEventName
  /** What the hook must print on stdout for this provider. */
  response: ManagedHookResponse
  /** Provider-side matcher required for tool events. */
  matcher?: string
}

export type ManagedHookProviderSpec = {
  label: string
  harness: HarnessId
  /** JSON shape, or a dedicated file format handled by a sibling installer. */
  format?:
    | 'json'
    | 'jsonc'
    | 'antigravity'
    | 'muse'
    | 'zcode'
    | 'kiro'
    | 'kimi-toml'
    | 'jcode-toml'
    | 'amp-plugin'
    | 'dsh'
    | 'hermes'
  kind: 'nested' | 'cursor' | 'copilot'
  /** Config path relative to the user home (or an env override). */
  configPath: (home: string, env: NodeJS.ProcessEnv) => string
  timeoutSeconds: number
  timeoutMilliseconds: number
  /** JSON providers only: a top-level flag that disables hooks. */
  disabledFlag?: 'disableAllHooks' | 'hooksDisabled'
  events: readonly ManagedHookEvent[]
}

export const MANAGED_HOOK_PROVIDER_SPECS: Record<
  ManagedHookProvider,
  ManagedHookProviderSpec
> = {
  gemini: {
    label: 'Gemini',
    harness: 'gemini',
    kind: 'nested',
    configPath: (home) => join(home, '.gemini', 'settings.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      { providerEvent: 'BeforeAgent', canonicalEvent: 'UserPromptSubmit', response: 'json' },
      { providerEvent: 'BeforeTool', canonicalEvent: 'PreToolUse', response: 'json' },
      { providerEvent: 'AfterTool', canonicalEvent: 'PostToolUse', response: 'json' },
      { providerEvent: 'AfterAgent', canonicalEvent: 'Stop', response: 'json' }
    ]
  },
  'qwen-code': {
    label: 'Qwen Code',
    harness: 'qwen-code',
    kind: 'nested',
    configPath: (home) => join(home, '.qwen', 'settings.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'none' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'none' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'none' },
      {
        providerEvent: 'PostToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'none'
      },
      {
        providerEvent: 'PermissionRequest',
        canonicalEvent: 'PermissionRequest',
        response: 'none'
      },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'StopFailure', canonicalEvent: 'StopFailure', response: 'none' }
    ]
  },
  cursor: {
    label: 'Cursor',
    harness: 'cursor',
    kind: 'cursor',
    configPath: (home) => join(home, '.cursor', 'hooks.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      {
        providerEvent: 'beforeSubmitPrompt',
        canonicalEvent: 'UserPromptSubmit',
        response: 'continue'
      },
      { providerEvent: 'postToolUse', canonicalEvent: 'PostToolUse', response: 'json' },
      {
        providerEvent: 'postToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'json'
      },
      { providerEvent: 'stop', canonicalEvent: 'Stop', response: 'json' }
    ]
  },
  copilot: {
    label: 'GitHub Copilot',
    harness: 'copilot',
    kind: 'copilot',
    configPath: (home, env) => {
      const configured = env.COPILOT_HOME?.trim()
      return join(configured && configured.length > 0 ? configured : join(home, '.copilot'), 'hooks', 'icode.json')
    },
    timeoutSeconds: 5,
    timeoutMilliseconds: 5_000,
    disabledFlag: 'disableAllHooks',
    events: [
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'json' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'json' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'json' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'json' },
      {
        providerEvent: 'PostToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'json'
      },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'json' }
    ]
  },
  grok: {
    label: 'Grok',
    harness: 'grok',
    kind: 'nested',
    configPath: (home, env) => {
      const configured = env.GROK_HOME?.trim()
      const root = configured && configured.length > 0 ? configured : join(home, '.grok')
      return join(root, 'hooks', 'icode-status.json')
    },
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'json' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'json' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'json', matcher: '.*' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'json', matcher: '.*' },
      {
        providerEvent: 'PostToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'json',
        matcher: '.*'
      },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'json' },
      { providerEvent: 'StopCancelled', canonicalEvent: 'StopFailure', response: 'json' },
      { providerEvent: 'StopFailure', canonicalEvent: 'StopFailure', response: 'json' },
      { providerEvent: 'SessionEnd', canonicalEvent: 'Stop', response: 'json' }
    ]
  },
  kimi: {
    label: 'Kimi',
    harness: 'kimi',
    format: 'kimi-toml',
    kind: 'nested',
    configPath: (home, env) => {
      const configured = env.KIMI_CODE_HOME?.trim()
      const root = configured && configured.length > 0 ? configured : join(home, '.kimi-code')
      return join(root, 'config.toml')
    },
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'none' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'none' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'none' },
      {
        providerEvent: 'PostToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'none'
      },
      {
        providerEvent: 'PermissionRequest',
        canonicalEvent: 'PermissionRequest',
        response: 'none'
      },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'StopFailure', canonicalEvent: 'StopFailure', response: 'none' },
      { providerEvent: 'Interrupt', canonicalEvent: 'StopFailure', response: 'none' }
    ]
  },
  amp: {
    label: 'Amp',
    harness: 'amp',
    format: 'amp-plugin',
    kind: 'nested',
    configPath: (home) => join(home, '.config', 'amp', 'plugins', 'icode-agent-status.ts'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      { providerEvent: 'agent.start', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'agent.end', canonicalEvent: 'Stop', response: 'none' }
    ]
  },
  droid: {
    label: 'Droid',
    harness: 'droid',
    kind: 'nested',
    configPath: (home) => join(home, '.factory', 'settings.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    disabledFlag: 'hooksDisabled',
    events: [
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'json' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'json' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'json', matcher: '*' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'json', matcher: '*' },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'json' }
    ]
  },
  openclaude: {
    label: 'OpenClaude',
    harness: 'openclaude',
    kind: 'nested',
    configPath: (home) => join(home, '.openclaude', 'settings.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'none' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'none', matcher: '*' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'none', matcher: '*' },
      {
        providerEvent: 'PostToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'none',
        matcher: '*'
      },
      {
        providerEvent: 'PermissionRequest',
        canonicalEvent: 'PermissionRequest',
        response: 'none',
        matcher: '*'
      },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'StopFailure', canonicalEvent: 'StopFailure', response: 'none' }
    ]
  },
  qoder: {
    label: 'Qoder CLI',
    harness: 'qoder',
    kind: 'nested',
    configPath: (home) => join(home, '.qoder', 'settings.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'none' },
      { providerEvent: 'SessionEnd', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'none', matcher: '*' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'none', matcher: '*' },
      {
        providerEvent: 'PostToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'none',
        matcher: '*'
      },
      {
        providerEvent: 'PermissionRequest',
        canonicalEvent: 'PermissionRequest',
        response: 'none',
        matcher: '*'
      },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'StopFailure', canonicalEvent: 'StopFailure', response: 'none' }
    ]
  },
  'qoder-cn': {
    label: 'Qoder CLI China',
    harness: 'qoder-cn',
    kind: 'nested',
    configPath: (home) => join(home, '.qoder-cn', 'settings.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'none' },
      { providerEvent: 'SessionEnd', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'none', matcher: '*' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'none', matcher: '*' },
      {
        providerEvent: 'PostToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'none',
        matcher: '*'
      },
      {
        providerEvent: 'PermissionRequest',
        canonicalEvent: 'PermissionRequest',
        response: 'none',
        matcher: '*'
      },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'StopFailure', canonicalEvent: 'StopFailure', response: 'none' }
    ]
  },
  codebuddy: {
    label: 'CodeBuddy',
    harness: 'codebuddy',
    kind: 'nested',
    configPath: (home) => join(home, '.codebuddy', 'settings.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      // CodeBuddy emits SessionStart after UserPromptSubmit and PermissionRequest
      // before auto-review, so neither is safe to map as idle/waiting.
      { providerEvent: 'SessionEnd', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'none', matcher: '*' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'none', matcher: '*' },
      {
        providerEvent: 'PostToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'none',
        matcher: '*'
      },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'StopFailure', canonicalEvent: 'StopFailure', response: 'none' }
    ]
  },
  antigravity: {
    label: 'Antigravity',
    harness: 'antigravity',
    format: 'antigravity',
    kind: 'nested',
    configPath: (home) => join(home, '.gemini', 'config', 'hooks.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      // PreInvocation opens a turn; PostInvocation reports the model turn,
      // which iCode treats as continued work. Stop with fullyIdle=false is
      // held as working by the hook script while child helpers run.
      { providerEvent: 'PreInvocation', canonicalEvent: 'UserPromptSubmit', response: 'json' },
      {
        providerEvent: 'PreToolUse',
        canonicalEvent: 'PreToolUse',
        response: 'ask',
        matcher: '*'
      },
      {
        providerEvent: 'PostToolUse',
        canonicalEvent: 'PostToolUse',
        response: 'json',
        matcher: '*'
      },
      { providerEvent: 'PostInvocation', canonicalEvent: 'PostToolUse', response: 'json' },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'stop' }
    ]
  },
  'command-code': {
    label: 'Command Code',
    harness: 'command-code',
    kind: 'nested',
    configPath: (home) => join(home, '.commandcode', 'settings.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      // Command Code has no permission or notification hooks; approval pauses
      // stay working. The script recovers scrubbed identity from its ancestors.
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'none', matcher: '.*' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'none', matcher: '.*' },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'none' }
    ]
  },
  devin: {
    label: 'Devin',
    harness: 'devin',
    format: 'jsonc',
    kind: 'nested',
    configPath: (home, env) => {
      const appData = env.APPDATA?.trim()
      return appData && appData.length > 0
        ? join(appData, 'devin', 'config.json')
        : join(home, '.config', 'devin', 'config.json')
    },
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      // SessionStart fires on idle TUI open/resume; it must not assert working.
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'json' },
      // Devin expects regex matchers, so Claude's "*" is not valid; omit them.
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'json' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'json' },
      { providerEvent: 'PostCompaction', canonicalEvent: 'PostToolUse', response: 'json' },
      { providerEvent: 'PermissionRequest', canonicalEvent: 'PermissionRequest', response: 'json' },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'json' },
      { providerEvent: 'SessionEnd', canonicalEvent: 'Stop', response: 'json' }
    ]
  },
  muse: {
    label: 'Muse',
    harness: 'muse',
    format: 'muse',
    kind: 'nested',
    configPath: (home, env) => {
      const xdg = env.XDG_CONFIG_HOME?.trim()
      const root = xdg && xdg.length > 0 ? join(xdg, 'muse') : join(home, '.config', 'muse')
      return join(root, 'settings.json')
    },
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'json' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'json' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'json' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'json' },
      {
        providerEvent: 'PostToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'json'
      },
      { providerEvent: 'PermissionRequest', canonicalEvent: 'PermissionRequest', response: 'json' },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'json' },
      { providerEvent: 'StopFailure', canonicalEvent: 'StopFailure', response: 'json' },
      { providerEvent: 'Interrupt', canonicalEvent: 'StopFailure', response: 'json' },
      { providerEvent: 'SessionEnd', canonicalEvent: 'Stop', response: 'json' }
    ]
  },
  zcode: {
    label: 'ZCode',
    harness: 'zcode',
    format: 'zcode',
    kind: 'nested',
    configPath: (home) => join(home, '.zcode', 'cli', 'config.json'),
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      // Only idle SessionStart sources settle; ZCode's parser drops compact.
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'json' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'json' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'json' },
      { providerEvent: 'PermissionRequest', canonicalEvent: 'PermissionRequest', response: 'json' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'json' },
      {
        providerEvent: 'PostToolUseFailure',
        canonicalEvent: 'PostToolUseFailure',
        response: 'json'
      },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'json' }
    ]
  },
  kiro: {
    label: 'Kiro',
    harness: 'kiro',
    format: 'kiro',
    kind: 'nested',
    configPath: (home, env) => {
      const configured = env.KIRO_HOME?.trim()
      const root = configured && configured.length > 0 ? configured : join(home, '.kiro')
      return join(root, 'hooks', 'icode-agent-status.json')
    },
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      // Kiro injects hook stdout into model context, so every response is silent.
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'none' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'none', matcher: '*' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'none', matcher: '*' },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'SessionEnd', canonicalEvent: 'Stop', response: 'none' }
    ]
  },
  dsh: {
    label: 'DeepSeek Harness',
    harness: 'dsh',
    format: 'dsh',
    kind: 'nested',
    configPath: (home, env) => {
      const configured = env.DSH_HOME?.trim()
      const root = configured && configured.length > 0 ? configured : join(home, '.dsh')
      return join(root, 'cordis.patch.yml')
    },
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      // The Claude-shaped DSH bridge lacks Notification/PermissionRequest;
      // AskUserQuestion blocks between Pre/PostToolUse.
      { providerEvent: 'SessionStart', canonicalEvent: 'SessionStart', response: 'none' },
      { providerEvent: 'UserPromptSubmit', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'PreToolUse', canonicalEvent: 'PreToolUse', response: 'none' },
      { providerEvent: 'PostToolUse', canonicalEvent: 'PostToolUse', response: 'none' },
      { providerEvent: 'Stop', canonicalEvent: 'Stop', response: 'none' }
    ]
  },
  jcode: {
    label: 'Jcode',
    harness: 'jcode',
    format: 'jcode-toml',
    kind: 'nested',
    configPath: (home, env) => {
      const configured = env.JCODE_HOME?.trim()
      const root = configured && configured.length > 0 ? configured : join(home, '.jcode')
      return join(root, 'config.toml')
    },
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      // session_start on idle open/attach/resume must not assert working.
      { providerEvent: 'turn_start', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'pre_tool', canonicalEvent: 'PreToolUse', response: 'none' },
      { providerEvent: 'post_tool', canonicalEvent: 'PostToolUse', response: 'none' },
      { providerEvent: 'turn_end', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'session_end', canonicalEvent: 'Stop', response: 'none' }
    ]
  },
  hermes: {
    label: 'Hermes',
    harness: 'hermes',
    format: 'hermes',
    kind: 'nested',
    configPath: (home, env) => {
      const configured = env.HERMES_HOME?.trim()
      let root: string
      if (configured && configured.length > 0) {
        root = configured
      } else if (env.LOCALAPPDATA?.trim()) {
        const localAppDataHome = join(env.LOCALAPPDATA.trim(), 'hermes')
        const dotfolderHome = join(home, '.hermes')
        // Hermes Desktop honours an existing dotfolder when the
        // LOCALAPPDATA tree has not been created.
        root =
          !existsSync(localAppDataHome) && existsSync(dotfolderHome)
            ? dotfolderHome
            : localAppDataHome
      } else {
        root = join(home, '.hermes')
      }
      return join(root, 'config.yaml')
    },
    timeoutSeconds: 10,
    timeoutMilliseconds: 10_000,
    events: [
      { providerEvent: 'on_session_start', canonicalEvent: 'SessionStart', response: 'none' },
      { providerEvent: 'on_session_reset', canonicalEvent: 'SessionStart', response: 'none' },
      { providerEvent: 'pre_llm_call', canonicalEvent: 'UserPromptSubmit', response: 'none' },
      { providerEvent: 'pre_tool_call', canonicalEvent: 'PreToolUse', response: 'none' },
      { providerEvent: 'post_tool_call', canonicalEvent: 'PostToolUse', response: 'none' },
      {
        providerEvent: 'pre_approval_request',
        canonicalEvent: 'PermissionRequest',
        response: 'none'
      },
      {
        providerEvent: 'post_approval_response',
        canonicalEvent: 'PostToolUse',
        response: 'none'
      },
      { providerEvent: 'post_llm_call', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'on_session_end', canonicalEvent: 'Stop', response: 'none' },
      { providerEvent: 'on_session_finalize', canonicalEvent: 'Stop', response: 'none' }
    ]
  }
}

/** A provider-level disable flag (Copilot `disableAllHooks`, Droid `hooksDisabled`). */
export function isManagedHookProviderDisabled(
  provider: ManagedHookProvider,
  value: Record<string, unknown>
): boolean {
  const flag = MANAGED_HOOK_PROVIDER_SPECS[provider].disabledFlag
  return flag !== undefined && value[flag] === true
}

export type ManagedHookProviderStatusState =
  | 'installed'
  | 'partial'
  | 'not-installed'
  | 'cli-not-found'
  | 'disabled'
  | 'failed'

export type ManagedHookProviderStatus = {
  provider: ManagedHookProvider
  label: string
  state: ManagedHookProviderStatusState
  configPath: string
  detail: string | null
}

export type ManagedHookInstallOptions = {
  /** iCode-owned directory; the script and Windows wrapper live here. */
  directory: string
  /** User home whose provider config is managed. */
  home: string
  execPath: string
  electronRunAsNode: boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

export type ManagedHookRuntime = {
  scriptPath: string
  wrapperPath: string | null
  commandFor: (provider: ManagedHookProvider, event: ManagedHookEvent) => string
  /** PowerShell spelling for providers that execute their hook through it. */
  powershellCommandFor: (provider: ManagedHookProvider, event: ManagedHookEvent) => string
}

export const MANAGED_HOOK_SCRIPT_NAME = 'icode-managed-hook.cjs'
export const MANAGED_HOOK_WRAPPER_NAME = 'icode-managed-hook.cmd'
const MANAGED_COMMAND_MARKER = 'icode-managed-hook'
const LEGACY_MANAGED_COMMAND_MARKER = 'icode-activity-hook'
const CONFIG_BACKUP_SUFFIX = '.icode.bak'
const MAX_CONFIG_BYTES = 4 * 1024 * 1024

/**
 * The hook process. It always answers the provider first, then attempts the
 * iCode ingress. A missing socket, malformed payload, or stopped iCode must
 * never block the agent turn.
 */
const MANAGED_HOOK_SCRIPT = `#!/usr/bin/env node
'use strict'
const net = require('node:net')
const fs = require('node:fs')
const MAX_BYTES = 8 * 1024
const DEADLINE_MS = 100
const provider = process.argv[2] || ''
const providerEvent = process.argv[3] || ''
const canonicalEvent = process.argv[4] || ''
const response = process.argv[5] || 'json'
let socketPath = process.env.ICODE_ACTIVITY_SOCKET || ''
let sessionId = process.env.ICODE_SESSION_ID || ''
let incarnationId = process.env.ICODE_SESSION_INCARNATION || ''
// Command Code and DSH scrub nonstandard hook env. The provider process is an
// ancestor, so recover the per-pane identity from Linux /proc before giving up.
function recoverEnv(name, current) {
  if (current) return current
  if (process.platform !== 'linux') return current
  let pid = process.ppid
  for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
    try {
      const entries = fs.readFileSync('/proc/' + pid + '/environ')
      const prefix = name + '='
      for (const entry of entries.toString('utf8').split('\0')) {
        if (entry.startsWith(prefix)) return entry.slice(prefix.length)
      }
      const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8')
      const match = /^PPid:\s*(\d+)$/m.exec(status)
      if (!match) break
      pid = Number(match[1])
    } catch {
      break
    }
  }
  return current
}
if (!socketPath || !sessionId || !incarnationId) {
  socketPath = recoverEnv('ICODE_ACTIVITY_SOCKET', socketPath)
  sessionId = recoverEnv('ICODE_SESSION_ID', sessionId)
  incarnationId = recoverEnv('ICODE_SESSION_INCARNATION', incarnationId)
}
function responseText(code) {
  if (code === 'none') return ''
  if (code === 'continue') return '{"continue":true}'
  if (code === 'ask') return '{"decision":"ask"}'
  if (code === 'stop') return '{"decision":""}'
  return '{}'
}
const output = responseText(response)
if (output.length > 0) {
  // Providers consume this response synchronously; process.exit can truncate
  // an asynchronous stdout write, so use the synchronous fd write.
  try { fs.writeSync(1, output + '\\n') } catch {}
}
function done() { process.exit(0) }
if (!providerEvent || !canonicalEvent || !socketPath || !sessionId || !incarnationId) done()
const timer = setTimeout(done, DEADLINE_MS)
timer.unref()
const chunks = []
let size = 0
let finished = false
function firstString(value, keys) {
  if (!value || typeof value !== 'object') return null
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 512) {
      return candidate
    }
  }
  return null
}
function finish(payload) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  if (!payload) done()
  let socket
  try {
    socket = net.createConnection(socketPath)
  } catch {
    done()
  }
  const guard = setTimeout(done, 1000)
  guard.unref()
  socket.on('error', function () { clearTimeout(guard); done() })
  socket.on('connect', function () {
    try {
      socket.end(JSON.stringify(payload))
    } catch {
      clearTimeout(guard)
      done()
    }
  })
  socket.on('close', function () { clearTimeout(guard); done() })
}
function postInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {}
  // ZCode emits SessionStart for compact too; only idle sources settle.
  if (
    provider === 'zcode' &&
    canonicalEvent === 'SessionStart' &&
    typeof input.source === 'string' &&
    input.source !== 'startup' &&
    input.source !== 'resume' &&
    input.source !== 'clear'
  ) {
    done()
    return
  }
  // Kiro V3 fires SessionStart lazily just before the first prompt.
  if (provider === 'kiro' && canonicalEvent === 'SessionStart') {
    done()
    return
  }
  const providerSessionId =
    firstString(input, [
      'session_id',
      'sessionId',
      'conversation_id',
      'conversationId',
      'thread_id',
      'threadId'
    ]) || (provider === 'jcode' ? firstString(process.env, ['JCODE_HOOK_SESSION_ID']) : null)
  const promptId = firstString(input, [
    'prompt_id',
    'promptId',
    'turn_id',
    'turnId',
    'message_id',
    'messageId',
    'request_id',
    'requestId',
    'id'
  ])
  let toolName = firstString(input, ['tool_name', 'toolName'])
  if (toolName === null && input.tool && typeof input.tool === 'object') {
    toolName = firstString(input.tool, ['name', 'toolName', 'tool_name'])
  }
  // Gemini and Copilot payloads sometimes use a top-level tool name.
  if (toolName === null && (provider === 'gemini' || provider === 'copilot')) {
    toolName = firstString(input, ['name'])
  }
  // Cursor reports interrupted turns on stop. Devin and ZCode use Claude's
  // is_interrupt flag; JCode reports turn errors with status "error".
  let event = canonicalEvent
  if (
    provider === 'cursor' &&
    providerEvent === 'stop' &&
    typeof input.status === 'string' &&
    input.status !== 'completed'
  ) {
    event = 'StopFailure'
  } else if (
    canonicalEvent === 'Stop' &&
    (input.is_interrupt === true || input.status === 'error')
  ) {
    event = 'StopFailure'
  } else if (
    provider === 'antigravity' &&
    canonicalEvent === 'Stop' &&
    (input.fullyIdle === false || input.fully_idle === false)
  ) {
    // Antigravity ends the parent turn with fullyIdle=false while helpers run.
    event = 'PostToolUse'
  }
  finish({
    event: event,
    sessionId: sessionId,
    incarnationId: incarnationId,
    claudeSessionId: providerSessionId,
    promptId: promptId,
    toolName: toolName,
    sentAt: Date.now()
  })
}
if (provider === 'jcode' && process.env.JCODE_HOOK_PAYLOAD !== undefined) {
  // JCode supplies the payload in the environment and can write more gated
  // input than the pipe buffer; drain without waiting, then post.
  try {
    process.stdin.on('data', function () {})
    process.stdin.resume()
  } catch {}
  let input = {}
  try {
    input = JSON.parse(process.env.JCODE_HOOK_PAYLOAD || '{}')
  } catch {
    input = {}
  }
  postInput(input)
} else {
  process.stdin.on('data', function (chunk) {
    if (finished) return
    size += chunk.length
    if (size > MAX_BYTES) { finished = true; clearTimeout(timer); done() }
    chunks.push(chunk)
  })
  process.stdin.on('error', function () { finish(null) })
  process.stdin.on('end', function () {
    let input = {}
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      input = {}
    }
    postInput(input)
  })
}
`

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isManagedHookCommand(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.includes(MANAGED_COMMAND_MARKER) || value.includes(LEGACY_MANAGED_COMMAND_MARKER))
  )
}

export function commandValues(definition: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const key of ['command', 'bash', 'powershell']) {
    const value = definition[key]
    if (typeof value === 'string') values.push(value)
  }
  if (Array.isArray(definition.hooks)) {
    for (const hook of definition.hooks) {
      if (isRecord(hook) && typeof hook.command === 'string') values.push(hook.command)
    }
  }
  return values
}

export function definitionHasManagedCommand(definition: unknown): boolean {
  return isRecord(definition) && commandValues(definition).some(isManagedHookCommand)
}

/**
 * Removes only managed commands from one definition. A definition that still
 * has user commands (or user nested hooks) survives; an empty shell is dropped.
 */
function cleanDefinition(definition: unknown): {
  value: unknown | null
  changed: boolean
} {
  // Non-object entries are opaque user data. Preserve them rather than
  // treating an unfamiliar shape as removable.
  if (!isRecord(definition)) return { value: definition, changed: false }
  const next: Record<string, unknown> = { ...definition }
  let changed = false
  for (const key of ['command', 'bash', 'powershell']) {
    if (isManagedHookCommand(next[key])) {
      delete next[key]
      changed = true
    }
  }
  if (Array.isArray(next.hooks)) {
    const hooks = next.hooks.filter(
      (hook) => !(isRecord(hook) && typeof hook.command === 'string' && isManagedHookCommand(hook.command))
    )
    if (hooks.length !== next.hooks.length) changed = true
    if (hooks.length === 0) delete next.hooks
    else next.hooks = hooks
  }
  if (!changed) return { value: definition, changed: false }
  const hasCommand = ['command', 'bash', 'powershell'].some(
    (key) => typeof next[key] === 'string' && (next[key] as string).length > 0
  )
  const hasHooks = Array.isArray(next.hooks) && next.hooks.length > 0
  if (!hasCommand && !hasHooks) return { value: null, changed: true }
  return { value: next, changed }
}

function cleanEventDefinitions(definitions: unknown): {
  value: unknown[]
  changed: boolean
} {
  if (!Array.isArray(definitions)) return { value: [], changed: false }
  const value: unknown[] = []
  let changed = false
  for (const definition of definitions) {
    const cleaned = cleanDefinition(definition)
    changed = changed || cleaned.changed
    if (cleaned.value !== null) value.push(cleaned.value)
  }
  return { value, changed }
}

/**
 * Removes managed entries from every event, including events iCode no longer
 * installs. This is what makes upgrades converge instead of accumulating stale
 * commands after an event list changes.
 */
export function cleanAllHookEvents(hooks: Record<string, unknown>): {
  value: Record<string, unknown>
  changed: boolean
} {
  const next: Record<string, unknown> = {}
  let changed = false
  for (const [event, definitions] of Object.entries(hooks)) {
    const cleaned = cleanEventDefinitions(definitions)
    changed = changed || cleaned.changed
    if (cleaned.value.length > 0) next[event] = cleaned.value
    else if (Array.isArray(definitions)) changed = true
    else next[event] = definitions
  }
  return { value: next, changed }
}

export type ConfigRead =
  | { state: 'ok'; value: Record<string, unknown>; raw: string; path: string }
  | { state: 'missing'; path: string }
  | { state: 'invalid'; path: string; detail: string }

/** Parses config text shared by the local and guest installers. */
export function parseManagedHookConfig(path: string, text: string | null): ConfigRead {
  if (text === null) return { state: 'missing', path }
  if (text.length > MAX_CONFIG_BYTES) {
    return { state: 'invalid', path, detail: 'The config file is too large.' }
  }
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (withoutBom.trim().length === 0) return { state: 'ok', value: {}, raw: text, path }
  try {
    const parsed: unknown = JSON.parse(withoutBom)
    if (!isRecord(parsed)) {
      return { state: 'invalid', path, detail: 'The config root is not a JSON object.' }
    }
    return { state: 'ok', value: parsed, raw: text, path }
  } catch {
    return { state: 'invalid', path, detail: 'The config is not valid JSON.' }
  }
}

export function configPathFor(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions
): string {
  const env = options.env ?? process.env
  const home = options.home
  return MANAGED_HOOK_PROVIDER_SPECS[provider].configPath(home, env)
}

export function readConfig(path: string): ConfigRead {
  if (!existsSync(path)) return { state: 'missing', path }
  let info
  try {
    info = statSync(path)
  } catch (error) {
    return {
      state: 'invalid',
      path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  if (!info.isFile()) return { state: 'invalid', path, detail: 'The config path is not a file.' }
  if (info.size > MAX_CONFIG_BYTES) {
    return { state: 'invalid', path, detail: 'The config file is too large.' }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return {
      state: 'invalid',
      path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  return parseManagedHookConfig(path, raw)
}

function writePathFor(path: string): string {
  if (!existsSync(path)) return path
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function writeConfig(path: string, value: Record<string, unknown>): void {
  const writePath = writePathFor(path)
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  if (existsSync(writePath)) {
    try {
      if (readFileSync(writePath, 'utf8') === serialized) return
    } catch {
      // Fall through to the atomic write and let it report the failure.
    }
  }
  const directory = dirname(writePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const existingMode = existsSync(writePath) ? statSync(writePath).mode & 0o777 : 0o600
  const temporary = `${writePath}.icode-tmp-${String(process.pid)}-${String(
    Math.random()
  ).slice(2)}`
  try {
    writeFileSync(temporary, serialized, { encoding: 'utf8', mode: existingMode, flag: 'wx' })
    if (process.platform !== 'win32') chmodSync(temporary, existingMode)
    if (existsSync(writePath)) {
      try {
        copyFileSync(writePath, `${writePath}${CONFIG_BACKUP_SUFFIX}`)
      } catch {
        // A backup is helpful, never required for a correct write.
      }
    }
    renameSync(temporary, writePath)
  } finally {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary)
      } catch {
        // best effort
      }
    }
  }
}

export function ensureManagedHookScript(options: ManagedHookInstallOptions): ManagedHookRuntime {
  const platform = options.platform ?? process.platform
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  const scriptPath = join(options.directory, MANAGED_HOOK_SCRIPT_NAME)
  writeFileSync(scriptPath, MANAGED_HOOK_SCRIPT, { mode: 0o700 })
  try {
    chmodSync(scriptPath, 0o700)
  } catch {
    // Windows ignores POSIX modes.
  }

  let wrapperPath: string | null = null
  if (platform === 'win32') {
    wrapperPath = join(options.directory, MANAGED_HOOK_WRAPPER_NAME)
    const lines = ['@echo off']
    if (options.electronRunAsNode) lines.push('set "ELECTRON_RUN_AS_NODE=1"')
    lines.push(`"${options.execPath}" "${scriptPath}" %*`)
    writeFileSync(wrapperPath, `${lines.join('\r\n')}\r\n`, { mode: 0o700 })
  }

  const commandFor = (provider: ManagedHookProvider, event: ManagedHookEvent): string => {
    if (wrapperPath !== null) {
      // Cursor executes hooks through PowerShell on Windows; prefixing the
      // wrapper keeps it valid even when the host shell is cmd.
      if (provider === 'cursor') {
        const quoted = wrapperPath.replace(/'/g, "''")
        return `powershell.exe -NoProfile -Command "& '${quoted}' ${provider} ${event.providerEvent} ${event.canonicalEvent} ${event.response}"`
      }
      return `"${wrapperPath}" ${provider} ${event.providerEvent} ${event.canonicalEvent} ${event.response}`
    }
    const prefix = options.electronRunAsNode ? 'env ELECTRON_RUN_AS_NODE=1 ' : ''
    return [
      prefix + shellQuote(options.execPath),
      shellQuote(scriptPath),
      shellQuote(provider),
      shellQuote(event.providerEvent),
      shellQuote(event.canonicalEvent),
      shellQuote(event.response)
    ].join(' ')
  }

  const powershellCommandFor = (
    provider: ManagedHookProvider,
    event: ManagedHookEvent
  ): string => {
    if (wrapperPath === null) return commandFor(provider, event)
    return `& "${wrapperPath}" ${provider} ${event.providerEvent} ${event.canonicalEvent} ${event.response}`
  }

  return { scriptPath, wrapperPath, commandFor, powershellCommandFor }
}

function managedDefinition(
  spec: ManagedHookProviderSpec,
  command: string,
  powershellCommand: string,
  event: ManagedHookEvent
): Record<string, unknown> {
  if (spec.kind === 'nested') {
    // Gemini reads milliseconds; Qwen is Claude-compatible and accepts the
    // nested command without a provider-specific timeout.
    return {
      ...(event.matcher === undefined ? {} : { matcher: event.matcher }),
      hooks: [
        {
          type: 'command',
          command,
          ...(spec.harness === 'gemini' ? { timeout: spec.timeoutMilliseconds } : {})
        }
      ]
    }
  }
  if (spec.kind === 'cursor') {
    return { command, timeout: spec.timeoutSeconds }
  }
  return {
    type: 'command',
    bash: command,
    powershell: powershellCommand,
    timeoutSec: spec.timeoutSeconds
  }
}

export function currentManagedCommand(
  definition: unknown,
  command: string
): boolean {
  if (!isRecord(definition)) return false
  return commandValues(definition).includes(command)
}

export function managedHooksStatusFromConfig(
  provider: ManagedHookProvider,
  config: ConfigRead,
  commandForEvent: (event: ManagedHookEvent) => string
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const configPath = config.path
  if (config.state !== 'ok') {
    return {
      provider,
      label: spec.label,
      state: config.state === 'invalid' ? 'failed' : 'not-installed',
      configPath,
      detail: config.state === 'invalid' ? config.detail : null
    }
  }
  const hooks = config.value.hooks
  if (hooks !== undefined && !isRecord(hooks)) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath,
      detail: 'The config "hooks" value is not a JSON object.'
    }
  }
  const hookRecord = isRecord(hooks) ? hooks : {}
  const missing: string[] = []
  let present = 0
  for (const event of spec.events) {
    const definitions = hookRecord[event.providerEvent]
    if (definitions !== undefined && !Array.isArray(definitions)) {
      return {
        provider,
        label: spec.label,
        state: 'failed',
        configPath,
        detail: `The config hook "${event.providerEvent}" is not an array.`
      }
    }
    const hasCommand =
      Array.isArray(definitions) &&
      definitions.some((definition) => currentManagedCommand(definition, commandForEvent(event)))
    if (hasCommand) present += 1
    else missing.push(event.providerEvent)
  }
  let stale = false
  for (const [eventName, definitions] of Object.entries(hookRecord)) {
    if (!Array.isArray(definitions)) continue
    const expected = spec.events.find((event) => event.providerEvent === eventName)
    const current = expected === undefined ? null : commandForEvent(expected)
    for (const definition of definitions) {
      if (!definitionHasManagedCommand(definition)) continue
      if (current === null || !currentManagedCommand(definition, current)) stale = true
    }
  }
  if (isManagedHookProviderDisabled(provider, config.value) && (present > 0 || stale)) {
    return {
      provider,
      label: spec.label,
      state: 'partial',
      configPath,
      detail: 'The provider config disables hooks.'
    }
  }
  if (stale) {
    return {
      provider,
      label: spec.label,
      state: 'partial',
      configPath,
      detail: 'Managed hook entries are stale.'
    }
  }
  if (missing.length === 0) {
    return { provider, label: spec.label, state: 'installed', configPath, detail: null }
  }
  return {
    provider,
    label: spec.label,
    state: present === 0 ? 'not-installed' : 'partial',
    configPath,
    detail: present === 0 ? null : `Managed hook missing for: ${missing.join(', ')}`
  }
}

/**
 * Pure config transform shared by local and guest installers.
 *
 * `disableAllHooks` is handled by the caller: a disabled provider config must
 * not be rewritten just because the user opened iCode.
 */
export function applyManagedHookConfig(
  provider: ManagedHookProvider,
  value: Record<string, unknown>,
  commandForEvent: (event: ManagedHookEvent) => string,
  powershellCommandForEvent: (event: ManagedHookEvent) => string
): { value: Record<string, unknown>; error: string | null } {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const hooksValue = value.hooks
  if (hooksValue !== undefined && !isRecord(hooksValue)) {
    return { value, error: 'The config "hooks" value is not a JSON object.' }
  }
  const cleaned = cleanAllHookEvents(isRecord(hooksValue) ? hooksValue : {})
  const nextHooks = cleaned.value
  for (const event of spec.events) {
    const current = nextHooks[event.providerEvent]
    if (current !== undefined && !Array.isArray(current)) {
      return {
        value,
        error: `The config hook "${event.providerEvent}" is not an array.`
      }
    }
    const definitions = Array.isArray(current) ? current : []
    nextHooks[event.providerEvent] = [
      ...definitions,
      managedDefinition(
        spec,
        commandForEvent(event),
        powershellCommandForEvent(event),
        event
      )
    ]
  }
  const next: Record<string, unknown> = { ...value, hooks: nextHooks }
  if (spec.kind === 'cursor' || spec.kind === 'copilot') {
    if (next.version === undefined) next.version = 1
  }
  return { value: next, error: null }
}

/** Pure removal shared by local and guest installers. */
export function removeManagedHookConfig(value: Record<string, unknown>): {
  value: Record<string, unknown>
  changed: boolean
} {
  if (!isRecord(value.hooks)) return { value, changed: false }
  const cleaned = cleanAllHookEvents(value.hooks)
  if (!cleaned.changed) return { value, changed: false }
  return { value: { ...value, hooks: cleaned.value }, changed: true }
}

export function managedHooksStatus(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const runtime = ensureManagedHookScript(options)
  const config = readConfig(configPathFor(provider, options))
  return managedHooksStatusFromConfig(provider, config, (event) => runtime.commandFor(provider, event))
}

export function installManagedHooksForProvider(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const runtime = ensureManagedHookScript(options)
  const config = readConfig(configPathFor(provider, options))
  if (config.state === 'invalid') {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: config.path,
      detail: config.detail
    }
  }
  const value = config.state === 'ok' ? config.value : {}
  if (isManagedHookProviderDisabled(provider, value)) {
    return managedHooksStatusFromConfig(
      provider,
      { state: 'ok', value, raw: '', path: config.path },
      (event) => runtime.commandFor(provider, event)
    )
  }
  const applied = applyManagedHookConfig(
    provider,
    value,
    (event) => runtime.commandFor(provider, event),
    (event) => runtime.powershellCommandFor(provider, event)
  )
  if (applied.error !== null) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: config.path,
      detail: applied.error
    }
  }
  writeConfig(config.path, applied.value)
  return managedHooksStatus(provider, options)
}

export function removeManagedHooksForProvider(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const config = readConfig(configPathFor(provider, options))
  if (config.state !== 'ok') {
    return managedHooksStatusFromConfig(provider, config, () => '')
  }
  const removed = removeManagedHookConfig(config.value)
  if (removed.changed) writeConfig(config.path, removed.value)
  return managedHooksStatusFromConfig(
    provider,
    { state: 'ok', value: removed.value, raw: '', path: config.path },
    () => ensureManagedHookScript(options).commandFor(provider, spec.events[0]!)
  )
}

export function providerForHarness(harness: HarnessId): ManagedHookProvider | null {
  if (harness === 'gemini') return 'gemini'
  if (harness === 'qwen-code') return 'qwen-code'
  if (harness === 'cursor') return 'cursor'
  if (harness === 'copilot') return 'copilot'
  if (harness === 'grok') return 'grok'
  if (harness === 'kimi') return 'kimi'
  if (harness === 'amp') return 'amp'
  if (harness === 'droid') return 'droid'
  if (harness === 'openclaude') return 'openclaude'
  if (harness === 'qoder') return 'qoder'
  if (harness === 'qoder-cn') return 'qoder-cn'
  if (harness === 'codebuddy') return 'codebuddy'
  if (harness === 'antigravity') return 'antigravity'
  if (harness === 'command-code') return 'command-code'
  if (harness === 'devin') return 'devin'
  if (harness === 'muse') return 'muse'
  if (harness === 'zcode') return 'zcode'
  if (harness === 'kiro') return 'kiro'
  if (harness === 'dsh') return 'dsh'
  if (harness === 'jcode') return 'jcode'
  if (harness === 'hermes') return 'hermes'
  return null
}

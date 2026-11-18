/**
 * The launchable harness catalog.
 *
 * This is deliberately broader than what iCode currently observes. An entry
 * here means "iCode can start this CLI and detect it"; it does not mean iCode
 * has a managed status adapter, provider injection, or resume support. Those
 * are capability subsets and live below with explicit defaults.
 *
 * Catalog breadth is copied from Orca's TUI agent catalog (45 entries) so the
 * same CLIs can be launched here. The transport, protocol, and status depth are
 * iCode's own. Adding an agent must not silently claim status support: the
 * default capability record observes nothing and stays honestly `unknown`.
 *
 * `shell` is iCode's terminal entry, not an Orca TUI agent. It is last because
 * the picker treats it as a separate action.
 */

export type HarnessId =
  | 'claude'
  | 'claude-agent-teams'
  | 'openclaude'
  | 'codex'
  | 'grok'
  | 'copilot'
  | 'opencode2'
  | 'opencode'
  | 'mimo-code'
  | 'ante'
  | 'trae'
  | 'muse'
  | 'dsh'
  | 'qoder'
  | 'qoder-cn'
  | 'zcode'
  | 'pi'
  | 'omp'
  | 'prime-agent'
  | 'gemini'
  | 'antigravity'
  | 'aider'
  | 'goose'
  | 'amp'
  | 'kilo'
  | 'kiro'
  | 'crush'
  | 'aug'
  | 'autohand'
  | 'cline'
  | 'codebuff'
  | 'freebuff'
  | 'command-code'
  | 'continue'
  | 'cursor'
  | 'droid'
  | 'kimi'
  | 'mistral-vibe'
  | 'qwen-code'
  | 'rovo'
  | 'hermes'
  | 'devin'
  | 'openclaw'
  | 'codebuddy'
  | 'jcode'
  | 'shell'

export type HarnessCommand =
  | { kind: 'executable'; name: string }
  | { kind: 'user-shell' }

/**
 * The three harnesses that support endpoint injection and Mira's native
 * assistant. Provider selection and native conversations are capability
 * subsets, not aliases of the full launch catalog.
 */
export const MODEL_HARNESSES = ['claude', 'codex', 'opencode'] as const
export type ModelHarness = (typeof MODEL_HARNESSES)[number]

export type HarnessGroup = 'primary' | 'secondary' | 'terminal'

/**
 * A resume recipe for the harness's own CLI.
 *
 * `tokenArgs` contains the literal `$TOKEN` placeholder. `fallback` is used
 * when the session has no captured provider session id; when absent, Wake is
 * a fresh launch rather than a false claim that the conversation resumed.
 */
export type HarnessResumeRecipe = {
  tokenArgs: readonly string[]
  fallback?: readonly string[]
}

export type HarnessDefinition = {
  id: HarnessId
  label: string
  command: HarnessCommand
  group: HarnessGroup
  /** Additional executable names accepted by detection, in order. */
  detectAliases?: readonly string[]
  /** Commands that must also resolve before this entry is usable. */
  requires?: readonly string[]
  /** argv appended after the executable, before provider/hook arguments. */
  launchArgs?: readonly string[]
  /** Extra picker search terms beyond the label and id. */
  searchAliases?: readonly string[]
  /** Runtime/platform values where detection must not offer this entry. */
  unsupportedRuntimes?: readonly ('win32' | 'darwin' | 'linux' | 'wsl')[]
  /** Non-null means the entry exists for catalog parity but iCode cannot launch it. */
  unsupported?: string
  resume?: HarnessResumeRecipe
}

const definition = (source: HarnessDefinition): HarnessDefinition => source

/**
 * Ordered primary entries first, then the community tail, then the terminal.
 * The picker renders the same split; detection may run over the whole list.
 */
export const HARNESS_DEFINITIONS_LIST: readonly HarnessDefinition[] = [
  definition({
    id: 'claude',
    label: 'Claude Code',
    command: { kind: 'executable', name: 'claude' },
    group: 'primary',
    resume: { tokenArgs: ['--resume', '$TOKEN'], fallback: ['--continue'] }
  }),
  definition({
    id: 'claude-agent-teams',
    label: 'Claude Agent Teams',
    command: { kind: 'executable', name: 'orca' },
    group: 'primary',
    detectAliases: ['orca-dev', 'orca-ide'],
    requires: ['claude'],
    launchArgs: ['claude-teams'],
    unsupportedRuntimes: ['win32', 'wsl'],
    unsupported: 'Claude Agent Teams is an Orca CLI wrapper and cannot be launched from iCode.'
  }),
  definition({
    id: 'openclaude',
    label: 'OpenClaude',
    command: { kind: 'executable', name: 'openclaude' },
    group: 'primary'
  }),
  definition({
    id: 'codex',
    label: 'Codex',
    command: { kind: 'executable', name: 'codex' },
    group: 'primary',
    resume: { tokenArgs: ['resume', '$TOKEN'], fallback: ['resume', '--last'] }
  }),
  definition({
    id: 'grok',
    label: 'Grok',
    command: { kind: 'executable', name: 'grok' },
    group: 'primary',
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'copilot',
    label: 'GitHub Copilot',
    command: { kind: 'executable', name: 'copilot' },
    group: 'primary',
    resume: { tokenArgs: ['--resume=$TOKEN'] }
  }),
  definition({
    id: 'opencode2',
    label: 'OpenCode 2',
    command: { kind: 'executable', name: 'opencode2' },
    group: 'primary',
    launchArgs: ['--standalone'],
    resume: { tokenArgs: ['--session', '$TOKEN'] }
  }),
  definition({
    id: 'opencode',
    label: 'OpenCode',
    command: { kind: 'executable', name: 'opencode' },
    group: 'primary',
    resume: { tokenArgs: ['--session', '$TOKEN'], fallback: ['--continue'] }
  }),
  definition({
    id: 'mimo-code',
    label: 'MiMo Code',
    command: { kind: 'executable', name: 'mimo' },
    group: 'primary',
    resume: { tokenArgs: ['--session', '$TOKEN'] }
  }),
  definition({
    id: 'ante',
    label: 'Ante',
    command: { kind: 'executable', name: 'ante' },
    group: 'primary'
  }),
  definition({
    id: 'trae',
    label: 'Trae',
    command: { kind: 'executable', name: 'traecli' },
    group: 'primary'
  }),
  definition({
    id: 'muse',
    label: 'Muse',
    command: { kind: 'executable', name: 'muse' },
    group: 'primary',
    resume: { tokenArgs: ['resume', '$TOKEN'] }
  }),
  definition({
    id: 'dsh',
    label: 'DeepSeek Harness',
    command: { kind: 'executable', name: 'dsh-tui' },
    group: 'primary',
    detectAliases: ['dst'],
    requires: ['dsh'],
    launchArgs: ['.'],
    searchAliases: ['deepseek', 'dsh', 'dst', 'deepseek harness'],
    resume: { tokenArgs: ['--backend=dsh', '--resume', '$TOKEN'] }
  }),
  definition({
    id: 'qoder',
    label: 'Qoder CLI',
    command: { kind: 'executable', name: 'qodercli' },
    group: 'primary',
    detectAliases: ['qoder'],
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'qoder-cn',
    label: 'Qoder CLI China',
    command: { kind: 'executable', name: 'qoderclicn' },
    group: 'primary',
    detectAliases: ['qodercn'],
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'zcode',
    label: 'ZCode',
    command: { kind: 'executable', name: 'zcode' },
    group: 'primary',
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'pi',
    label: 'Pi',
    command: { kind: 'executable', name: 'pi' },
    group: 'primary',
    resume: { tokenArgs: ['--session', '$TOKEN'] }
  }),
  definition({
    id: 'omp',
    label: 'OMP',
    command: { kind: 'executable', name: 'omp' },
    group: 'primary',
    searchAliases: ['oh-my-pi', 'oh my pi'],
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'prime-agent',
    label: 'Prime Agent',
    command: { kind: 'executable', name: 'prime-agent' },
    group: 'primary',
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'gemini',
    label: 'Gemini',
    command: { kind: 'executable', name: 'gemini' },
    group: 'primary',
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'antigravity',
    label: 'Antigravity',
    command: { kind: 'executable', name: 'agy' },
    group: 'primary',
    searchAliases: ['agy'],
    resume: { tokenArgs: ['--conversation', '$TOKEN'] }
  }),
  definition({
    id: 'aider',
    label: 'Aider',
    command: { kind: 'executable', name: 'aider' },
    group: 'secondary'
  }),
  definition({
    id: 'goose',
    label: 'Goose',
    command: { kind: 'executable', name: 'goose' },
    group: 'secondary'
  }),
  definition({
    id: 'amp',
    label: 'Amp',
    command: { kind: 'executable', name: 'amp' },
    group: 'secondary'
  }),
  definition({
    id: 'kilo',
    label: 'Kilocode',
    command: { kind: 'executable', name: 'kilo' },
    group: 'secondary'
  }),
  definition({
    id: 'kiro',
    label: 'Kiro',
    command: { kind: 'executable', name: 'kiro-cli' },
    group: 'secondary',
    launchArgs: ['chat', '--tui'],
    resume: { tokenArgs: ['--resume-id', '$TOKEN'] }
  }),
  definition({
    id: 'crush',
    label: 'Charm',
    command: { kind: 'executable', name: 'crush' },
    group: 'secondary'
  }),
  definition({
    id: 'aug',
    label: 'Auggie',
    command: { kind: 'executable', name: 'auggie' },
    group: 'secondary'
  }),
  definition({
    id: 'autohand',
    label: 'Autohand Code',
    command: { kind: 'executable', name: 'autohand' },
    group: 'secondary'
  }),
  definition({
    id: 'cline',
    label: 'Cline',
    command: { kind: 'executable', name: 'cline' },
    group: 'secondary'
  }),
  definition({
    id: 'codebuff',
    label: 'Codebuff',
    command: { kind: 'executable', name: 'codebuff' },
    group: 'secondary'
  }),
  definition({
    id: 'freebuff',
    label: 'Freebuff',
    command: { kind: 'executable', name: 'freebuff' },
    group: 'secondary'
  }),
  definition({
    id: 'command-code',
    label: 'Command Code',
    command: { kind: 'executable', name: 'command-code' },
    group: 'secondary'
  }),
  definition({
    id: 'continue',
    label: 'Continue',
    command: { kind: 'executable', name: 'cn' },
    group: 'secondary'
  }),
  definition({
    id: 'cursor',
    label: 'Cursor',
    command: { kind: 'executable', name: 'cursor-agent' },
    group: 'secondary',
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'droid',
    label: 'Droid',
    command: { kind: 'executable', name: 'droid' },
    group: 'secondary',
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'kimi',
    label: 'Kimi',
    command: { kind: 'executable', name: 'kimi' },
    group: 'secondary',
    detectAliases: ['kimi-code'],
    resume: { tokenArgs: ['--session', '$TOKEN'] }
  }),
  definition({
    id: 'mistral-vibe',
    label: 'Mistral Vibe',
    command: { kind: 'executable', name: 'vibe' },
    group: 'secondary',
    detectAliases: ['mistral-vibe']
  }),
  definition({
    id: 'qwen-code',
    label: 'Qwen Code',
    command: { kind: 'executable', name: 'qwen' },
    group: 'secondary',
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'rovo',
    label: 'Rovo Dev',
    command: { kind: 'executable', name: 'acli' },
    group: 'secondary',
    launchArgs: ['rovodev', 'run']
  }),
  definition({
    id: 'hermes',
    label: 'Hermes',
    command: { kind: 'executable', name: 'hermes' },
    group: 'secondary',
    launchArgs: ['--tui'],
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'devin',
    label: 'Devin',
    command: { kind: 'executable', name: 'devin' },
    group: 'secondary',
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'openclaw',
    label: 'OpenClaw',
    command: { kind: 'executable', name: 'openclaw' },
    group: 'secondary'
  }),
  definition({
    id: 'codebuddy',
    label: 'CodeBuddy',
    command: { kind: 'executable', name: 'codebuddy' },
    group: 'secondary',
    detectAliases: ['cbc'],
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'jcode',
    label: 'Jcode',
    command: { kind: 'executable', name: 'jcode' },
    group: 'secondary',
    resume: { tokenArgs: ['--resume', '$TOKEN'] }
  }),
  definition({
    id: 'shell',
    label: 'Shell',
    command: { kind: 'user-shell' },
    group: 'terminal'
  })
]

export const HARNESS_IDS = HARNESS_DEFINITIONS_LIST.map(
  (entry) => entry.id
) as unknown as readonly [HarnessId, ...HarnessId[]]

export const HARNESS_DEFINITIONS: Record<HarnessId, HarnessDefinition> =
  Object.fromEntries(HARNESS_DEFINITIONS_LIST.map((entry) => [entry.id, entry])) as Record<
    HarnessId,
    HarnessDefinition
  >

export type HarnessActivityCapabilities = {
  /** Claude-style hook events are installed and authoritative. */
  hook: boolean
  /** OSC 7501 program status is consumed. */
  program: boolean
  /** OSC 0/2 terminal titles are consumed as a correction channel. */
  title: boolean
  /** A managed harness plugin reports full status snapshots. */
  plugin: boolean
}

export type HarnessCapabilities = {
  activity: HarnessActivityCapabilities
  resume: 'token' | 'store' | 'none'
  /** A terminal-derived turn end may complete an unattended task. */
  terminalTaskCompletion: boolean
}

const NO_ACTIVITY: HarnessActivityCapabilities = {
  hook: false,
  program: false,
  title: false,
  plugin: false
}

/**
 * What iCode can actually observe. Everything outside the four implemented
 * paths stays `unknown` until its adapter lands; the catalog entry existing is
 * not evidence that status is available.
 */
export const HARNESS_CAPABILITIES: Record<HarnessId, HarnessCapabilities> =
  Object.fromEntries(
    HARNESS_DEFINITIONS_LIST.map((entry) => {
      const base: HarnessCapabilities = {
        activity: { ...NO_ACTIVITY },
        resume: entry.resume === undefined ? 'none' : 'token',
        terminalTaskCompletion: false
      }
      return [entry.id, base]
    })
  ) as Record<HarnessId, HarnessCapabilities>

HARNESS_CAPABILITIES.claude = {
  activity: { hook: true, program: true, title: true, plugin: false },
  resume: 'token',
  terminalTaskCompletion: true
}

HARNESS_CAPABILITIES.codex = {
  activity: { hook: false, program: true, title: true, plugin: false },
  resume: 'token',
  terminalTaskCompletion: true
}

HARNESS_CAPABILITIES.opencode = {
  // OpenCode 1.19.6 emits no OSC 7501 and its title carries no state; the
  // managed plugin is its first precise channel.
  activity: { hook: false, program: false, title: false, plugin: true },
  resume: 'token',
  terminalTaskCompletion: false
}

// Phase B installs managed hooks for these four providers. The UI uses the
// capability flag to decide whether hook evidence can be shown at all, so it
// must match the installer above rather than staying at the catalog default.
for (const id of [
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
] as const) {
  HARNESS_CAPABILITIES[id].activity.hook = true
}

export function harnessLabel(id: HarnessId): string {
  return HARNESS_DEFINITIONS[id].label
}

export function harnessDefinition(id: HarnessId): HarnessDefinition {
  return HARNESS_DEFINITIONS[id]
}

/** Detection names in priority order: launch name first, then aliases. */
export function harnessDetectNames(id: HarnessId): string[] {
  const definition = HARNESS_DEFINITIONS[id]
  if (definition.command.kind !== 'executable') return []
  return [definition.command.name, ...(definition.detectAliases ?? [])]
}

/** Names that must also resolve for detection, e.g. `dsh` behind `dsh-tui`. */
export function harnessRequiredNames(id: HarnessId): string[] {
  return [...(HARNESS_DEFINITIONS[id].requires ?? [])]
}

/** argv that belongs to the catalog launch, before any adapter/provider args. */
export function harnessLaunchArgs(id: HarnessId): string[] {
  return [...(HARNESS_DEFINITIONS[id].launchArgs ?? [])]
}

/** Lower-case terms the picker can search, beyond the visible label. */
export function harnessSearchTerms(id: HarnessId): string[] {
  const definition = HARNESS_DEFINITIONS[id]
  return [
    id,
    definition.label,
    ...(definition.detectAliases ?? []),
    ...(definition.searchAliases ?? [])
  ].map((term) => term.toLowerCase())
}

export type ResumePlan = {
  args: string[]
  resumesConversation: boolean
}

/**
 * Expands a token recipe. `$TOKEN` is the only placeholder and is replaced
 * literally; a token containing `$` never becomes shell syntax because argv is
 * never interpreted by a shell.
 */
export function resumePlan(id: HarnessId, token: string | null): ResumePlan {
  const recipe = HARNESS_DEFINITIONS[id].resume
  if (recipe === undefined) return { args: [], resumesConversation: false }
  if (token !== null && token.length > 0) {
    return {
      args: recipe.tokenArgs.map((arg) => arg.split('$TOKEN').join(token)),
      resumesConversation: true
    }
  }
  if (recipe.fallback !== undefined) {
    return { args: [...recipe.fallback], resumesConversation: true }
  }
  // A token recipe without a fallback must not claim a fresh CLI resumed.
  return { args: [], resumesConversation: false }
}

/**
 * Shell is a terminal, not an agent. Review notes typed into it would be
 * executed as shell input, so only the coding-agent harnesses can receive them.
 * Catalog-only entries never have sessions, so this remains a shell test.
 */
export function isAgentHarness(id: HarnessId): id is Exclude<HarnessId, 'shell'> {
  return id !== 'shell'
}

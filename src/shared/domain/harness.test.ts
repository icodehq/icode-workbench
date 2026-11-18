import { describe, expect, it } from 'vitest'
import {
  HARNESS_CAPABILITIES,
  HARNESS_DEFINITIONS,
  HARNESS_DEFINITIONS_LIST,
  HARNESS_IDS,
  MODEL_HARNESSES,
  classifyHarnessProbe,
  extractHarnessVersion,
  harnessLabel,
  isAgentHarness,
  isHarnessSelectable,
  openCodePluginApi,
  resumePlan
} from './harness'
import type { HarnessProbeEvidence } from './harness'

function probe(overrides: Partial<HarnessProbeEvidence> = {}): HarnessProbeEvidence {
  return {
    harness: 'claude',
    resolvedPath: '/usr/local/bin/claude',
    outcome: 'exited',
    exitCode: 0,
    signal: null,
    spawnErrorCode: null,
    stdout: '2.1.304 (Claude Code)',
    stderr: '',
    durationMs: 120,
    observedAt: 1_700_000_000_000,
    attempts: 1,
    ...overrides
  }
}

describe('harness registry', () => {
  it('exposes the 45-entry Orca launch catalog plus the terminal', () => {
    expect(HARNESS_IDS).toHaveLength(46)
    expect(new Set(HARNESS_IDS).size).toBe(46)
    expect(HARNESS_IDS[0]).toBe('claude')
    expect(HARNESS_IDS.at(-1)).toBe('shell')
    expect(HARNESS_DEFINITIONS_LIST.filter((entry) => entry.id !== 'shell')).toHaveLength(45)
    expect(Object.keys(HARNESS_DEFINITIONS).sort()).toEqual([...HARNESS_IDS].sort())
  })

  it('keeps the picker split and the model subset explicit', () => {
    expect(
      HARNESS_DEFINITIONS_LIST.filter((entry) => entry.group === 'primary')
    ).toHaveLength(21)
    expect(
      HARNESS_DEFINITIONS_LIST.filter((entry) => entry.group === 'secondary')
    ).toHaveLength(24)
    expect(MODEL_HARNESSES).toEqual(['claude', 'codex', 'opencode'])
    expect(harnessLabel('claude')).toBe('Claude Code')
    expect(harnessLabel('dsh')).toBe('DeepSeek Harness')
    expect(harnessLabel('shell')).toBe('Shell')
  })

  it('uses the user shell for the shell entry', () => {
    expect(HARNESS_DEFINITIONS.shell.command).toEqual({ kind: 'user-shell' })
    expect(HARNESS_DEFINITIONS.claude.command).toEqual({ kind: 'executable', name: 'claude' })
  })

  it('records aliases and required commands without changing the launch name', () => {
    expect(HARNESS_DEFINITIONS.qoder.command).toEqual({
      kind: 'executable',
      name: 'qodercli'
    })
    expect(HARNESS_DEFINITIONS.qoder.detectAliases).toEqual(['qoder'])
    expect(HARNESS_DEFINITIONS.dsh.detectAliases).toEqual(['dst'])
    expect(HARNESS_DEFINITIONS.dsh.requires).toEqual(['dsh'])
    expect(HARNESS_DEFINITIONS.kiro.launchArgs).toEqual(['chat', '--tui'])
    expect(HARNESS_DEFINITIONS.dsh.launchArgs).toEqual(['.'])
    expect(HARNESS_DEFINITIONS['claude-agent-teams'].unsupported).toBeTruthy()
  })

  it('carries resume recipes for the 26 resumable agents', () => {
    expect(HARNESS_DEFINITIONS_LIST.filter((entry) => entry.resume !== undefined)).toHaveLength(
      26
    )
    expect(resumePlan('claude', 'abc')).toEqual({
      args: ['--resume', 'abc'],
      resumesConversation: true
    })
    expect(resumePlan('claude', null)).toEqual({
      args: ['--continue'],
      resumesConversation: true
    })
    expect(resumePlan('copilot', 'abc')).toEqual({
      args: ['--resume=abc'],
      resumesConversation: true
    })
    expect(resumePlan('gemini', null)).toEqual({ args: [], resumesConversation: false })
    expect(resumePlan('aider', 'abc')).toEqual({ args: [], resumesConversation: false })
  })

  it('only lets agent harnesses receive review notes', () => {
    expect(isAgentHarness('claude')).toBe(true)
    expect(isAgentHarness('gemini')).toBe(true)
    expect(isAgentHarness('opencode')).toBe(true)
    expect(isAgentHarness('shell')).toBe(false)
  })

  it('claims hook status only for providers with a managed installer', () => {
    expect(HARNESS_CAPABILITIES.gemini.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES['qwen-code'].activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.cursor.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.copilot.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.grok.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.kimi.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.amp.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.droid.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.openclaude.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.qoder.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES['qoder-cn'].activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.codebuddy.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.antigravity.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES['command-code'].activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.devin.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.muse.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.zcode.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.kiro.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.dsh.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.jcode.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.hermes.activity.hook).toBe(true)
    expect(HARNESS_CAPABILITIES.aider.activity.hook).toBe(false)
    expect(HARNESS_CAPABILITIES.opencode.activity.plugin).toBe(true)
  })
})

describe('OpenCode plugin API selection', () => {
  it('maps each major to its loader shape', () => {
    expect(openCodePluginApi('1.19.6')).toBe('v1')
    expect(openCodePluginApi('2.0.21')).toBe('v2')
    expect(openCodePluginApi('v2.0.21')).toBe('v2')
    expect(openCodePluginApi('opencode 1.19.6')).toBe('v1')
    expect(openCodePluginApi(null)).toBe('unknown')
    expect(openCodePluginApi('')).toBe('unknown')
    expect(openCodePluginApi('not-a-version')).toBe('unknown')
  })
})

describe('version extraction', () => {
  it('reads a semver from stdout or stderr', () => {
    expect(extractHarnessVersion('2.1.304 (Claude Code)', '')).toBe('2.1.304')
    expect(extractHarnessVersion('', 'codex-cli v0.48.0')).toBe('0.48.0')
    expect(extractHarnessVersion('no version', '')).toBeNull()
  })
})

describe('classifyHarnessProbe', () => {
  it('marks a successful probe available with its version', () => {
    const result = classifyHarnessProbe(probe())
    expect(result.state).toBe('available')
    if (result.state !== 'available') return
    expect(result.version).toBe('2.1.304')
    expect(result.resolvedPath).toBe('/usr/local/bin/claude')
    expect(isHarnessSelectable(result)).toBe(true)
  })

  it('keeps exit 0 available even when no version is reported', () => {
    const result = classifyHarnessProbe(probe({ stdout: 'ok' }))
    expect(result.state).toBe('available')
    if (result.state !== 'available') return
    expect(result.version).toBeNull()
  })

  it('treats exit 0 with stderr warnings as available', () => {
    const result = classifyHarnessProbe(probe({ stderr: 'warning: config deprecated' }))
    expect(result.state).toBe('available')
  })

  it('classifies ENOENT as unavailable, not detection failure', () => {
    const result = classifyHarnessProbe(
      probe({ outcome: 'spawn_error', spawnErrorCode: 'ENOENT', exitCode: null, resolvedPath: null })
    )
    expect(result).toMatchObject({ state: 'unavailable', reason: 'not_found' })
    expect(isHarnessSelectable(result)).toBe(false)
  })

  it.each(['EACCES', 'EPERM'])('classifies %s as permission denied', (code) => {
    const result = classifyHarnessProbe(
      probe({ outcome: 'spawn_error', spawnErrorCode: code, exitCode: null })
    )
    expect(result).toMatchObject({ state: 'unavailable', reason: 'permission_denied' })
  })

  it('keeps an unknown spawn error as detection failed', () => {
    const result = classifyHarnessProbe(
      probe({ outcome: 'spawn_error', spawnErrorCode: 'EIO', exitCode: null })
    )
    expect(result).toMatchObject({ state: 'detection_failed', reason: 'spawn_error' })
  })

  it('treats a timeout as detection failed even with incompatible-looking output', () => {
    const result = classifyHarnessProbe(
      probe({ outcome: 'timed_out', exitCode: null, stderr: 'Missing optional dependency codex-linux-x64' })
    )
    expect(result).toMatchObject({ state: 'detection_failed', reason: 'timeout' })
  })

  it('treats a signal as detection failed', () => {
    const result = classifyHarnessProbe(
      probe({ outcome: 'signaled', exitCode: null, signal: 'SIGKILL' })
    )
    expect(result).toMatchObject({ state: 'detection_failed', reason: 'terminated_by_signal' })
    if (result.state !== 'detection_failed') return
    expect(result.message).toContain('SIGKILL')
  })

  it('keeps an ambiguous nonzero exit as detection failed, not unavailable', () => {
    const result = classifyHarnessProbe(
      probe({ harness: 'codex', exitCode: 1, stdout: '', stderr: 'Error: something went wrong' })
    )
    expect(result).toMatchObject({ state: 'detection_failed', reason: 'nonzero_exit' })
    if (result.state !== 'detection_failed') return
    expect(result.diagnostics.stderrTail).toContain('something went wrong')
  })

  it('recognizes the observed Codex missing-platform binary as unavailable', () => {
    const result = classifyHarnessProbe(
      probe({
        harness: 'codex',
        exitCode: 1,
        stdout: '',
        stderr:
          'Error: Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex@latest'
      })
    )
    expect(result).toMatchObject({
      state: 'unavailable',
      reason: 'incompatible_installation',
      incompatibility: 'missing_platform_binary'
    })
  })

  it('recognizes the observed OpenCode wrong-platform package as unavailable', () => {
    const result = classifyHarnessProbe(
      probe({
        harness: 'opencode',
        exitCode: 1,
        stdout: '',
        stderr:
          'It seems that your package manager failed to install the right version of the opencode CLI for your platform. You can try manually installing "opencode-linux-x64"'
      })
    )
    expect(result).toMatchObject({
      state: 'unavailable',
      reason: 'incompatible_installation',
      incompatibility: 'wrong_platform_package'
    })
  })

  it('recognizes exec-format failures as unsupported platform', () => {
    const result = classifyHarnessProbe(
      probe({ exitCode: 126, stdout: '', stderr: 'bash: ./claude: cannot execute binary file: Exec format error' })
    )
    expect(result).toMatchObject({ state: 'unavailable', incompatibility: 'unsupported_platform' })
  })

  it('recognizes ABI/glibc failures as incompatible runtime', () => {
    const result = classifyHarnessProbe(
      probe({ exitCode: 1, stdout: '', stderr: 'Error: NODE_MODULE_VERSION 148 mismatch' })
    )
    expect(result).toMatchObject({ state: 'unavailable', incompatibility: 'incompatible_runtime' })
  })

  it('bounds diagnostic tails and normalizes metrics', () => {
    const result = classifyHarnessProbe(
      probe({
        exitCode: 1,
        stderr: 'e'.repeat(5000),
        stdout: 'o'.repeat(3000),
        durationMs: 12.6,
        attempts: 0
      })
    )
    expect(result.diagnostics.stderrTail.length).toBeLessThanOrEqual(2000)
    expect(result.diagnostics.stdoutTail.length).toBeLessThanOrEqual(1000)
    expect(result.diagnostics.durationMs).toBe(13)
    expect(result.diagnostics.attempts).toBe(1)
    expect(result.diagnostics.observedAt).toBe(1_700_000_000_000)
  })
})

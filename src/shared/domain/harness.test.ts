import { describe, expect, it } from 'vitest'
import {
  HARNESS_DEFINITIONS,
  HARNESS_IDS,
  classifyHarnessProbe,
  extractHarnessVersion,
  harnessLabel,
  isHarnessSelectable
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
  it('exposes exactly the four approved commands', () => {
    expect(HARNESS_IDS).toEqual(['claude', 'codex', 'opencode', 'shell'])
    expect(harnessLabel('claude')).toBe('Claude Code')
    expect(harnessLabel('codex')).toBe('Codex')
    expect(harnessLabel('opencode')).toBe('OpenCode')
    expect(harnessLabel('shell')).toBe('Shell')
  })

  it('uses the user shell for the shell entry', () => {
    expect(HARNESS_DEFINITIONS.shell.command).toEqual({ kind: 'user-shell' })
    expect(HARNESS_DEFINITIONS.claude.command).toEqual({ kind: 'executable', name: 'claude' })
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

import { describe, expect, it } from 'vitest'
import { HarnessDetector, type ProbeResult } from './harness-detector'
import { findExecutable } from './find-executable'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    outcome: 'exited',
    exitCode: 0,
    signal: null,
    spawnErrorCode: null,
    stdout: '2.1.304 (Claude Code)',
    stderr: '',
    durationMs: 12,
    ...overrides
  }
}

function detector(
  options: {
    resolve?: (name: string) => string | null
    probe?: ProbeResult | (() => Promise<ProbeResult>)
    shell?: string
  } = {}
): { detector: HarnessDetector; probes: string[] } {
  const probes: string[] = []
  return {
    probes,
    detector: new HarnessDetector({
      resolve: options.resolve ?? ((name) => (name.startsWith('/') ? name : `/usr/bin/${name}`)),
      probe: async (file) => {
        probes.push(file)
        if (typeof options.probe === 'function') return options.probe()
        return options.probe ?? probe()
      },
      shellPath: () => options.shell ?? '/bin/bash',
      now: () => 1_700_000_000_000
    })
  }
}

describe('harness detection', () => {
  it('reports an available harness with a resolved launch command', async () => {
    const { detector: d, probes } = detector()
    const result = await d.detect('claude')
    expect(result.state).toBe('available')
    expect(result.state === 'available' ? result.version : null).toBe('2.1.304')
    expect(result.command).toEqual({ command: '/usr/bin/claude', args: [] })
    expect(probes).toEqual(['/usr/bin/claude'])
  })

  it('reports a missing executable as unavailable, not detection failure', async () => {
    const { detector: d } = detector({ resolve: () => null })
    const result = await d.detect('codex')
    expect(result).toMatchObject({ state: 'unavailable', reason: 'not_found' })
    expect(result.command).toBeNull()
  })

  it('keeps a timeout as detection failed', async () => {
    const { detector: d } = detector({ probe: probe({ outcome: 'timed_out', exitCode: null }) })
    const result = await d.detect('opencode')
    expect(result).toMatchObject({ state: 'detection_failed', reason: 'timeout' })
  })

  it('keeps an ambiguous nonzero exit as detection failed', async () => {
    const { detector: d } = detector({
      probe: probe({ exitCode: 1, stdout: '', stderr: 'unexpected failure' })
    })
    const result = await d.detect('codex')
    expect(result).toMatchObject({ state: 'detection_failed', reason: 'nonzero_exit' })
    expect(result.diagnostics.stderrTail).toContain('unexpected failure')
  })

  it('reports a verified platform incompatibility as unavailable with a reason', async () => {
    const { detector: d } = detector({
      probe: probe({
        exitCode: 1,
        stdout: '',
        stderr:
          'Error: Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex@latest'
      })
    })
    const result = await d.detect('codex')
    expect(result).toMatchObject({
      state: 'unavailable',
      reason: 'incompatible_installation',
      incompatibility: 'missing_platform_binary'
    })
    expect(result.command).toBeNull()
  })

  it('probes the user shell for the shell harness', async () => {
    const { detector: d, probes } = detector({ shell: '/bin/bash' })
    const result = await d.detect('shell')
    expect(result.state).toBe('available')
    expect(probes).toEqual(['/bin/bash'])
    expect(result.command).toEqual({ command: '/bin/bash', args: [] })
  })

  it('re-resolves and re-probes on every call (retry is real)', async () => {
    let calls = 0
    const d = new HarnessDetector({
      resolve: (name) => {
        calls += 1
        return calls === 1 ? null : `/usr/bin/${name}`
      },
      probe: async () => probe(),
      shellPath: () => '/bin/bash'
    })
    expect((await d.detect('claude')).state).toBe('unavailable')
    const second = await d.detect('claude')
    expect(calls).toBe(2)
    expect(second.state).toBe('available')
  })

  it('detects all four harnesses independently', async () => {
    const { detector: d } = detector({
      resolve: (name) => (name === 'opencode' ? null : `/usr/bin/${name}`)
    })
    const results = await d.detectAll()
    expect(results.map((entry) => entry.harness)).toEqual(['claude', 'codex', 'opencode', 'shell'])
    expect(results.find((entry) => entry.harness === 'opencode')?.state).toBe('unavailable')
    expect(results.find((entry) => entry.harness === 'claude')?.state).toBe('available')
  })
})

describe('findExecutable', () => {
  it('finds an executable on PATH without a shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ade-path-'))
    try {
      const file = join(dir, 'fake-agent')
      writeFileSync(file, '#!/bin/sh\nexit 0\n')
      chmodSync(file, 0o755)
      expect(findExecutable('fake-agent', { PATH: dir }, 'linux')).toBe(file)
      expect(findExecutable('missing-agent', { PATH: dir }, 'linux')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects names containing path separators', () => {
    expect(findExecutable('../bin/sh', { PATH: '/bin' }, 'linux')).toBeNull()
    expect(findExecutable('bin/sh', { PATH: '/bin' }, 'linux')).toBeNull()
  })

  it('ignores non-executable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ade-path-'))
    try {
      const file = join(dir, 'not-exec')
      writeFileSync(file, 'data')
      chmodSync(file, 0o644)
      expect(findExecutable('not-exec', { PATH: dir }, 'linux')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

import { describe, expect, it } from 'vitest'
import { HarnessDetector, spawnSpec, type ProbeResult } from './harness-detector'
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
    /** `null` models a platform with no resolvable shell at all. */
    shell?: string | null
    platform?: NodeJS.Platform
    shellUnavailableMessage?: string
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
      shellPath: () => ('shell' in options ? options.shell ?? null : '/bin/bash'),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.shellUnavailableMessage
        ? { shellUnavailableMessage: () => options.shellUnavailableMessage! }
        : {}),
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

describe('Windows shell harness', () => {
  const CMD = 'C:\\Windows\\System32\\cmd.exe'

  it('treats a resolved shell as available without a version probe', async () => {
    const { detector: instance, probes } = detector({
      platform: 'win32',
      shell: CMD,
      resolve: (name) => (name === CMD ? CMD : null)
    })

    const result = await instance.detect('shell')

    expect(result.state).toBe('available')
    expect(result.command).toEqual({ command: CMD, args: [] })
    // Probing an interactive shell would hang until the timeout.
    expect(probes).toEqual([])
  })

  it('never launches /bin/bash on Windows', async () => {
    const { detector: instance, probes } = detector({
      platform: 'win32',
      shell: CMD,
      resolve: (name) => (name === CMD ? CMD : null)
    })

    await instance.detect('shell')

    expect(probes).not.toContain('/bin/bash')
  })

  it('reports an actionable failure when no shell can be found', async () => {
    const message =
      'No Windows shell was found. Tried pwsh.exe, powershell.exe, cmd.exe. Install PowerShell 7.'
    const { detector: instance } = detector({
      platform: 'win32',
      shell: null,
      shellUnavailableMessage: message
    })

    const result = await instance.detect('shell')

    expect(result.state).toBe('detection_failed')
    if (result.state !== 'detection_failed') throw new Error('expected detection_failed')
    expect(result.message).toBe(message)
    expect(result.diagnostics.outcome).toBe('spawn_error')
    expect(result.diagnostics.resolvedPath).toBeNull()
  })

  it('reports an unresolvable configured shell by name', async () => {
    const { detector: instance } = detector({
      platform: 'win32',
      shell: 'C:\\stale\\bash.exe',
      resolve: () => null
    })

    const result = await instance.detect('shell')

    expect(result.state).toBe('detection_failed')
    if (result.state !== 'detection_failed') throw new Error('expected detection_failed')
    expect(result.message).toContain('C:\\stale\\bash.exe')
    expect(result.command).toBeNull()
  })

  it('keeps the POSIX probe for the shell harness on Linux', async () => {
    const { detector: instance, probes } = detector({ shell: '/bin/bash' })

    const result = await instance.detect('shell')

    expect(result.state).toBe('available')
    expect(probes).toEqual(['/bin/bash'])
  })
})

describe('starting Windows command shims', () => {
  it('spawns a .cmd shim through the command interpreter', () => {
    const spec = spawnSpec(
      'C:\\nvm4w\\nodejs\\claude.cmd',
      ['--version'],
      'win32',
      'C:\\Windows\\System32\\cmd.exe'
    )
    expect(spec.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(spec.args[3]).toContain('claude.cmd')
    expect(spec.args[3]).toContain('--version')
    expect(spec.windowsVerbatimArguments).toBe(true)
  })

  it('quotes a shim path that contains spaces', () => {
    const spec = spawnSpec(
      'C:\\Program Files\\nodejs\\claude.cmd',
      ['--version'],
      'win32',
      'C:\\Windows\\System32\\cmd.exe'
    )
    expect(spec.args[3]).toContain('"C:\\Program Files\\nodejs\\claude.cmd"')
  })

  it('spawns a real executable directly', () => {
    expect(spawnSpec('C:\\tools\\claude.exe', ['--version'], 'win32')).toEqual({
      file: 'C:\\tools\\claude.exe',
      args: ['--version']
    })
  })

  it('never wraps POSIX commands in a shell', () => {
    expect(spawnSpec('/usr/bin/claude', ['--version'], 'linux')).toEqual({
      file: '/usr/bin/claude',
      args: ['--version']
    })
  })
})

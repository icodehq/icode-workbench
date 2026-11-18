import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import { ManagedHooksService } from './managed-hooks-service'
import type { ManagedHookProvider } from './managed-hooks'

const roots: string[] = []

function service(
  available: ManagedHookProvider[],
  enabledRef: { value: boolean } = { value: true }
): { service: ManagedHooksService; home: string; enabledRef: { value: boolean } } {
  const base = mkdtempSync(join(tmpdir(), 'icode-managed-hooks-service-'))
  roots.push(base)
  const home = join(base, 'home')
  return {
    home,
    enabledRef,
    service: new ManagedHooksService({
      directory: join(base, 'agent-hooks'),
      home,
      execPath: process.execPath,
      electronRunAsNode: false,
      platform: 'linux',
      env: {},
      loadEnabled: () => enabledRef.value,
      saveEnabled: (enabled) => {
        enabledRef.value = enabled
        return true
      },
      isAvailable: (provider) => available.includes(provider)
    })
  }
}

function geminiPath(home: string): string {
  return join(home, '.gemini', 'settings.json')
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

describe('managed hooks service', () => {
  it('installs only available CLIs and reports the rest as not found', () => {
    const { service: instance, home } = service(['gemini', 'cursor'])
    const state = instance.refresh()
    expect(state.enabled).toBe(true)
    const byProvider = Object.fromEntries(state.providers.map((entry) => [entry.provider, entry]))
    expect(byProvider.gemini?.state).toBe('installed')
    expect(byProvider.cursor?.state).toBe('installed')
    expect(byProvider['qwen-code']?.state).toBe('cli-not-found')
    expect(byProvider.copilot?.state).toBe('cli-not-found')
    expect(read(geminiPath(home)).hooks).toBeTruthy()
  })

  it('turns off by removing only managed entries', async () => {
    const { service: instance, home, enabledRef } = service(['gemini'])
    instance.refresh()
    expect(read(geminiPath(home)).hooks).toBeTruthy()

    const state = await instance.setEnabled(false)
    expect(enabledRef.value).toBe(false)
    expect(state.enabled).toBe(false)
    expect(state.providers.every((entry) => entry.state === 'disabled')).toBe(true)
    expect(read(geminiPath(home))).toEqual({ hooks: {} })
  })

  it('installs a provider on its first local session even after startup', () => {
    const available: ManagedHookProvider[] = []
    const { service: instance, home } = service(available)
    const detection = { state: 'available', harness: 'gemini' } as unknown as HarnessDetectionResult
    instance.prepareForSession('gemini', { kind: 'local' }, detection)
    expect(() => read(geminiPath(home))).toThrow()

    available.push('gemini')
    instance.prepareForSession('gemini', { kind: 'local' }, detection)
    expect(read(geminiPath(home)).hooks).toBeTruthy()
  })

  it('does not install for WSL or a disabled setting', () => {
    const { service: instance, home, enabledRef } = service(['gemini'])
    const detection = { state: 'available', harness: 'gemini' } as unknown as HarnessDetectionResult
    instance.prepareForSession(
      'gemini',
      { kind: 'wsl', distro: 'Ubuntu', distroId: null },
      detection
    )
    expect(() => read(geminiPath(home))).toThrow()

    enabledRef.value = false
    instance.prepareForSession('gemini', { kind: 'local' }, detection)
    expect(() => read(geminiPath(home))).toThrow()
  })

  it('ignores harnesses without a managed adapter', () => {
    const { service: instance, home } = service(['gemini'])
    instance.prepareForSession(
      'claude',
      { kind: 'local' },
      { state: 'available', harness: 'claude' } as unknown as HarnessDetectionResult
    )
    expect(() => read(geminiPath(home))).toThrow()
  })
})

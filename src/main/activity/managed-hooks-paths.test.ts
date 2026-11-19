import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MANAGED_HOOK_PROVIDER_IDS,
  managedHookGuestConfigPath,
  managedHookHomePath
} from '../../shared/domain/managed-hook-providers'
import { configPathFor, type ManagedHookInstallOptions } from './managed-hooks'

const roots: string[] = []

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

function options(base: string, env: NodeJS.ProcessEnv = {}): ManagedHookInstallOptions {
  return {
    directory: join(base, 'agent-hooks'),
    home: join(base, 'home'),
    execPath: process.execPath,
    electronRunAsNode: false,
    platform: 'linux',
    env
  }
}

describe('managed hook config paths', () => {
  it('defaults every provider to its shared home-relative path', () => {
    const base = mkdtempSync(join(tmpdir(), 'icode-managed-paths-'))
    roots.push(base)
    const opts = options(base, {})
    for (const provider of MANAGED_HOOK_PROVIDER_IDS) {
      expect(configPathFor(provider, opts)).toBe(
        join(opts.home, ...managedHookHomePath(provider))
      )
    }
  })

  it('applies the local environment overrides', () => {
    const base = mkdtempSync(join(tmpdir(), 'icode-managed-paths-env-'))
    roots.push(base)
    const env: NodeJS.ProcessEnv = {
      COPILOT_HOME: join(base, 'copilot'),
      GROK_HOME: join(base, 'grok'),
      KIMI_CODE_HOME: join(base, 'kimi'),
      APPDATA: join(base, 'appdata'),
      XDG_CONFIG_HOME: join(base, 'xdg'),
      KIRO_HOME: join(base, 'kiro'),
      DSH_HOME: join(base, 'dsh'),
      JCODE_HOME: join(base, 'jcode'),
      HERMES_HOME: join(base, 'hermes')
    }
    const opts = options(base, env)
    expect(configPathFor('copilot', opts)).toBe(join(base, 'copilot', 'hooks', 'icode.json'))
    expect(configPathFor('grok', opts)).toBe(
      join(base, 'grok', 'hooks', 'icode-status.json')
    )
    expect(configPathFor('kimi', opts)).toBe(join(base, 'kimi', 'config.toml'))
    expect(configPathFor('devin', opts)).toBe(
      join(base, 'appdata', 'devin', 'config.json')
    )
    expect(configPathFor('muse', opts)).toBe(join(base, 'xdg', 'muse', 'settings.json'))
    expect(configPathFor('kiro', opts)).toBe(
      join(base, 'kiro', 'hooks', 'icode-agent-status.json')
    )
    expect(configPathFor('dsh', opts)).toBe(join(base, 'dsh', 'cordis.patch.yml'))
    expect(configPathFor('jcode', opts)).toBe(join(base, 'jcode', 'config.toml'))
    expect(configPathFor('hermes', opts)).toBe(join(base, 'hermes', 'config.yaml'))
  })

  it('keeps the Hermes dotfolder preference when LOCALAPPDATA is unused', () => {
    const base = mkdtempSync(join(tmpdir(), 'icode-managed-paths-hermes-'))
    roots.push(base)
    const home = join(base, 'home')
    const dotfolder = join(home, '.hermes')
    mkdirSync(dotfolder, { recursive: true })
    const opts = options(base, { LOCALAPPDATA: join(base, 'localappdata') })
    expect(configPathFor('hermes', opts)).toBe(join(dotfolder, 'config.yaml'))
  })

  it('derives guest paths without reading host env overrides', () => {
    for (const provider of MANAGED_HOOK_PROVIDER_IDS) {
      expect(managedHookGuestConfigPath(provider, '/home/u')).toBe(
        `/home/u/${managedHookHomePath(provider).join('/')}`
      )
    }
  })
})

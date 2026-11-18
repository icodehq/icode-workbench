import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadAppPreferences, saveAppPreferences } from '../../app/preferences'
import { OpenCodeIntegrationService } from './service'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'icode-opencode-service-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function service(configDir = join(directory, 'opencode')) {
  return new OpenCodeIntegrationService({
    directory,
    configDir: () => configDir,
    env: {},
    loadEnabled: () => loadAppPreferences(directory).opencodeIntegrationEnabled,
    saveEnabled: (enabled) =>
      saveAppPreferences(directory, {
        ...loadAppPreferences(directory),
        opencodeIntegrationEnabled: enabled
      })
  })
}

describe('OpenCode integration service', () => {
  it('defaults on and installs the detected 1.x layout', async () => {
    const instance = service()
    expect(instance.getState()).toMatchObject({ enabled: true, api: 'unknown' })
    await instance.refresh('1.19.6')
    expect(instance.getState()).toMatchObject({
      enabled: true,
      api: 'v1',
      install: { state: 'installed', api: 'v1' }
    })
  })

  it('persists the toggle and removes the install', async () => {
    const instance = service()
    await instance.refresh('1.19.6')
    const state = await instance.setEnabled(false)
    expect(state).toMatchObject({
      enabled: false,
      install: { state: 'not-installed' }
    })
    expect(loadAppPreferences(directory).opencodeIntegrationEnabled).toBe(false)

    const reopened = service()
    expect(reopened.getState().enabled).toBe(false)
  })

  it('reports an unsupported version without creating a plugin', async () => {
    const instance = service()
    await instance.refresh(null)
    expect(instance.getState()).toMatchObject({
      api: 'unknown',
      install: { state: 'unsupported' }
    })
  })

  it('uses an overlay for a custom OPENCODE_CONFIG_DIR and returns its env', async () => {
    const source = join(directory, 'custom-opencode')
    const profile = join(directory, 'profile')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'tui.json'), '{"plugin":["user"]}\n')
    const instance = new OpenCodeIntegrationService({
      directory,
      userDataDir: profile,
      configDir: () => source,
      env: { OPENCODE_CONFIG_DIR: source }
    })
    const env = await instance.prepareForSession('opencode', { kind: 'local' }, '2.0.21')
    expect(env).toMatchObject({ OPENCODE_CONFIG_DIR: expect.stringContaining('opencode-config-overlays') })
    const overlay = env!.OPENCODE_CONFIG_DIR!
    expect(overlay).not.toBe(source)
    expect(existsSync(join(source, 'plugins'))).toBe(false)
    expect(existsSync(join(overlay, 'plugins', 'icode-opencode-status.js'))).toBe(true)
    expect(instance.getState()).toMatchObject({ install: { state: 'installed' } })

    await instance.setEnabled(false)
    expect(existsSync(overlay)).toBe(false)
    expect(existsSync(join(source, 'tui.json'))).toBe(true)
  })

  it('ignores OPENCODE_CONFIG_DIR for 1.x and installs into the canonical path', async () => {
    const custom = join(directory, 'ignored-custom-opencode')
    const home = join(directory, 'home')
    mkdirSync(custom, { recursive: true })
    const instance = new OpenCodeIntegrationService({
      directory,
      userDataDir: join(directory, 'profile'),
      env: { OPENCODE_CONFIG_DIR: custom, USERPROFILE: home, HOME: home }
    })
    await instance.refresh('1.19.6')
    expect(instance.getState()).toMatchObject({
      api: 'v1',
      install: { state: 'installed', configDir: join(home, '.config', 'opencode') }
    })
    expect(existsSync(join(custom, 'plugins'))).toBe(false)
  })

  it('only prepares managed status for a local OpenCode session', async () => {
    const instance = service()
    await instance.prepareForSession('claude', { kind: 'local' }, '1.19.6')
    expect(instance.getState().api).toBe('unknown')
    await instance.prepareForSession(
      'opencode',
      { kind: 'wsl', distro: 'Ubuntu', distroId: null },
      '1.19.6'
    )
    // Version selection is target-independent; with no guest runner injected
    // this test service still learns the API but has nothing to install.
    expect(instance.getState()).toMatchObject({
      api: 'v1',
      install: { state: 'not-installed' }
    })
    await instance.prepareForSession('opencode', { kind: 'local' }, '1.19.6')
    expect(instance.getState()).toMatchObject({ api: 'v1', install: { state: 'installed' } })
  })
})

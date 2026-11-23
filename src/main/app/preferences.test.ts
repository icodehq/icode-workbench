import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_NETWORK_PROXY_SETTINGS } from '../../shared/domain/network'
import {
  DEFAULT_APP_PREFERENCES,
  loadAppPreferences,
  parseAppPreferences,
  saveAppPreferences,
  updateAppPreferences
} from './preferences'

let directory: string

const BASE_PREFERENCES = {
  opencodeIntegrationEnabled: true,
  agentStatusHooksEnabled: true,
  proxy: DEFAULT_NETWORK_PROXY_SETTINGS,
  updateAutoCheckEnabled: true,
  skippedUpdateVersion: null
} as const

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'icode-preferences-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('app preferences', () => {
  it('defaults to the system language on a fresh profile', () => {
    expect(loadAppPreferences(directory)).toEqual(DEFAULT_APP_PREFERENCES)
  })

  it('round-trips a pinned language', () => {
    expect(
      saveAppPreferences(directory, {
        locale: 'ja',
        ...BASE_PREFERENCES
      })
    ).toBe(true)
    expect(loadAppPreferences(directory)).toEqual({
      locale: 'ja',
      ...BASE_PREFERENCES
    })
    expect(JSON.parse(readFileSync(join(directory, 'preferences.json'), 'utf8'))).toEqual({
      locale: 'ja',
      ...BASE_PREFERENCES
    })
  })

  it('ignores unknown fields and rejects invalid records', () => {
    expect(parseAppPreferences({ locale: 'fr', extra: true })).toEqual({
      locale: 'fr',
      ...BASE_PREFERENCES
    })
    expect(parseAppPreferences({ locale: 'system' })).toEqual({
      locale: 'system',
      ...BASE_PREFERENCES
    })
    expect(
      parseAppPreferences({ locale: 'de', opencodeIntegrationEnabled: false })
    ).toEqual({
      locale: 'de',
      ...BASE_PREFERENCES,
      opencodeIntegrationEnabled: false
    })
    expect(
      parseAppPreferences({ locale: 'de', opencodeIntegrationEnabled: 'yes' })
    ).toEqual({
      locale: 'de',
      ...BASE_PREFERENCES,
      opencodeIntegrationEnabled: true
    })
    expect(parseAppPreferences({ locale: 'zh-TW' })).toBeNull()
    expect(parseAppPreferences({ locale: 1 })).toBeNull()
    expect(parseAppPreferences([])).toBeNull()
    expect(parseAppPreferences(null)).toBeNull()
    expect(parseAppPreferences('en')).toBeNull()
  })

  it('defaults the update preferences for legacy and malformed records', () => {
    expect(
      parseAppPreferences({
        locale: 'en',
        updateAutoCheckEnabled: 'yes',
        skippedUpdateVersion: 42
      })
    ).toEqual({ locale: 'en', ...BASE_PREFERENCES })
    expect(
      parseAppPreferences({
        locale: 'en',
        updateAutoCheckEnabled: false,
        skippedUpdateVersion: ' 0.18.0 '
      })
    ).toEqual({
      locale: 'en',
      ...BASE_PREFERENCES,
      updateAutoCheckEnabled: false,
      skippedUpdateVersion: '0.18.0'
    })
    expect(parseAppPreferences({ locale: 'en', skippedUpdateVersion: '   ' })).toEqual({
      locale: 'en',
      ...BASE_PREFERENCES
    })
  })

  it('parses and normalizes a manual proxy', () => {
    expect(
      parseAppPreferences({
        locale: 'en',
        proxy: {
          mode: 'manual',
          httpProxyUrl: 'HTTP://127.0.0.1:7890/',
          httpsProxyUrl: 'socks5h://localhost:1080',
          noProxy: 'corp.example, corp.example, .local'
        }
      })
    ).toEqual({
      locale: 'en',
      ...BASE_PREFERENCES,
      proxy: {
        mode: 'manual',
        httpProxyUrl: 'http://127.0.0.1:7890',
        httpsProxyUrl: 'socks5h://localhost:1080',
        noProxy: 'corp.example,.local'
      }
    })
  })

  it('falls back to system mode when a persisted manual proxy is invalid', () => {
    const parsed = parseAppPreferences({
      locale: 'en',
      proxy: { mode: 'manual', httpProxyUrl: 'http://host', httpsProxyUrl: '', noProxy: '' }
    })
    expect(parsed?.proxy).toEqual(DEFAULT_NETWORK_PROXY_SETTINGS)
  })

  it('patches one preference without replacing the others', () => {
    expect(saveAppPreferences(directory, DEFAULT_APP_PREFERENCES)).toBe(true)
    expect(updateAppPreferences(directory, { locale: 'fr' })).toBe(true)
    expect(updateAppPreferences(directory, { opencodeIntegrationEnabled: false })).toBe(true)
    expect(updateAppPreferences(directory, { updateAutoCheckEnabled: false })).toBe(true)
    expect(updateAppPreferences(directory, { skippedUpdateVersion: '0.18.0' })).toBe(true)
    expect(
      updateAppPreferences(directory, {
        proxy: {
          mode: 'manual',
          httpProxyUrl: 'http://127.0.0.1:7890',
          httpsProxyUrl: 'http://127.0.0.1:7890',
          noProxy: ''
        }
      })
    ).toBe(true)
    expect(loadAppPreferences(directory)).toEqual({
      locale: 'fr',
      ...BASE_PREFERENCES,
      opencodeIntegrationEnabled: false,
      updateAutoCheckEnabled: false,
      skippedUpdateVersion: '0.18.0',
      proxy: {
        mode: 'manual',
        httpProxyUrl: 'http://127.0.0.1:7890',
        httpsProxyUrl: 'http://127.0.0.1:7890',
        noProxy: ''
      }
    })
    expect(updateAppPreferences(directory, { opencodeIntegrationEnabled: true })).toBe(true)
    expect(loadAppPreferences(directory)).toEqual({
      locale: 'fr',
      ...BASE_PREFERENCES,
      opencodeIntegrationEnabled: true,
      updateAutoCheckEnabled: false,
      skippedUpdateVersion: '0.18.0',
      proxy: {
        mode: 'manual',
        httpProxyUrl: 'http://127.0.0.1:7890',
        httpsProxyUrl: 'http://127.0.0.1:7890',
        noProxy: ''
      }
    })
    expect(updateAppPreferences(directory, { skippedUpdateVersion: null })).toBe(true)
    expect(loadAppPreferences(directory).skippedUpdateVersion).toBeNull()
  })

  it('falls back to defaults when the file is corrupt', () => {
    writeFileSync(join(directory, 'preferences.json'), '{not json', 'utf8')
    expect(loadAppPreferences(directory)).toEqual(DEFAULT_APP_PREFERENCES)
  })

  it('reports a failed write instead of throwing', () => {
    const missingParent = join(directory, 'nested')
    // Writing into a directory that cannot be created (a file in the way).
    writeFileSync(missingParent, 'not a directory', 'utf8')
    expect(
      saveAppPreferences(join(missingParent, 'child'), {
        locale: 'de',
        ...BASE_PREFERENCES
      })
    ).toBe(false)
  })
})

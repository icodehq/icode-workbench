import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_PREFERENCES,
  loadAppPreferences,
  parseAppPreferences,
  saveAppPreferences,
  updateAppPreferences
} from './preferences'

let directory: string

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
        opencodeIntegrationEnabled: true,
        agentStatusHooksEnabled: true
      })
    ).toBe(true)
    expect(loadAppPreferences(directory)).toEqual({
      locale: 'ja',
      opencodeIntegrationEnabled: true,
      agentStatusHooksEnabled: true
    })
    expect(JSON.parse(readFileSync(join(directory, 'preferences.json'), 'utf8'))).toEqual({
      locale: 'ja',
      opencodeIntegrationEnabled: true,
      agentStatusHooksEnabled: true
    })
  })

  it('ignores unknown fields and rejects invalid records', () => {
    expect(parseAppPreferences({ locale: 'fr', extra: true })).toEqual({
      locale: 'fr',
      opencodeIntegrationEnabled: true,
      agentStatusHooksEnabled: true
    })
    expect(parseAppPreferences({ locale: 'system' })).toEqual({
      locale: 'system',
      opencodeIntegrationEnabled: true,
      agentStatusHooksEnabled: true
    })
    expect(
      parseAppPreferences({ locale: 'de', opencodeIntegrationEnabled: false })
    ).toEqual({
      locale: 'de',
      opencodeIntegrationEnabled: false,
      agentStatusHooksEnabled: true
    })
    expect(
      parseAppPreferences({ locale: 'de', opencodeIntegrationEnabled: 'yes' })
    ).toEqual({
      locale: 'de',
      opencodeIntegrationEnabled: true,
      agentStatusHooksEnabled: true
    })
    expect(parseAppPreferences({ locale: 'zh-TW' })).toBeNull()
    expect(parseAppPreferences({ locale: 1 })).toBeNull()
    expect(parseAppPreferences([])).toBeNull()
    expect(parseAppPreferences(null)).toBeNull()
    expect(parseAppPreferences('en')).toBeNull()
  })

  it('patches one preference without replacing the other', () => {
    expect(saveAppPreferences(directory, DEFAULT_APP_PREFERENCES)).toBe(true)
    expect(updateAppPreferences(directory, { locale: 'fr' })).toBe(true)
    expect(updateAppPreferences(directory, { opencodeIntegrationEnabled: false })).toBe(true)
    expect(loadAppPreferences(directory)).toEqual({
      locale: 'fr',
      opencodeIntegrationEnabled: false,
      agentStatusHooksEnabled: true
    })
    expect(updateAppPreferences(directory, { opencodeIntegrationEnabled: true })).toBe(true)
    expect(loadAppPreferences(directory)).toEqual({
      locale: 'fr',
      opencodeIntegrationEnabled: true,
      agentStatusHooksEnabled: true
    })
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
        opencodeIntegrationEnabled: true,
        agentStatusHooksEnabled: true
      })
    ).toBe(false)
  })
})

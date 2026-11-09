import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_PREFERENCES,
  loadAppPreferences,
  parseAppPreferences,
  saveAppPreferences
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
    expect(saveAppPreferences(directory, { locale: 'ja' })).toBe(true)
    expect(loadAppPreferences(directory)).toEqual({ locale: 'ja' })
    expect(JSON.parse(readFileSync(join(directory, 'preferences.json'), 'utf8'))).toEqual({
      locale: 'ja'
    })
  })

  it('ignores unknown fields and rejects invalid records', () => {
    expect(parseAppPreferences({ locale: 'fr', extra: true })).toEqual({ locale: 'fr' })
    expect(parseAppPreferences({ locale: 'system' })).toEqual({ locale: 'system' })
    expect(parseAppPreferences({ locale: 'zh-TW' })).toBeNull()
    expect(parseAppPreferences({ locale: 1 })).toBeNull()
    expect(parseAppPreferences([])).toBeNull()
    expect(parseAppPreferences(null)).toBeNull()
    expect(parseAppPreferences('en')).toBeNull()
  })

  it('falls back to defaults when the file is corrupt', () => {
    writeFileSync(join(directory, 'preferences.json'), '{not json', 'utf8')
    expect(loadAppPreferences(directory)).toEqual(DEFAULT_APP_PREFERENCES)
  })

  it('reports a failed write instead of throwing', () => {
    const missingParent = join(directory, 'nested')
    // Writing into a directory that cannot be created (a file in the way).
    writeFileSync(missingParent, 'not a directory', 'utf8')
    expect(saveAppPreferences(join(missingParent, 'child'), { locale: 'de' })).toBe(false)
  })
})

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isLocalePreference,
  type LocalePreference
} from '../../shared/i18n/locales'

export type AppPreferences = {
  locale: LocalePreference
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = { locale: 'system' }

const PREFERENCES_FILE = 'preferences.json'

/** Parses a stored record, ignoring unknown fields and invalid locales. */
export function parseAppPreferences(value: unknown): AppPreferences | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!isLocalePreference(record.locale)) return null
  return { locale: record.locale }
}

export function loadAppPreferences(directory: string): AppPreferences {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, PREFERENCES_FILE), 'utf8'))
    return parseAppPreferences(parsed) ?? DEFAULT_APP_PREFERENCES
  } catch {
    return DEFAULT_APP_PREFERENCES
  }
}

/**
 * Preferences are a convenience, never a startup dependency. A read-only
 * profile must still launch with the system/default locale.
 */
export function saveAppPreferences(directory: string, preferences: AppPreferences): boolean {
  try {
    mkdirSync(directory, { recursive: true })
    const target = join(directory, PREFERENCES_FILE)
    const temporary = `${target}.tmp`
    writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
    return true
  } catch {
    return false
  }
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isLocalePreference,
  type LocalePreference
} from '../../shared/i18n/locales'

export type AppPreferences = {
  locale: LocalePreference
  /** Managed OpenCode status integration; default-on, removable from Settings. */
  opencodeIntegrationEnabled: boolean
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  locale: 'system',
  opencodeIntegrationEnabled: true
}

const PREFERENCES_FILE = 'preferences.json'

/** Parses a stored record, ignoring unknown fields and invalid optional values. */
export function parseAppPreferences(value: unknown): AppPreferences | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!isLocalePreference(record.locale)) return null
  return {
    locale: record.locale,
    opencodeIntegrationEnabled:
      typeof record.opencodeIntegrationEnabled === 'boolean'
        ? record.opencodeIntegrationEnabled
        : DEFAULT_APP_PREFERENCES.opencodeIntegrationEnabled
  }
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
 * Patches one preference without replacing the other.
 *
 * The read and write are synchronous and therefore atomic within the main
 * process; the language and integration toggles can never clobber each other.
 */
export function updateAppPreferences(
  directory: string,
  patch: Partial<AppPreferences>
): boolean {
  const current = loadAppPreferences(directory)
  return saveAppPreferences(directory, {
    locale: patch.locale ?? current.locale,
    opencodeIntegrationEnabled:
      patch.opencodeIntegrationEnabled ?? current.opencodeIntegrationEnabled
  })
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

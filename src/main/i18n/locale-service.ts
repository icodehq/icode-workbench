import { loadAppPreferences, saveAppPreferences } from '../app/preferences'
import { resolveLocale, type Locale, type LocalePreference } from '../../shared/i18n'
import type { LocaleState } from '../../shared/schemas/locale'

export type LocaleServiceOptions = {
  directory: string
  /** Most-preferred first. Electron supplies this from the OS. */
  systemLanguages: () => readonly string[]
  /** Called after a successful change, in the main process. */
  onChange?: (state: LocaleState) => void
}

/**
 * Owns the persisted language preference and the resolved locale.
 *
 * The preference and the locale are separate: `system` follows the OS until the
 * user pins a language. Every reader recomputes the system locale, so a caller
 * that opens Settings after an OS language change sees the language in force.
 */
export class LocaleService {
  private storedPreference: LocalePreference
  private resolved: Locale

  constructor(private readonly options: LocaleServiceOptions) {
    this.storedPreference = loadAppPreferences(options.directory).locale
    this.resolved = resolveLocale(this.storedPreference, options.systemLanguages())
  }

  /** Locale currently in force. Valid before the app is ready. */
  get locale(): Locale {
    return this.resolved
  }

  get preference(): LocalePreference {
    return this.storedPreference
  }

  state(): LocaleState {
    const systemLocale = resolveLocale('system', this.options.systemLanguages())
    this.resolved = this.storedPreference === 'system' ? systemLocale : this.storedPreference
    return {
      preference: this.storedPreference,
      locale: this.resolved,
      systemLocale
    }
  }

  set(preference: LocalePreference): LocaleState {
    this.storedPreference = preference
    saveAppPreferences(this.options.directory, { locale: preference })
    const state = this.state()
    this.options.onChange?.(state)
    return state
  }
}

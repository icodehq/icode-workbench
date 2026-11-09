import { isSupportedLocale, type Locale } from '../shared/i18n/locales'

const LOCALE_ARG_PREFIX = '--icode-locale='

/**
 * Main passes the resolved locale as a window argument, so the preload exposes
 * it synchronously and the renderer's first paint is already translated.
 */
export function readInitialLocale(argv: readonly string[]): Locale {
  for (const arg of argv) {
    if (!arg.startsWith(LOCALE_ARG_PREFIX)) continue
    const value = arg.slice(LOCALE_ARG_PREFIX.length)
    if (isSupportedLocale(value)) return value
  }
  return 'en'
}

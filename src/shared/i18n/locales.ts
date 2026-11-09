/**
 * Supported UI locales. English is the source language and the fallback.
 */
export const SUPPORTED_LOCALES = ['en', 'zh-CN', 'ja', 'ko', 'es', 'pt-BR', 'de', 'fr'] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]
export type LocalePreference = 'system' | Locale

export const DEFAULT_LOCALE: Locale = 'en'

/** Native names shown in the language picker. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  'pt-BR': 'Português (BR)',
  de: 'Deutsch',
  fr: 'Français'
}

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || isSupportedLocale(value)
}

function canonicalTag(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null
  } catch {
    return null
  }
}

/** Maps one OS tag to a supported locale; returns null when no safe match exists. */
export function normalizeLocaleTag(tag: string): Locale | null {
  const canonical = canonicalTag(tag)
  if (canonical === null) return null
  const lower = canonical.toLowerCase()
  if (lower === 'en' || lower.startsWith('en-')) return 'en'
  if (lower === 'ja' || lower.startsWith('ja-')) return 'ja'
  if (lower === 'ko' || lower.startsWith('ko-')) return 'ko'
  if (lower.startsWith('zh-')) {
    // Only Simplified Chinese is shipped. Traditional Chinese falls back to English.
    if (lower.includes('hant') || lower.startsWith('zh-tw') || lower.startsWith('zh-hk')) {
      return null
    }
    return 'zh-CN'
  }
  if (lower === 'zh') return 'zh-CN'
  if (lower === 'es' || lower.startsWith('es-')) return 'es'
  if (lower === 'pt' || lower.startsWith('pt-')) return 'pt-BR'
  if (lower === 'de' || lower.startsWith('de-')) return 'de'
  if (lower === 'fr' || lower.startsWith('fr-')) return 'fr'
  return null
}

/**
 * Resolves a stored preference against the OS language list. `system` follows
 * the first supported OS language; anything unsupported falls back to English.
 */
export function resolveLocale(
  preference: LocalePreference,
  systemLanguages: readonly string[]
): Locale {
  if (preference !== 'system') return preference
  for (const language of systemLanguages) {
    const match = normalizeLocaleTag(language)
    if (match !== null) return match
  }
  return DEFAULT_LOCALE
}

export function localeLabel(locale: Locale): string {
  return LOCALE_LABELS[locale]
}

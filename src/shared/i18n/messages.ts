import { CATALOGS, en, type MessageKey } from './catalogs'
import type { Locale } from './locales'

export type MessageParams = Record<string, string | number>

/** Replaces `{name}` placeholders without interpreting any other braces. */
export function interpolate(template: string, params: MessageParams = {}): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

export function hasMessage(locale: Locale, key: MessageKey): boolean {
  return key in CATALOGS[locale]
}

/**
 * Looks up a message in the selected locale, falling back to English. Missing
 * keys return the key itself rather than throwing, so a catalog gap cannot
 * break a window.
 */
export function t(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  const catalog = CATALOGS[locale] ?? en
  const template = catalog[key] ?? en[key] ?? key
  return interpolate(template, params)
}

/**
 * Plural lookup for keys such as `files.selected.one` / `files.selected.other`.
 * The category comes from the locale's CLDR rules; unsupported categories fall
 * back to `.other`.
 */
export function tp(
  locale: Locale,
  baseKey: string,
  count: number,
  params: MessageParams = {}
): string {
  const category = new Intl.PluralRules(locale).select(count)
  const withCategory = `${baseKey}.${category}` as MessageKey
  const other = `${baseKey}.other` as MessageKey
  const key = withCategory in en ? withCategory : other in en ? other : (baseKey as MessageKey)
  return t(locale, key, { ...params, count })
}

export type { MessageKey }

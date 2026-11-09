import { t, tp, type MessageKey, type MessageParams } from '../../shared/i18n/messages'
import type { Locale } from '../../shared/i18n/locales'

let currentLocale: Locale = 'en'

export function setMainLocale(locale: Locale): void {
  currentLocale = locale
}

export function getMainLocale(): Locale {
  return currentLocale
}

/** Main-process translation at the currently active locale. */
export function mainT(key: MessageKey, params: MessageParams = {}): string {
  return t(currentLocale, key, params)
}

export function mainTp(
  baseKey: string,
  count: number,
  params: MessageParams = {}
): string {
  return tp(currentLocale, baseKey, count, params)
}

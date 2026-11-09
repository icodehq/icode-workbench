import { useCallback, useSyncExternalStore } from 'react'
import { t, tp, type Locale, type MessageParams } from '../../../shared/i18n'
import type { LocaleState } from '../../../shared/schemas/locale'
import {
  getLocale,
  getLocaleState,
  subscribeLocale,
  type Translator
} from './i18n-store'

/** The selected locale plus its stored preference. */
export function useLocaleState(): LocaleState {
  return useSyncExternalStore(subscribeLocale, getLocaleState, getLocaleState)
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}

/**
 * Translation bound to the selected locale. Components re-render when the
 * language changes, so a setting applies without restarting the window.
 */
export function useT(): Translator {
  const locale = useLocale()
  return useCallback<Translator>((key, params) => t(locale, key, params), [locale])
}

export type PluralTranslator = (
  baseKey: string,
  count: number,
  params?: MessageParams
) => string

/** CLDR plural selection for the selected locale. */
export function useTp(): PluralTranslator {
  const locale = useLocale()
  return useCallback<PluralTranslator>(
    (baseKey, count, params) => tp(locale, baseKey, count, params),
    [locale]
  )
}

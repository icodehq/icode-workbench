import { makeAppError } from '../../../shared/domain/errors'
import type { IcodeApi } from '../../../shared/icode-api'
import {
  DEFAULT_LOCALE,
  t,
  tp,
  type Locale,
  type LocalePreference,
  type MessageKey,
  type MessageParams
} from '../../../shared/i18n'
import type { IpcResult } from '../../../shared/schemas/ipc'
import type { LocaleState } from '../../../shared/schemas/locale'

export type Translator = (key: MessageKey, params?: MessageParams) => string

function api(): IcodeApi | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as { icode?: IcodeApi }).icode
}

function initialLocale(): Locale {
  return api()?.locale.initial ?? DEFAULT_LOCALE
}

let state: LocaleState = {
  // Until main answers, show the locale that was resolved for this window.
  preference: 'system',
  locale: initialLocale(),
  systemLocale: initialLocale()
}

const listeners = new Set<() => void>()

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (root.lang !== locale) root.lang = locale
  root.dir = 'ltr'
}

function publish(next: LocaleState): void {
  state = next
  applyDocumentLocale(next.locale)
  for (const listener of listeners) listener()
}

export function getLocaleState(): LocaleState {
  return state
}

export function getLocale(): Locale {
  return state.locale
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function translate(key: MessageKey, params?: MessageParams): string {
  return t(state.locale, key, params)
}

/** Plural lookup for module-level label helpers. */
export function translatePlural(
  baseKey: string,
  count: number,
  params?: MessageParams
): string {
  return tp(state.locale, baseKey, count, params)
}

/** Resolves the authoritative preference and follows later changes. */
export function initI18n(): () => void {
  applyDocumentLocale(state.locale)
  const icode = api()
  if (icode === undefined) return () => {}

  const off = icode.locale.onChanged((next) => publish(next))
  void icode.locale.get().then((result) => {
    if (result.ok) publish(result.value)
  })
  return off
}

export async function setLocalePreference(
  preference: LocalePreference
): Promise<IpcResult<LocaleState>> {
  const icode = api()
  if (icode === undefined) {
    return {
      ok: false,
      error: makeAppError('INTERNAL', 'Language settings are unavailable.')
    }
  }
  const result = await icode.locale.set({ preference })
  if (result.ok) publish(result.value)
  return result
}

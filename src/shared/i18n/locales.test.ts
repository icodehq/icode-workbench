import { describe, expect, it } from 'vitest'
import {
  isLocalePreference,
  isSupportedLocale,
  normalizeLocaleTag,
  resolveLocale
} from './locales'

describe('locale resolution', () => {
  it('matches exact and base language tags', () => {
    expect(normalizeLocaleTag('en-US')).toBe('en')
    expect(normalizeLocaleTag('ja-JP')).toBe('ja')
    expect(normalizeLocaleTag('ko-KR')).toBe('ko')
    expect(normalizeLocaleTag('zh')).toBe('zh-CN')
    expect(normalizeLocaleTag('zh-CN')).toBe('zh-CN')
    expect(normalizeLocaleTag('es-419')).toBe('es')
    expect(normalizeLocaleTag('pt')).toBe('pt-BR')
    expect(normalizeLocaleTag('pt-PT')).toBe('pt-BR')
    expect(normalizeLocaleTag('de-AT')).toBe('de')
    expect(normalizeLocaleTag('fr-CA')).toBe('fr')
  })

  it('falls back to English for Traditional Chinese and unknown tags', () => {
    expect(normalizeLocaleTag('zh-TW')).toBeNull()
    expect(normalizeLocaleTag('zh-Hant')).toBeNull()
    expect(normalizeLocaleTag('zh-HK')).toBeNull()
    expect(normalizeLocaleTag('ru-RU')).toBeNull()
    expect(normalizeLocaleTag('not a locale')).toBeNull()
  })

  it('follows the first supported system language', () => {
    expect(resolveLocale('system', ['ru-RU', 'de-DE', 'en-US'])).toBe('de')
    expect(resolveLocale('system', ['ru-RU'])).toBe('en')
    expect(resolveLocale('system', [])).toBe('en')
  })

  it('honours an explicit preference over the system', () => {
    expect(resolveLocale('zh-CN', ['de-DE'])).toBe('zh-CN')
    expect(resolveLocale('fr', ['en-US'])).toBe('fr')
  })

  it('validates preferences without accepting arbitrary strings', () => {
    expect(isLocalePreference('system')).toBe(true)
    expect(isLocalePreference('pt-BR')).toBe(true)
    expect(isLocalePreference('pt-PT')).toBe(false)
    expect(isLocalePreference('ru')).toBe(false)
    expect(isSupportedLocale('zh-CN')).toBe(true)
    expect(isSupportedLocale('zh-TW')).toBe(false)
  })
})

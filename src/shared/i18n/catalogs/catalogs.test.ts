import { describe, expect, it } from 'vitest'
import { CATALOGS } from './index'
import { en } from './en'
import { SUPPORTED_LOCALES } from '../locales'

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g

function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
    .sort()
}

const englishKeys = Object.keys(en as Record<string, string>).sort()

describe('message catalogs', () => {
  it('ships every supported locale', () => {
    expect(Object.keys(CATALOGS).sort()).toEqual([...SUPPORTED_LOCALES].sort())
  })

  it('has exactly the English key set in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const catalog = CATALOGS[locale] as Record<string, string>
      expect(Object.keys(catalog).sort(), locale).toEqual(englishKeys)
    }
  })

  it('contains no empty or whitespace-only message', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const catalog = CATALOGS[locale] as Record<string, string>
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('')
      }
    }
  })

  it('keeps the same placeholders as English', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const catalog = CATALOGS[locale] as Record<string, string>
      for (const key of englishKeys) {
        expect(placeholders(catalog[key] ?? ''), `${locale}:${key}`).toEqual(
          placeholders(en[key as keyof typeof en])
        )
      }
    }
  })

  it('ships both plural categories for every plural base key', () => {
    const pluralBases = new Set<string>()
    for (const key of englishKeys) {
      const match = /^(.*)\.(one|other)$/u.exec(key)
      if (match?.[1] !== undefined) pluralBases.add(match[1])
    }
    expect(pluralBases.size).toBeGreaterThan(0)
    for (const locale of SUPPORTED_LOCALES) {
      const catalog = CATALOGS[locale] as Record<string, string>
      for (const base of pluralBases) {
        expect(catalog[`${base}.one`], `${locale}:${base}.one`).toBeTruthy()
        expect(catalog[`${base}.other`], `${locale}:${base}.other`).toBeTruthy()
      }
    }
  })
})

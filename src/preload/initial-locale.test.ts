import { describe, expect, it } from 'vitest'
import { readInitialLocale } from './initial-locale'

describe('readInitialLocale', () => {
  it('reads a supported locale from the window argument', () => {
    expect(readInitialLocale(['/electron', '--icode-locale=de'])).toBe('de')
    expect(readInitialLocale(['--icode-locale=zh-CN'])).toBe('zh-CN')
    expect(readInitialLocale(['--icode-locale=pt-BR', '--other'])).toBe('pt-BR')
  })

  it('falls back to English for missing or unsupported values', () => {
    expect(readInitialLocale([])).toBe('en')
    expect(readInitialLocale(['--icode-locale=ru'])).toBe('en')
    expect(readInitialLocale(['--icode-locale=zh-TW'])).toBe('en')
    expect(readInitialLocale(['--icode-locale='])).toBe('en')
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAppPreferences } from '../app/preferences'
import { LocaleService } from './locale-service'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'icode-locale-service-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('LocaleService', () => {
  it('resolves the system preference at construction', () => {
    const service = new LocaleService({
      directory,
      systemLanguages: () => ['ru-RU', 'pt-PT']
    })
    expect(service.locale).toBe('pt-BR')
    expect(service.state()).toEqual({
      preference: 'system',
      locale: 'pt-BR',
      systemLocale: 'pt-BR'
    })
  })

  it('persists a pinned language and reports the change', () => {
    const onChange = vi.fn()
    const service = new LocaleService({
      directory,
      systemLanguages: () => ['en-US'],
      onChange
    })
    const state = service.set('zh-CN')
    expect(state).toEqual({
      preference: 'zh-CN',
      locale: 'zh-CN',
      systemLocale: 'en'
    })
    expect(service.locale).toBe('zh-CN')
    expect(onChange).toHaveBeenCalledWith(state)
    expect(loadAppPreferences(directory)).toEqual({ locale: 'zh-CN' })
  })

  it('reloads a pinned preference from disk', () => {
    const first = new LocaleService({ directory, systemLanguages: () => ['fr-FR'] })
    first.set('ko')
    const second = new LocaleService({ directory, systemLanguages: () => ['fr-FR'] })
    expect(second.preference).toBe('ko')
    expect(second.locale).toBe('ko')
  })

  it('switches back to the current system language', () => {
    let languages = ['de-DE']
    const service = new LocaleService({
      directory,
      systemLanguages: () => languages
    })
    expect(service.locale).toBe('de')
    service.set('ja')
    expect(service.locale).toBe('ja')
    languages = ['fr-FR']
    expect(service.set('system')).toEqual({
      preference: 'system',
      locale: 'fr',
      systemLocale: 'fr'
    })
  })

  it('falls back to English when the system language is unsupported', () => {
    const service = new LocaleService({
      directory,
      systemLanguages: () => ['zh-TW', 'ru-RU']
    })
    expect(service.locale).toBe('en')
  })
})

import { describe, expect, it } from 'vitest'
import { hasMessage, interpolate, t, tp } from './messages'

describe('message lookup', () => {
  it('interpolates named placeholders and leaves unknown braces intact', () => {
    expect(interpolate('Hello {name}', { name: 'Ada' })).toBe('Hello Ada')
    expect(interpolate('{count} of {total}', { count: 2, total: 5 })).toBe('2 of 5')
    expect(interpolate('Keep {unknown}', {})).toBe('Keep {unknown}')
    expect(interpolate('Not JSON { "a": 1 }', {})).toBe('Not JSON { "a": 1 }')
  })

  it('translates known keys and falls back to English', () => {
    expect(t('zh-CN', 'rail.settings')).toBe('设置')
    expect(t('ja', 'common.refresh')).toBe('更新')
    expect(hasMessage('fr', 'rail.projects')).toBe(true)
  })

  it('selects CLDR plural categories', () => {
    expect(tp('en', 'settings.taskExecution.task', 1)).toBe('1 task')
    expect(tp('en', 'settings.taskExecution.task', 3)).toBe('3 tasks')
    expect(tp('de', 'settings.taskExecution.task', 1)).toBe('1 Aufgabe')
    expect(tp('de', 'settings.taskExecution.task', 3)).toBe('3 Aufgaben')
    expect(tp('fr', 'settings.taskExecution.task', 1)).toBe('1 tâche')
    expect(tp('fr', 'settings.taskExecution.task', 2)).toBe('2 tâches')
  })

  it('uses the .other variant when the locale has no matching category', () => {
    expect(tp('zh-CN', 'settings.taskExecution.task', 1)).toContain('1')
    expect(tp('ja', 'settings.taskExecution.task', 4)).toContain('4')
  })
})

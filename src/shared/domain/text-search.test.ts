import { describe, expect, it } from 'vitest'
import { compileTextMatcher, replaceLiteralAll } from './text-search'

describe('text search matcher', () => {
  it('finds literal text case-sensitively or not', () => {
    expect(compileTextMatcher('Needle', { caseSensitive: true, wholeWord: false, regex: false }).match('a Needle here')).toBe(2)
    expect(compileTextMatcher('needle', { caseSensitive: true, wholeWord: false, regex: false }).match('Needle')).toBe(-1)
    expect(compileTextMatcher('needle', { caseSensitive: false, wholeWord: false, regex: false }).match('Needle')).toBe(0)
  })

  it('enforces whole words', () => {
    const matcher = compileTextMatcher('cat', { caseSensitive: true, wholeWord: true, regex: false })
    expect(matcher.match('a cat here')).toBe(2)
    expect(matcher.match('concatenate')).toBe(-1)
    expect(matcher.match('cat_')).toBe(-1)
  })

  it('supports regex and reports invalid patterns', () => {
    const matcher = compileTextMatcher('c.t', { caseSensitive: true, wholeWord: false, regex: true })
    expect(matcher.match('a cat here')).toBe(2)
    expect(matcher.error).toBeNull()
    expect(
      compileTextMatcher('(', { caseSensitive: true, wholeWord: false, regex: true }).error
    ).not.toBeNull()
  })
})

describe('literal replace', () => {
  it('replaces all occurrences and reports the count', () => {
    expect(
      replaceLiteralAll('foo bar foo', 'foo', 'baz', { caseSensitive: true, wholeWord: false })
    ).toEqual({ text: 'baz bar baz', count: 2 })
  })

  it('respects case and whole-word options', () => {
    expect(
      replaceLiteralAll('Foo foo food', 'foo', 'x', { caseSensitive: false, wholeWord: true })
    ).toEqual({ text: 'x x food', count: 2 })
    expect(
      replaceLiteralAll('Foo foo', 'foo', 'x', { caseSensitive: true, wholeWord: true })
    ).toEqual({ text: 'Foo x', count: 1 })
  })

  it('does not interpret replacement dollar sequences', () => {
    expect(
      replaceLiteralAll('a', 'a', '$& $1', { caseSensitive: true, wholeWord: false })
    ).toEqual({ text: '$& $1', count: 1 })
  })
})

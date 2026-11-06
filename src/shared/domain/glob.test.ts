import { describe, expect, it } from 'vitest'
import { isExcluded, isSearchPathIncluded, matchesGlob } from './glob'

describe('files exclude globs', () => {
  it('matches basenames at any depth and root-relative paths', () => {
    expect(matchesGlob('a/b/.DS_Store', '.DS_Store')).toBe(true)
    expect(matchesGlob('tmp/a.log', '*.log')).toBe(true)
    expect(matchesGlob('src/a.ts', 'src/*.ts')).toBe(true)
    expect(matchesGlob('src/nested/a.ts', 'src/*.ts')).toBe(false)
    expect(matchesGlob('src/nested/a.ts', 'src/**/*.ts')).toBe(true)
    expect(matchesGlob('src/ab.ts', 'src/a?.ts')).toBe(true)
  })

  it('applies folder patterns to descendants and last-match negation', () => {
    expect(isExcluded('tmp/a.log', false, ['tmp/'])).toBe(true)
    expect(isExcluded('tmp/nested/a.log', false, ['tmp/'])).toBe(true)
    expect(isExcluded('tmp/keep.log', false, ['tmp/', '!tmp/keep.log'])).toBe(false)
    expect(isExcluded('tmp/keep.log', false, ['!tmp/keep.log', 'tmp/'])).toBe(true)
    expect(isExcluded('src/a.ts', false, ['node_modules'])).toBe(false)
  })

  it('does not treat a folder pattern as a file with the same name', () => {
    expect(isExcluded('build', false, ['build/'])).toBe(false)
    expect(isExcluded('build', true, ['build/'])).toBe(true)
  })

  it('applies include/exclude rules for search', () => {
    expect(isSearchPathIncluded('src/a.ts', ['src/**'], [])).toBe(true)
    expect(isSearchPathIncluded('test/a.ts', ['src/**'], [])).toBe(false)
    expect(isSearchPathIncluded('src/a.test.ts', ['src/**'], ['*.test.ts'])).toBe(false)
    expect(isSearchPathIncluded('src/nested/a.ts', [], ['src/nested/'])).toBe(false)
    expect(isSearchPathIncluded('src/a.ts', ['*.ts', '!src/a.ts'], [])).toBe(false)
  })
})

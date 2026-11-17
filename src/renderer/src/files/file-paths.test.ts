import { describe, expect, it } from 'vitest'
import { basenameOf, isUnder, parentPathOf } from './file-paths'

describe('file paths', () => {
  it('finds the parent directory, with the root represented by an empty path', () => {
    expect(parentPathOf('')).toBe('')
    expect(parentPathOf('a')).toBe('')
    expect(parentPathOf('a/b')).toBe('a')
    expect(parentPathOf('a/b/c')).toBe('a/b')
    expect(parentPathOf('a/b/')).toBe('a/b')
  })

  it('finds the basename, including the empty name after a trailing slash', () => {
    expect(basenameOf('')).toBe('')
    expect(basenameOf('a')).toBe('a')
    expect(basenameOf('a/b')).toBe('b')
    expect(basenameOf('a/b/')).toBe('')
  })

  it('treats the root as containing every path and respects segment boundaries', () => {
    expect(isUnder('', '')).toBe(true)
    expect(isUnder('a', '')).toBe(true)
    expect(isUnder('a', 'a')).toBe(true)
    expect(isUnder('a/b', 'a')).toBe(true)
    expect(isUnder('a/b', 'a/b')).toBe(true)
    expect(isUnder('ab', 'a')).toBe(false)
    expect(isUnder('a', 'b')).toBe(false)
    expect(isUnder('a/b', 'b')).toBe(false)
  })
})

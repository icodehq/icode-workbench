import { describe, expect, it } from 'vitest'
import { classifyExternalUrl } from './url-routing'

describe('classifyExternalUrl', () => {
  it('accepts http and https and normalizes them', () => {
    expect(classifyExternalUrl('https://example.com/docs')).toEqual({
      kind: 'http',
      url: 'https://example.com/docs'
    })
    expect(classifyExternalUrl(' http://example.com ')).toMatchObject({ kind: 'http' })
  })

  it('blocks unsafe schemes, relative strings, and oversized URLs', () => {
    expect(classifyExternalUrl('javascript:alert(1)')).toEqual({
      kind: 'blocked',
      reason: 'unsupported-scheme'
    })
    expect(classifyExternalUrl('data:text/html,x')).toMatchObject({
      kind: 'blocked',
      reason: 'unsupported-scheme'
    })
    expect(classifyExternalUrl('file:///tmp/x')).toMatchObject({
      kind: 'blocked',
      reason: 'unsupported-scheme'
    })
    expect(classifyExternalUrl('/relative/path')).toEqual({ kind: 'blocked', reason: 'invalid' })
    expect(classifyExternalUrl('')).toEqual({ kind: 'blocked', reason: 'empty' })
    expect(classifyExternalUrl(`https://example.com/${'a'.repeat(3000)}`)).toEqual({
      kind: 'blocked',
      reason: 'too-long'
    })
  })
})

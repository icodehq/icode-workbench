import { describe, expect, it } from 'vitest'
import { extractTerminalHttpLinks, TERMINAL_HTTP_URL_MAX_LENGTH } from './url-extraction'

describe('extractTerminalHttpLinks', () => {
  it('finds http and https URLs and drops trailing prose punctuation', () => {
    expect(extractTerminalHttpLinks('see https://example.com/docs.')).toEqual([
      {
        url: 'https://example.com/docs',
        startIndex: 4,
        endIndex: 28
      }
    ])
    expect(extractTerminalHttpLinks('http://example.com')?.[0]?.url).toBe(
      'http://example.com/'
    )
  })

  it('keeps CJK path characters and stops at CJK punctuation', () => {
    const links = extractTerminalHttpLinks('https://example.com/路径。next')
    expect(links).toHaveLength(1)
    expect(links[0]?.url).toContain('%E8%B7%AF%E5%BE%84')
  })

  it('supports bracketed IPv6 hosts', () => {
    expect(extractTerminalHttpLinks('http://[::1]:8080/x')?.[0]?.url).toBe(
      'http://[::1]:8080/x'
    )
  })

  it('ignores non-http schemes and URLs inside words', () => {
    expect(extractTerminalHttpLinks('javascript:alert(1)')).toEqual([])
    expect(extractTerminalHttpLinks('xhttps://example.com')).toEqual([])
    expect(extractTerminalHttpLinks('file:///tmp/x')).toEqual([])
  })

  it('caps URL length', () => {
    const long = `https://example.com/${'a'.repeat(TERMINAL_HTTP_URL_MAX_LENGTH)}`
    expect(extractTerminalHttpLinks(long)).toEqual([])
  })
})

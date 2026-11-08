import { describe, expect, it } from 'vitest'
import {
  ClaudeStreamParser,
  decodeJsonStringPrefix,
  extractReplyDraft
} from './assistant-stream'

function delta(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text }
    }
  })
}

describe('Claude stream parsing', () => {
  it('extracts a reply that is split across text deltas', () => {
    const parser = new ClaudeStreamParser()
    const first = parser.push(`${delta('{"reply":"Hel')}\n${delta('lo, world"')}\n`)
    expect(first.draft).toBe('Hello, world')
    const second = parser.push(
      `${delta(',"actions":[]}')}\n${JSON.stringify({
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 7
      })}\n`
    )
    expect(second.draft).toBe('Hello, world')
    expect(second.thinkingTokens).toBe(7)
  })

  it('keeps a chunk that ends in the middle of a UTF-16 escape', () => {
    const parser = new ClaudeStreamParser()
    expect(parser.push(`${delta('{"reply":"\\uD83D')}\n`).draft).toBe('')
    expect(parser.push(`${delta('\\uDE00 hi"}')}\n`).draft).toBe('😀 hi')
  })

  it('captures the final result event independently of accumulated stdout', () => {
    const parser = new ClaudeStreamParser()
    parser.push(
      `${JSON.stringify({
        type: 'result',
        is_error: false,
        result: '{"reply":"done","actions":[]}'
      })}\n`
    )
    expect(parser.result()).toEqual({
      text: '{"reply":"done","actions":[]}',
      error: null
    })

    const failed = new ClaudeStreamParser()
    failed.push(`${JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 503' })}\n`)
    expect(failed.result()).toEqual({ text: null, error: 'API Error: 503' })
  })

  it('decodes escaped quotes and newlines', () => {
    expect(decodeJsonStringPrefix('a\\"b\\nc\\\\d')).toBe('a"b\nc\\d')
    expect(extractReplyDraft('{"reply":"one\\ntwo"}')).toBe('one\ntwo')
  })
})

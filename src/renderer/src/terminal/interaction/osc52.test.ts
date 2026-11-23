import { describe, expect, it, vi } from 'vitest'
import { createOsc52Handler, parseOsc52 } from './osc52'

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

describe('parseOsc52', () => {
  it('decodes a clipboard write and defaults an empty selection to clipboard', () => {
    expect(parseOsc52(`;${b64('hello')}`)).toEqual({
      kind: 'write',
      selections: 'c',
      text: 'hello'
    })
    expect(parseOsc52(`c;${b64('héllo')}`)).toMatchObject({ kind: 'write', text: 'héllo' })
  })

  it('refuses queries, empty payloads, bad base64, and oversized payloads', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'query' })
    expect(parseOsc52('c;')).toMatchObject({ kind: 'invalid' })
    expect(parseOsc52('c;not-base64!')).toMatchObject({ kind: 'invalid' })
    expect(parseOsc52(`c;${'A'.repeat(20)}`, 10)).toMatchObject({ kind: 'invalid' })
  })

  it('accepts whitespace-wrapped base64', () => {
    expect(parseOsc52(`c;${b64('hello').replace(/(.{2})/gu, '$1\n')}`)).toMatchObject({
      kind: 'write',
      text: 'hello'
    })
  })
})

describe('createOsc52Handler', () => {
  it('writes when allowed and consumes the sequence', async () => {
    const write = vi.fn(async () => true)
    const handler = createOsc52Handler({ allowWrite: () => true, write })
    expect(handler(`c;${b64('copied')}`)).toBe(true)
    await Promise.resolve()
    expect(write).toHaveBeenCalledWith('copied')
  })

  it('blocks writes when disabled and still consumes queries', async () => {
    const write = vi.fn(async () => true)
    const blocked = vi.fn()
    const handler = createOsc52Handler({ allowWrite: () => false, write, onBlocked: blocked })
    handler(`c;${b64('copied')}`)
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()
    expect(blocked).toHaveBeenCalledOnce()
    expect(handler('c;?')).toBe(true)
  })
})

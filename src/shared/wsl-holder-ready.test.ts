import { describe, expect, it } from 'vitest'
import { parseWslHolderReady } from './wsl-holder-ready'

describe('WSL holder ready record', () => {
  it('accepts the WSL child PID', () => {
    expect(parseWslHolderReady('{"pid":4242}')).toEqual({ pid: 4242 })
  })

  it('accepts a wrapper failure with a bounded message', () => {
    const parsed = parseWslHolderReady(JSON.stringify({ error: 'x'.repeat(4_000) }))
    expect(parsed).toEqual({ error: 'x'.repeat(2_000) })
  })

  it.each([
    ['not json', 'not json'],
    ['empty', ''],
    ['null', 'null'],
    ['zero pid', '{"pid":0}'],
    ['fractional pid', '{"pid":4.5}'],
    ['string pid', '{"pid":"4"}'],
    ['no fields', '{}'],
    ['empty error', '{"error":"  "}']
  ])('rejects %s', (_name, text) => {
    expect(parseWslHolderReady(text)).toBeNull()
  })
})

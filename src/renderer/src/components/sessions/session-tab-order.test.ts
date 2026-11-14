import { describe, expect, it } from 'vitest'
import { moveSessionTab, orderSessionTabIds } from './session-tab-order'

describe('session tab order', () => {
  it('keeps a remembered order and drops stale IDs', () => {
    expect(orderSessionTabIds(['a', 'b', 'c'], ['c', 'gone', 'a'])).toEqual(['c', 'a', 'b'])
  })

  it('appends sessions that are not in the remembered order', () => {
    expect(orderSessionTabIds(['a', 'b', 'c', 'd'], ['b'])).toEqual(['b', 'a', 'c', 'd'])
  })

  it('deduplicates repeated IDs', () => {
    expect(orderSessionTabIds(['a', 'b'], ['a', 'a', 'b'])).toEqual(['a', 'b'])
  })

  it('moves a tab right and takes the target slot', () => {
    expect(moveSessionTab(['a', 'b', 'c'], 'a', 'b')).toEqual(['b', 'a', 'c'])
    expect(moveSessionTab(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
  })

  it('moves a tab left and takes the target slot', () => {
    expect(moveSessionTab(['a', 'b', 'c'], 'c', 'b')).toEqual(['a', 'c', 'b'])
    expect(moveSessionTab(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('leaves the order untouched for unknown or identical targets', () => {
    expect(moveSessionTab(['a', 'b'], 'a', 'a')).toEqual(['a', 'b'])
    expect(moveSessionTab(['a', 'b'], 'a', 'missing')).toEqual(['a', 'b'])
    expect(moveSessionTab(['a', 'b'], 'missing', 'a')).toEqual(['a', 'b'])
  })
})

import { describe, expect, it } from 'vitest'
import {
  mergeChoiceText,
  parseConflictBlocks,
  replaceConflictBlock
} from './merge-conflicts'

const DIFF3 = [
  'before',
  '<<<<<<< HEAD',
  'ours',
  '||||||| base',
  'base',
  '=======',
  'theirs',
  '>>>>>>> feature',
  'after',
  ''
].join('\n')

describe('parseConflictBlocks', () => {
  it('reads labels and all three sides', () => {
    const blocks = parseConflictBlocks(DIFF3)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      currentLabel: 'HEAD',
      baseLabel: 'base',
      incomingLabel: 'feature',
      current: 'ours\n',
      base: 'base\n',
      incoming: 'theirs\n',
      startLine: 2,
      endLine: 8
    })
    expect(blocks[0]?.marker.startsWith('<<<<<<< HEAD\n')).toBe(true)
    expect(blocks[0]?.marker.endsWith('>>>>>>> feature\n')).toBe(true)
  })

  it('handles merge conflicts without a base section', () => {
    const text = ['<<<<<<< ours', 'a', '=======', 'b', '>>>>>>> theirs', ''].join('\n')
    const blocks = parseConflictBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ base: null, baseLabel: null, current: 'a\n', incoming: 'b\n' })
  })

  it('finds multiple blocks and ignores incomplete markers', () => {
    const text = [
      '<<<<<<< one',
      'a',
      '=======',
      'b',
      '>>>>>>> one',
      'middle',
      '<<<<<<< two',
      'c',
      '=======',
      'd',
      '>>>>>>> two',
      'tail',
      '<<<<<<< unfinished',
      'x',
      ''
    ].join('\n')
    const blocks = parseConflictBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[1]?.startLine).toBe(7)
    expect(blocks[1]?.currentLabel).toBe('two')
  })

  it('preserves CRLF while parsing markers', () => {
    const text = DIFF3.replace(/\n/g, '\r\n')
    const blocks = parseConflictBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.current).toBe('ours\r\n')
    expect(blocks[0]?.incoming).toBe('theirs\r\n')
  })

  it('reads a final marker without a trailing newline', () => {
    const text = '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs'
    const blocks = parseConflictBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.incoming).toBe('b\n')
    expect(blocks[0]?.end).toBe(text.length)
  })

  it('returns no blocks for plain text', () => {
    expect(parseConflictBlocks('nothing here\n')).toEqual([])
    expect(parseConflictBlocks('')).toEqual([])
  })
})

describe('replaceConflictBlock', () => {
  it('replaces only the chosen block', () => {
    const text = [
      '<<<<<<< one',
      'a',
      '=======',
      'b',
      '>>>>>>> one',
      'keep',
      '<<<<<<< two',
      'c',
      '=======',
      'd',
      '>>>>>>> two',
      ''
    ].join('\n')
    const [first] = parseConflictBlocks(text)
    const next = replaceConflictBlock(text, first!, 'incoming')
    expect(next).toContain('b\nkeep')
    expect(next).toContain('<<<<<<< two')
    expect(next).not.toContain('<<<<<<< one')
  })

  it('accepts both sides with a separating newline', () => {
    const block = parseConflictBlocks(['<<<<<<< a', 'one', '=======', 'two', '>>>>>>> b', ''].join('\n'))[0]!
    expect(mergeChoiceText(block, 'both')).toBe('one\ntwo\n')
    const withoutNewline = {
      ...block,
      current: 'one',
      incoming: 'two'
    }
    expect(mergeChoiceText(withoutNewline, 'both')).toBe('one\ntwo')
  })

  it('preserves the rest of a CRLF file', () => {
    const text = DIFF3.replace(/\n/g, '\r\n')
    const block = parseConflictBlocks(text)[0]!
    const next = replaceConflictBlock(text, block, 'current')
    expect(next.startsWith('before\r\nours\r\nafter')).toBe(true)
  })
})

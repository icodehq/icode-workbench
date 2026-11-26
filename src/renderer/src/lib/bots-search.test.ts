import { describe, expect, it } from 'vitest'
import {
  botsSearchSegments,
  matchBotsSearchFields,
  matchBotsSearchText,
  parseBotsSearchQuery
} from './bots-search'

describe('bots search', () => {
  it('normalizes case, accents and whitespace', () => {
    expect(parseBotsSearchQuery('  Résumé  ')).toEqual({
      phrase: 'resume',
      tokens: ['resume']
    })
    expect(parseBotsSearchQuery('   ')).toBeNull()
  })

  it('matches substrings and every word as a word prefix', () => {
    expect(matchBotsSearchText('Reviewer', 'view')).toBe(true)
    expect(matchBotsSearchText('Eng - Reviewer', 'rev eng')).toBe(true)
    expect(matchBotsSearchText('Eng - Reviewer', 'eng rev')).toBe(true)
    expect(matchBotsSearchText('Engineer', 'eng rev')).toBe(false)
  })

  it('matches accent-folded names', () => {
    expect(matchBotsSearchText('Ingénieur', 'ingenieur')).toBe(true)
    expect(matchBotsSearchText('ΑΣ', 'ασ')).toBe(true)
  })

  it('matches any supplied field and treats an empty query as everything', () => {
    expect(matchBotsSearchFields(['Backend', 'Engineer'], 'eng')).toBe(true)
    expect(matchBotsSearchFields(['Backend', 'Engineer'], 'designer')).toBe(false)
    expect(matchBotsSearchFields([null, 'Reviewer'], '')).toBe(true)
  })
})

describe('bots search highlighting', () => {
  it('marks phrase and word-prefix matches with their source offsets', () => {
    expect(botsSearchSegments('Ingénieur', 'ingenieur')).toEqual([
      { text: 'Ingénieur', marked: true }
    ])
    expect(botsSearchSegments('Eng - Reviewer', 'rev eng')).toEqual([
      { text: 'Eng', marked: true },
      { text: ' - ', marked: false },
      { text: 'Rev', marked: true },
      { text: 'iewer', marked: false }
    ])
  })

  it('returns one plain segment when nothing matches', () => {
    expect(botsSearchSegments('Engineer', 'eng rev')).toEqual([
      { text: 'Engineer', marked: false }
    ])
    expect(botsSearchSegments('Engineer', '')).toEqual([
      { text: 'Engineer', marked: false }
    ])
  })
})

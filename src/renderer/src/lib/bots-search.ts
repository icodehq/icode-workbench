/**
 * The Bots search uses case- and accent-insensitive substring matching, or
 * every query word starting a word of the text in any order.
 * A filter hides everything else, so a typo should read as a miss, never as a
 * surprising near-match.
 */

export type BotsSearchQuery = { phrase: string; tokens: string[] }

export function foldBotsSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
}

export function parseBotsSearchQuery(query: string): BotsSearchQuery | null {
  const phrase = foldBotsSearchText(query.trim())
  if (phrase.length === 0) return null
  return { phrase, tokens: phrase.split(/\s+/u).filter(Boolean) }
}

export function matchBotsSearchText(text: string, query: string): boolean {
  const parsed = parseBotsSearchQuery(query)
  if (parsed === null) return true
  const folded = foldBotsSearchText(text)
  if (folded.includes(parsed.phrase)) return true
  if (parsed.tokens.length < 2) return false
  const words = folded.match(/[\p{L}\p{N}]+/gu) ?? []
  return parsed.tokens.every((token) => words.some((word) => word.startsWith(token)))
}

export function matchBotsSearchFields(
  fields: readonly (string | null | undefined)[],
  query: string
): boolean {
  if (parseBotsSearchQuery(query) === null) return true
  return fields.some((field) => field !== null && field !== undefined && matchBotsSearchText(field, query))
}

export type BotsSearchSegment = { text: string; marked: boolean }

type FoldedText = { folded: string; starts: number[]; ends: number[] }

function foldWithMap(text: string): FoldedText {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let index = 0
  while (index < text.length) {
    const codePoint = text.codePointAt(index)!
    let end = index + (codePoint > 0xffff ? 2 : 1)
    while (end < text.length) {
      const next = text.codePointAt(end)!
      if (!/\p{M}/u.test(String.fromCodePoint(next))) break
      end += next > 0xffff ? 2 : 1
    }
    const chunk = foldBotsSearchText(text.slice(index, end))
    for (let unit = 0; unit < chunk.length; unit += 1) {
      starts.push(index)
      ends.push(end)
    }
    folded += chunk
    index = end
  }
  return { folded, starts, ends }
}

/** Highlights the same matches the filter uses, mapped back to the original text. */
export function botsSearchSegments(text: string, query: string): BotsSearchSegment[] {
  const parsed = parseBotsSearchQuery(query)
  if (parsed === null) return [{ text, marked: false }]
  const mapped = foldWithMap(text)
  const ranges: Array<{ start: number; end: number }> = []
  const phraseAt = mapped.folded.indexOf(parsed.phrase)
  if (phraseAt !== -1) {
    ranges.push({ start: phraseAt, end: phraseAt + parsed.phrase.length })
  } else if (parsed.tokens.length >= 2) {
    const words = [...mapped.folded.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match.index!)
    for (const token of parsed.tokens) {
      const at = words.find((wordStart) => mapped.folded.startsWith(token, wordStart))
      if (at === undefined) return [{ text, marked: false }]
      ranges.push({ start: at, end: at + token.length })
    }
  }
  if (ranges.length === 0) return [{ text, marked: false }]
  const source = ranges
    .map((range) => ({
      start: mapped.starts[range.start]!,
      end: mapped.ends[range.end - 1]!
    }))
    .sort((left, right) => left.start - right.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of source) {
    const last = merged.at(-1)
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  const parts: BotsSearchSegment[] = []
  let at = 0
  for (const range of merged) {
    if (range.start > at) parts.push({ text: text.slice(at, range.start), marked: false })
    parts.push({ text: text.slice(range.start, range.end), marked: true })
    at = range.end
  }
  if (at < text.length) parts.push({ text: text.slice(at), marked: false })
  return parts
}

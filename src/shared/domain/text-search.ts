/**
 * Shared literal/regex matching for Files search and bounded replace.
 *
 * Whole-word uses ASCII word characters in Phase C; it is applied the same way
 * for local and guest searches so the two hosts agree.
 */

export type TextMatchOptions = {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

const WORD = /[A-Za-z0-9_]/u

function isWordAt(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) return false
  return WORD.test(value[index] ?? '')
}

function literalIndex(
  line: string,
  needle: string,
  start: number,
  wholeWord: boolean
): number {
  let index = line.indexOf(needle, start)
  while (index !== -1) {
    if (
      !wholeWord ||
      (!isWordAt(line, index - 1) && !isWordAt(line, index + needle.length))
    ) {
      return index
    }
    index = line.indexOf(needle, index + 1)
  }
  return -1
}

export type CompiledTextMatcher = {
  /** 0-based column of the first match on a line, or -1. */
  match(line: string): number
  error: string | null
}

export function compileTextMatcher(
  query: string,
  options: TextMatchOptions
): CompiledTextMatcher {
  if (options.regex) {
    let regex: RegExp
    try {
      const source = options.wholeWord ? `\\b(?:${query})\\b` : query
      regex = new RegExp(source, options.caseSensitive ? 'u' : 'iu')
    } catch (error) {
      return {
        match: () => -1,
        error: error instanceof Error ? error.message : 'That regular expression is not valid.'
      }
    }
    return {
      match: (line) => {
        const result = regex.exec(line)
        return result === null ? -1 : result.index
      },
      error: null
    }
  }
  const needle = options.caseSensitive ? query : query.toLowerCase()
  return {
    match: (line) => {
      const haystack = options.caseSensitive ? line : line.toLowerCase()
      return literalIndex(haystack, needle, 0, options.wholeWord)
    },
    error: null
  }
}

export function replaceLiteralAll(
  text: string,
  query: string,
  replacement: string,
  options: { caseSensitive: boolean; wholeWord: boolean }
): { text: string; count: number } {
  if (query.length === 0) return { text, count: 0 }
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const source = options.wholeWord ? `\\b(?:${escaped})\\b` : escaped
  const regex = new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
  let cursor = 0
  let count = 0
  let output = ''
  for (const match of text.matchAll(regex)) {
    const index = match.index
    if (index === undefined) continue
    output += text.slice(cursor, index) + replacement
    cursor = index + match[0].length
    count += 1
  }
  output += text.slice(cursor)
  return { text: output, count }
}

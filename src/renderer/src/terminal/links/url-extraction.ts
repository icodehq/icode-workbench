/**
 * HTTP(S) URL detection in terminal text.
 *
 * Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
 * `shared/terminal/links/terminal-http-url-extraction.ts`,
 * `terminal-http-link-limits.ts`, and `shared/text/prose-url-boundary.ts`.
 */

export const TERMINAL_HTTP_URL_MAX_LENGTH = 2048

export type ParsedTerminalHttpLink = {
  url: string
  startIndex: number
  endIndex: number
}

// Punctuation, brackets, quotes and sentence marks end a prose URL; CJK
// punctuation included. Titles keep `・`, `–` and `·` unencoded in a path.
const PROSE_URL_TERMINATOR_SOURCE = String.raw`(?![\0-\x7f])[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Z}、。，．！？：；｡､…‥—]`
const NOT_PROSE_URL_TERMINATOR = `(?!${PROSE_URL_TERMINATOR_SOURCE})`
const IPV6_HTTP_HOST_SOURCE = String.raw`(?:(?:${NOT_PROSE_URL_TERMINATOR}[^\s"'!*(){}|\\^<>\x60\/?#\[\]])*@)?\[[\dA-Fa-f:.]+\]`
const PROSE_HTTP_URL_BODY_SOURCE =
  String.raw`(?:${NOT_PROSE_URL_TERMINATOR}[^\s"'!*(){}|\\^<>\x60])*` +
  String.raw`${NOT_PROSE_URL_TERMINATOR}[^\s"':,.!?{}|\\^~\[\]\x60()<>]`
const PROSE_HTTP_URL_SOURCE = String.raw`https?:\/\/(?:${IPV6_HTTP_HOST_SOURCE}(?:${PROSE_HTTP_URL_BODY_SOURCE})?|${PROSE_HTTP_URL_BODY_SOURCE})`

const PROSE_URL_TERMINATOR = new RegExp(PROSE_URL_TERMINATOR_SOURCE, 'u')
const IPV6_HTTP_AUTHORITY = new RegExp(String.raw`^https?:\/\/${IPV6_HTTP_HOST_SOURCE}`, 'iu')

export const TERMINAL_HTTP_URL_REGEX = new RegExp(PROSE_HTTP_URL_SOURCE, 'iu')

export function isProseUrlTerminator(char: string): boolean {
  return PROSE_URL_TERMINATOR.test(char)
}

export function extractTerminalHttpLinks(lineText: string): ParsedTerminalHttpLink[] {
  const links: ParsedTerminalHttpLink[] = []
  for (const candidate of iterateTerminalHttpUrlCandidates(lineText)) {
    let parsed: URL
    try {
      parsed = new URL(candidate.url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    links.push({
      url: parsed.toString(),
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex
    })
  }
  return links
}

function* iterateTerminalHttpUrlCandidates(
  lineText: string
): Generator<{ url: string; startIndex: number; endIndex: number }> {
  let searchStart = 0
  while (searchStart < lineText.length) {
    const startIndex = findNextHttpSchemeIndex(lineText, searchStart)
    if (startIndex === -1) return
    if (!hasHttpUrlWordBoundary(lineText, startIndex)) {
      searchStart = startIndex + 1
      continue
    }
    const rawEndIndex = findHttpUrlCandidateEnd(lineText, startIndex)
    const endIndex = trimHttpUrlTrailingPunctuation(lineText, startIndex, rawEndIndex)
    searchStart = Math.max(rawEndIndex, startIndex + 1)
    if (endIndex <= startIndex || rawEndIndex - startIndex > TERMINAL_HTTP_URL_MAX_LENGTH) {
      continue
    }
    yield {
      url: lineText.slice(startIndex, endIndex),
      startIndex,
      endIndex
    }
  }
}

function findNextHttpSchemeIndex(lineText: string, searchStart: number): number {
  const relativeIndex = lineText.slice(searchStart).search(/https?:\/\//iu)
  return relativeIndex === -1 ? -1 : searchStart + relativeIndex
}

function hasHttpUrlWordBoundary(lineText: string, startIndex: number): boolean {
  return startIndex === 0 || !isAsciiWordCode(lineText.charCodeAt(startIndex - 1))
}

function findHttpUrlCandidateEnd(lineText: string, startIndex: number): number {
  const scanEnd = Math.min(lineText.length, startIndex + TERMINAL_HTTP_URL_MAX_LENGTH + 1)
  for (let index = startIndex; index < scanEnd; index += 1) {
    if (isHttpUrlBodyTerminator(lineText.charCodeAt(index))) return index
  }
  return scanEnd
}

function trimHttpUrlTrailingPunctuation(
  lineText: string,
  startIndex: number,
  rawEndIndex: number
): number {
  const minEndIndex =
    startIndex +
    (IPV6_HTTP_AUTHORITY.exec(lineText.slice(startIndex, rawEndIndex))?.[0].length ?? 0)
  let endIndex = rawEndIndex
  while (
    endIndex > minEndIndex &&
    isHttpUrlTrailingPunctuation(lineText.charCodeAt(endIndex - 1))
  ) {
    endIndex -= 1
  }
  return endIndex
}

function isHttpUrlBodyTerminator(code: number): boolean {
  return (
    (code > 0x7f && isProseUrlTerminator(String.fromCharCode(code))) ||
    isAsciiWhitespace(code) ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x21 ||
    code === 0x2a ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x7b ||
    code === 0x7d ||
    code === 0x7c ||
    code === 0x5c ||
    code === 0x5e ||
    code === 0x3c ||
    code === 0x3e ||
    code === 0x60
  )
}

function isHttpUrlTrailingPunctuation(code: number): boolean {
  return (
    isAsciiWhitespace(code) ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x3a ||
    code === 0x2c ||
    code === 0x2e ||
    code === 0x21 ||
    code === 0x3f ||
    code === 0x7b ||
    code === 0x7d ||
    code === 0x7c ||
    code === 0x5c ||
    code === 0x5e ||
    code === 0x7e ||
    code === 0x5b ||
    code === 0x5d ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x3c ||
    code === 0x3e ||
    code === 0x60
  )
}

function isAsciiWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32
}

function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  )
}

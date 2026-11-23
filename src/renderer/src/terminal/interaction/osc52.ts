/**
 * OSC 52 — clipboard writes from terminal programs.
 *
 * Adapted from Orca's `shared/terminal/clipboard/osc52-clipboard.ts`
 * (MIT, Copyright (c) 2026 Lovecast Inc.), trimmed to iCode's renderer-only
 * clipboard boundary. Queries are deliberately refused so a program cannot
 * read the clipboard; writes are gated by settings and capped.
 */

export type Osc52ParseResult =
  | { kind: 'write'; selections: string; text: string }
  | { kind: 'query' }
  | { kind: 'invalid'; reason: string }

const DEFAULT_MAX_BASE64_CHARS = 128 * 1024

export function parseOsc52(
  data: string,
  maxBase64Chars = DEFAULT_MAX_BASE64_CHARS
): Osc52ParseResult {
  const separator = data.indexOf(';')
  if (separator === -1) return { kind: 'invalid', reason: 'missing separator' }
  const selections = data.slice(0, separator) || 'c'
  const payload = data.slice(separator + 1)
  if (!/^[cpqs0-7]+$/u.test(selections)) {
    return { kind: 'invalid', reason: 'unknown selection kind' }
  }
  if (payload === '?') return { kind: 'query' }
  if (payload.length > maxBase64Chars) {
    return { kind: 'invalid', reason: 'payload exceeds size limit' }
  }
  const text = decodeBase64Utf8(payload)
  if (text === null) return { kind: 'invalid', reason: 'payload is not base64' }
  // XTerm uses an empty payload to clear the selection; refuse it rather than
  // letting a PTY blank the user's clipboard.
  if (text.length === 0) return { kind: 'invalid', reason: 'empty payload' }
  return { kind: 'write', selections, text }
}

type Osc52HandlerOptions = {
  allowWrite: () => boolean
  write: (text: string) => Promise<boolean>
  onBlocked?: () => void
  onFailure?: () => void
  maxBase64Chars?: number
}

export function createOsc52Handler(
  options: Osc52HandlerOptions
): (data: string) => boolean {
  let pending: string | null = null
  let flushScheduled = false

  const flush = (): void => {
    flushScheduled = false
    const text = pending
    pending = null
    if (text === null) return
    try {
      void options.write(text).then(
        (written) => {
          if (!written) options.onFailure?.()
        },
        () => options.onFailure?.()
      )
    } catch {
      options.onFailure?.()
    }
  }

  return (data) => {
    const parsed = parseOsc52(data, options.maxBase64Chars)
    if (parsed.kind !== 'write') return true
    if (!options.allowWrite()) {
      options.onBlocked?.()
      return true
    }
    // A hostile stream can issue many writes in one parse; keep the newest.
    pending = parsed.text
    if (!flushScheduled) {
      flushScheduled = true
      queueMicrotask(flush)
    }
    return true
  }
}

function decodeBase64Utf8(value: string): string | null {
  const normalized = normalizeBase64Payload(value)
  if (normalized === null) return null
  try {
    const binary = atob(normalized)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

function normalizeBase64Payload(value: string): string | null {
  let stripped = ''
  let sawWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isWhitespaceCode(code)) {
      if (!sawWhitespace) {
        stripped = value.slice(0, index)
        sawWhitespace = true
      }
      continue
    }
    if (!isBase64Code(code)) return null
    if (sawWhitespace) stripped += value[index]
  }
  return sawWhitespace ? stripped : value
}

function isBase64Code(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47 ||
    code === 61
  )
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13)
}

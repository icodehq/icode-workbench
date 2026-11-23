/**
 * URL routing policy for terminal links.
 *
 * Only http(s) reaches the OS browser. `javascript:`, `data:`, `file:`, custom
 * schemes, relative strings, and oversized payloads are blocked here and again
 * at the main-process IPC boundary.
 */

export const TERMINAL_EXTERNAL_URL_MAX_LENGTH = 2048

export type ExternalUrlDecision =
  | { kind: 'http'; url: string }
  | { kind: 'blocked'; reason: 'empty' | 'too-long' | 'invalid' | 'unsupported-scheme' }

export function classifyExternalUrl(
  raw: string,
  maxLength = TERMINAL_EXTERNAL_URL_MAX_LENGTH
): ExternalUrlDecision {
  const value = raw.trim()
  if (value.length === 0) return { kind: 'blocked', reason: 'empty' }
  if (value.length > maxLength) return { kind: 'blocked', reason: 'too-long' }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { kind: 'blocked', reason: 'invalid' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'blocked', reason: 'unsupported-scheme' }
  }
  return { kind: 'http', url: parsed.toString() }
}

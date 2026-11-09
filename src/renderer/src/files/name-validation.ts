import { translate } from '../i18n/i18n-store'
/**
 * Client-side name checks for inline create/rename.
 *
 * Main remains authoritative: host-specific invalid names and case-insensitive
 * collisions come back from the filesystem and are shown in the same row. This
 * module only covers the rules every supported host agrees on, so the user gets
 * an error before a round trip.
 */

export type NameCheck = {
  error: string | null
  warning: string | null
}

export function checkEntryName(
  value: string,
  options: { siblings: readonly string[]; previousName?: string } = { siblings: [] }
): NameCheck {
  if (value.length === 0) return { error: translate('fileName.required'), warning: null }
  if (value.trim().length === 0) {
    return { error: 'A name cannot be only whitespace.', warning: null }
  }
  if (value.includes('/') || value.includes('\\')) {
    return { error: translate('fileName.separators'), warning: null }
  }
  if (value === '.' || value === '..') {
    return { error: translate('fileName.invalid'), warning: null }
  }
  if (value.includes('\u0000')) return { error: translate('fileName.invalid'), warning: null }

  if (options.siblings.some((sibling) => sibling === value && sibling !== options.previousName)) {
    return { error: translate('fileName.exists', { name: value }), warning: null }
  }

  if (/^\s|\s$/u.test(value)) {
    return {
      error: null,
      warning: translate('fileName.whitespace')
    }
  }
  return { error: null, warning: null }
}

/** File renames select the basename and leave the extension untouched. */
export function nameSelectionRange(name: string, isDirectory: boolean): [number, number] {
  if (isDirectory) return [0, name.length]
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [0, name.length]
  return [0, dot]
}

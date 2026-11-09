import type { Locale } from './locales'

export function formatDateTime(
  locale: Locale,
  value: number | Date,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }
): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, options).format(date)
}

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale, options).format(value)
}

export function formatList(
  locale: Locale,
  values: readonly string[],
  type: Intl.ListFormatType = 'conjunction'
): string {
  return new Intl.ListFormat(locale, { type }).format(values)
}

/** Compact, locale-aware relative time used by history and task surfaces. */
export function formatRelativeTime(
  locale: Locale,
  value: number | Date,
  now = Date.now()
): string {
  const date = value instanceof Date ? value : new Date(value)
  const seconds = Math.round((date.getTime() - now) / 1000)
  if (!Number.isFinite(seconds)) return ''
  const absolute = Math.abs(seconds)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (absolute < 45) return formatter.format(0, 'second')
  if (absolute < 60 * 60) return formatter.format(Math.round(seconds / 60), 'minute')
  if (absolute < 60 * 60 * 24) return formatter.format(Math.round(seconds / 3600), 'hour')
  if (absolute < 60 * 60 * 24 * 30) {
    return formatter.format(Math.round(seconds / (60 * 60 * 24)), 'day')
  }
  if (absolute < 60 * 60 * 24 * 365) {
    return formatter.format(Math.round(seconds / (60 * 60 * 24 * 30)), 'month')
  }
  return formatter.format(Math.round(seconds / (60 * 60 * 24 * 365)), 'year')
}

import type { AppError } from '../domain/errors'
import type { Locale } from './locales'
import { hasMessage, t } from './messages'
import type { MessageKey } from './messages'

/**
 * Returns the error with its message in `locale` when it carries a catalog key.
 * Legacy errors, and keys that no longer exist, keep their English message:
 * persisted history is never rewritten into a missing-key string.
 */
export function localizeAppError(error: AppError, locale: Locale): AppError {
  if (error.messageKey !== undefined && hasMessage('en', error.messageKey)) {
    return {
      ...error,
      message: t(locale, error.messageKey, error.messageParams)
    }
  }
  // English keeps the specific service message. Other locales use the code's
  // short fallback, or a generic sentence when the code has no entry yet; the
  // English text and diagnostics remain in `detail`/logs where applicable.
  if (locale === 'en') return error
  const codeKey = `errors.${error.code}` as MessageKey
  const key = hasMessage(locale, codeKey) ? codeKey : 'errors.generic'
  return { ...error, message: t(locale, key) }
}

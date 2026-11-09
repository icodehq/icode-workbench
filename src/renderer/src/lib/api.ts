import { makeAppError, type AppError } from '../../../shared/domain/errors'
import { localizeAppError } from '../../../shared/i18n'
import type { IpcResult } from '../../../shared/schemas/ipc'
import type { Notice } from '../state/workspace'
import { getLocale } from '../i18n/i18n-store'

/**
 * IPC rejections are not part of the typed contract, but a missing handler or a
 * torn-down window still rejects. Normalize them so every caller handles one
 * result shape.
 */
export async function callApi<T>(call: Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  try {
    return await call
  } catch (error) {
    return {
      ok: false,
      error: makeAppError('INTERNAL', 'The iCode service did not respond.', {
        detail: error instanceof Error ? error.message : String(error),
        messageKey: 'errors.serviceNoResponse'
      })
    }
  }
}

export function errorNotice(error: AppError): Notice {
  const localized = localizeAppError(error, getLocale())
  return {
    tone: 'error',
    message: localized.message,
    ...(localized.detail ? { detail: localized.detail } : {})
  }
}

export function isAbsolutePathLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

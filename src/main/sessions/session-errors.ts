import { appErrorFromHostFailure, makeAppError } from '../../shared/domain/errors'
import type { AppError } from '../../shared/domain/errors'
import { HostRequestError } from '../host/host-client'

export class SessionServiceError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message)
    this.name = 'SessionServiceError'
  }
}

/** Maps host transport/protocol failures to the stable app error vocabulary. */
export function errorFromHost(error: unknown, fallbackMessage: string): AppError {
  if (error instanceof SessionServiceError) return error.appError
  if (error instanceof HostRequestError) {
    if (
      error.code === 'HOST_TIMEOUT' ||
      error.code === 'HOST_CONNECT_FAILED' ||
      error.code === 'HOST_UNREACHABLE'
    ) {
      return makeAppError('HOST_UNREACHABLE', 'The terminal host is not reachable.', {
        detail: error.message,
        context: error.detail ? { detail: error.detail } : undefined
      })
    }
    if (error.code === 'HOST_PROTOCOL_ERROR') {
      return makeAppError('HOST_PROTOCOL_MISMATCH', 'The terminal host protocol is incompatible.', {
        detail: error.message
      })
    }
    return appErrorFromHostFailure({ code: error.code, message: error.message, detail: error.detail })
  }
  return makeAppError('INTERNAL', fallbackMessage, {
    detail: error instanceof Error ? error.message : String(error)
  })
}

/**
 * The one-message ready file the hidden WSL holder wrapper writes back.
 *
 * Kept in shared code so the wrapper and the process that records the holder
 * cannot disagree about the format. Nothing here is user-facing.
 */

export type WslHolderReady = { pid: number } | { error: string }

export const WSL_HOLDER_READY_ENV = 'ADE_WSL_HOLDER_READY_FILE'
export const WSL_HOLDER_WSL_ENV = 'ADE_WSL_HOLDER_WSL'
export const WSL_HOLDER_ARGS_ENV = 'ADE_WSL_HOLDER_ARGS'
export const WSL_HOLDER_CWD_ENV = 'ADE_WSL_HOLDER_CWD'

const MAX_ERROR_LENGTH = 2_000

/**
 * Parses a ready file. A file is written atomically, so a parse failure is a
 * malformed record rather than a partially written one and must not be retried
 * forever.
 */
export function parseWslHolderReady(text: string): WslHolderReady | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.error === 'string' && record.error.trim().length > 0) {
    return { error: record.error.slice(0, MAX_ERROR_LENGTH) }
  }
  if (
    typeof record.pid === 'number' &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0
  ) {
    return { pid: record.pid }
  }
  return null
}

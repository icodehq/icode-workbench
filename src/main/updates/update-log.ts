import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  appendFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'

/**
 * A tiny file logger for the update subsystem.
 *
 * Packaged GUI launches have no usable stdout on Windows, so every
 * `electron-updater` and `[updates]` message was lost unless the user happened
 * to start iCode from a terminal. A single rotating file keeps the installer
 * spawn errors, feed failures and teardown decisions diagnosable.
 */

export type UpdateLogger = {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

export const UPDATE_LOG_MAX_BYTES = 2 * 1024 * 1024

export function createUpdateLogger(
  filePath: string,
  options: { maxBytes?: number; now?: () => number } = {}
): UpdateLogger {
  const maxBytes = options.maxBytes ?? UPDATE_LOG_MAX_BYTES
  const now = options.now ?? Date.now
  let directoryReady = false

  function write(level: string, args: unknown[]): void {
    try {
      if (!directoryReady) {
        mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
        directoryReady = true
      }
      try {
        if (existsSync(filePath) && statSync(filePath).size >= maxBytes) {
          const rotated = `${filePath}.1`
          if (existsSync(rotated)) rmSync(rotated, { force: true })
          renameSync(filePath, rotated)
        }
      } catch {
        // A rotation failure must not lose the line we are about to write.
      }
      const timestamp = new Date(now()).toISOString()
      appendFileSync(filePath, `${timestamp} ${level} ${format(...args)}\n`, {
        mode: 0o600
      })
    } catch {
      // A full or read-only disk must never break the update flow.
    }
  }

  return {
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
    debug: (...args) => write('DEBUG', args)
  }
}

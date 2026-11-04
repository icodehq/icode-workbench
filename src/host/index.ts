import { WSL_HOLDER_READY_ENV } from '../shared/wsl-holder-ready'
import { createTerminalHost, hostPathsFromEnv } from './server'
import { runWslHolderFromEnv } from './wsl-holder'

/**
 * Host entry with two modes.
 *
 * The normal mode is the detached terminal host. The WSL holder wrapper is the
 * same bundle launched as a GUI-subsystem Electron process; it starts the
 * background WSL holder without giving it a visible console. The wrapper is
 * selected by its ready-file environment, which only `spawnDetachedHolder`
 * supplies.
 */
if (process.env[WSL_HOLDER_READY_ENV]) {
  runWslHolderFromEnv(process.env)
} else {
  try {
    if (!process.env.ICODE_HOST_DIR) {
      throw new Error('ICODE_HOST_DIR is required')
    }
    const paths = hostPathsFromEnv(process.env)
    // Platform-appropriate default; SHELL is honoured first when a user sets it.
    const shell =
      process.env.SHELL ||
      (process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/bash')
    createTerminalHost({ paths, shell })
  } catch (error) {
    // A failed host must be diagnosable from its own log directory.
    const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error)
    try {
      if (process.env.ICODE_HOST_DIR) {
        const { appendFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
        const { join } = require('node:path') as typeof import('node:path')
        mkdirSync(process.env.ICODE_HOST_DIR, { recursive: true, mode: 0o700 })
        appendFileSync(join(process.env.ICODE_HOST_DIR, 'host.log'), `${new Date().toISOString()} ${message}\n`)
      }
    } catch {
      // no log directory available
    }
    process.stderr.write(`[icode-host] ${message}\n`)
    process.exit(1)
  }
}

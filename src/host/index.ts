import { createTerminalHost, hostPathsFromEnv } from './server'

/**
 * Detached terminal host entry.
 *
 * Launched with ELECTRON_RUN_AS_NODE=1 so node-pty loads the Electron-ABI
 * native module. It owns PTYs independently of the ADE window.
 */
try {
  if (!process.env.ADE_HOST_DIR) {
    throw new Error('ADE_HOST_DIR is required')
  }
  const paths = hostPathsFromEnv(process.env)
  const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : '/bin/bash'
  createTerminalHost({ paths, shell })
} catch (error) {
  // A failed host must be diagnosable from its own log directory.
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error)
  try {
    if (process.env.ADE_HOST_DIR) {
      const { appendFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
      const { join } = require('node:path') as typeof import('node:path')
      mkdirSync(process.env.ADE_HOST_DIR, { recursive: true, mode: 0o700 })
      appendFileSync(join(process.env.ADE_HOST_DIR, 'host.log'), `${new Date().toISOString()} ${message}\n`)
    }
  } catch {
    // no log directory available
  }
  process.stderr.write(`[ade-host] ${message}\n`)
  process.exit(1)
}

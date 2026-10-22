'use strict'

/**
 * Rebuild node-pty against the pinned Electron ABI.
 * Why: the detached host runs under ELECTRON_RUN_AS_NODE, so the native module
 * must match Electron's ABI, not the workstation Node ABI.
 */

const path = require('node:path')
const { rebuild } = require('@electron/rebuild')

const projectDir = path.resolve(__dirname, '..')
const electronVersion = require(path.join(projectDir, 'node_modules/electron/package.json')).version

rebuild({
  buildPath: projectDir,
  electronVersion,
  arch: process.arch,
  onlyModules: ['node-pty'],
  force: true
})
  .then(() => {
    process.stdout.write(`[ade] node-pty rebuilt for Electron ${electronVersion}\n`)
  })
  .catch((error) => {
    process.stderr.write(`[ade] native rebuild failed: ${String(error)}\n`)
    process.exit(1)
  })

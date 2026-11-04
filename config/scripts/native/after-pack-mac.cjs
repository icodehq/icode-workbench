'use strict'

/**
 * electron-builder hook: make node-pty's Darwin spawn-helper executable in the
 * packed app before signing/dmg creation.
 *
 * The source prebuild is repaired by `mac-pty-modes.cjs` at install/package
 * time, but asar extraction is not guaranteed to preserve Unix mode bits.
 * Verifying the packed file here keeps a dmg from shipping a PTY that fails
 * with "posix_spawnp failed".
 */

const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

module.exports = async function afterPack(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`
  const prebuilds = join(
    context.appOutDir,
    appName,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds'
  )
  if (!existsSync(prebuilds)) {
    throw new Error(`node-pty prebuilds are missing from the packaged app: ${prebuilds}`)
  }
  let repaired = 0
  for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('darwin-')) continue
    const helper = join(prebuilds, entry.name, 'spawn-helper')
    if (!existsSync(helper)) continue
    chmodSync(helper, 0o755)
    repaired += 1
  }
  if (repaired === 0) {
    throw new Error(`no Darwin node-pty spawn-helper found under ${prebuilds}`)
  }
}

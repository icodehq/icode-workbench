'use strict'

/**
 * electron-builder afterPack repair for node-pty.
 *
 * Two packaging problems exist only in the packed app:
 *
 * 1. The Darwin `spawn-helper` is executable in source (repaired at install
 *    time), but asar extraction does not guarantee the mode bit.
 * 2. The detached Host runs with ELECTRON_RUN_AS_NODE, where asar support is
 *    unavailable. node-pty's JS is therefore unpacked and its `__dirname`
 *    already contains `app.asar.unpacked`; its call to
 *    `replace('app.asar', 'app.asar.unpacked')` then corrupts the helper path
 *    to `app.asar.unpacked.unpacked`, so every PTY fails with
 *    "posix_spawnp failed". Anchor the replacement so it only expands an asar
 *    path that is not already unpacked.
 */

const { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

function patchNodePtyHelperPath(unpacked) {
  const file = join(unpacked, 'node_modules', 'node-pty', 'lib', 'unixTerminal.js')
  if (!existsSync(file)) return false
  const source = readFileSync(file, 'utf8')
  const fixed = source
    .replace(
      "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked');"
    )
    .replace(
      "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
      "helperPath = helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked');"
    )
  if (fixed !== source) writeFileSync(file, fixed)
  return true
}

function repairDarwinHelpers(unpacked) {
  const prebuilds = join(unpacked, 'node_modules', 'node-pty', 'prebuilds')
  if (!existsSync(prebuilds)) return 0
  let repaired = 0
  for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('darwin-')) continue
    const helper = join(prebuilds, entry.name, 'spawn-helper')
    if (!existsSync(helper)) continue
    chmodSync(helper, 0o755)
    repaired += 1
  }
  return repaired
}

module.exports = async function afterPack(context) {
  const isMac = context.electronPlatformName === 'darwin'
  const resources = isMac
    ? join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources'
      )
    : join(context.appOutDir, 'resources')
  const unpacked = join(resources, 'app.asar.unpacked')
  if (!existsSync(unpacked)) {
    throw new Error(`unpacked application resources are missing: ${unpacked}`)
  }
  if (!patchNodePtyHelperPath(unpacked)) {
    throw new Error(`node-pty is not unpacked under ${unpacked}`)
  }
  if (isMac) {
    const repaired = repairDarwinHelpers(unpacked)
    if (repaired === 0) {
      throw new Error(`no Darwin node-pty spawn-helper found under ${unpacked}`)
    }
  }
}

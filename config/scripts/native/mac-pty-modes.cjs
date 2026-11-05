'use strict'

/**
 * node-pty ships `spawn-helper` in its Darwin prebuilds, but the npm tarball
 * stores it without the executable bit. node-pty itself only repairs
 * `build/Release/spawn-helper`, so a prebuild-only install fails with
 * `posix_spawnp failed` the first time a PTY starts.
 *
 * Repair both architectures so a cross-arch package build is also covered.
 */

const { chmodSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')

function ensureMacPtyModes(projectRoot = PROJECT_ROOT) {
  const prebuilds = join(projectRoot, 'node_modules', 'node-pty', 'prebuilds')
  const changed = []
  for (const arch of ['x64', 'arm64']) {
    const helper = join(prebuilds, `darwin-${arch}`, 'spawn-helper')
    if (!existsSync(helper)) continue
    chmodSync(helper, 0o755)
    changed.push(helper)
  }
  return changed
}

if (require.main === module) {
  if (process.platform !== 'darwin') {
    process.stdout.write('[icode] macOS spawn-helper permissions are not needed here\n')
    process.exit(0)
  }
  try {
    const changed = ensureMacPtyModes(process.argv[2] ? resolve(process.argv[2]) : PROJECT_ROOT)
    process.stdout.write(
      `[icode] made ${changed.length} node-pty spawn-helper file(s) executable\n`
    )
  } catch (error) {
    process.stderr.write(`[icode] could not repair node-pty spawn-helper modes: ${String(error)}\n`)
    process.exit(1)
  }
}

module.exports = { ensureMacPtyModes }

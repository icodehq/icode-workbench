'use strict'

/**
 * Prepares node-pty for development.
 *
 * Windows and macOS use node-pty's Node-API prebuilds, which load in Electron
 * without a rebuild. Linux development rebuilds against the host so `pnpm dev`
 * and the unit tests use the workstation ABI. The packaged Linux artifact is
 * staged separately against the glibc 2.35 baseline by
 * `config/scripts/native/prepare-linux-pty.cjs`, so this script must never be
 * used as the release source.
 *
 * `ICODE_FORCE_NATIVE_BUILD=1` restores the old behavior on any platform, and
 * `--arch <x64|arm64>` selects a non-host architecture when a toolchain exists.
 */

const path = require('node:path')

function parseArch(argv) {
  const index = argv.indexOf('--arch')
  if (index === -1) return process.arch
  const arch = argv[index + 1]
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`unsupported architecture: ${arch ?? '(missing)'}`)
  }
  return arch
}

function main() {
  const arch = parseArch(process.argv.slice(2))
  const force = process.env.ICODE_FORCE_NATIVE_BUILD === '1'

  if (process.platform === 'darwin') {
    // The npm tarball omits the executable bit on spawn-helper; repair it now
    // so both development and the unit suite can start a PTY.
    require('./native/mac-pty-modes.cjs').ensureMacPtyModes()
  }

  if (process.platform !== 'linux' && !force) {
    process.stdout.write(
      `[icode] using node-pty prebuilds for ${process.platform}-${arch}; ` +
        'set ICODE_FORCE_NATIVE_BUILD=1 to rebuild\n'
    )
    return
  }

  const { rebuild } = require('@electron/rebuild')
  const projectDir = path.resolve(__dirname, '..', '..')
  const electronVersion = require(path.join(projectDir, 'node_modules/electron/package.json')).version

  rebuild({
    buildPath: projectDir,
    electronVersion,
    arch,
    onlyModules: ['node-pty'],
    force: true
  })
    .then(() => {
      process.stdout.write(`[icode] node-pty rebuilt for Electron ${electronVersion} (${arch})\n`)
    })
    .catch((error) => {
      process.stderr.write(`[icode] native rebuild failed: ${String(error)}\n`)
      process.exit(1)
    })
}

try {
  main()
} catch (error) {
  process.stderr.write(`[icode] native rebuild failed: ${String(error)}\n`)
  process.exit(1)
}

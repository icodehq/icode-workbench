'use strict'

/**
 * Verifies the update metadata a package job just produced.
 *
 * Usage:
 *   node config/scripts/verify-release-metadata.cjs \
 *     --platform linux|win|mac [--dir dist] [--arch x64|arm64]
 *
 * Every referenced installer must exist, match its size, and match its
 * SHA-512. Windows and macOS additionally require the blockmap electron-updater
 * uses for differential downloads. macOS per-arch jobs must reference that
 * architecture's zip exactly once; the release job merges the two files.
 */

const { join, resolve } = require('node:path')
const { verifyMetadata } = require('./lib/update-metadata.cjs')
const { version } = require('../../package.json')

const PLATFORMS = new Set(['linux', 'win', 'mac'])
const ARCHES = new Set(['x64', 'arm64'])
const METADATA_FILE = {
  linux: 'latest-linux.yml',
  win: 'latest.yml',
  mac: 'latest-mac.yml'
}

function fail(message) {
  process.stderr.write(`[verify-release-metadata] ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { platform: null, dir: null, arch: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--platform') options.platform = argv[++index]
    else if (arg === '--dir') options.dir = resolve(argv[++index])
    else if (arg === '--arch') options.arch = argv[++index]
    else fail(`unknown argument: ${arg}`)
  }
  if (!PLATFORMS.has(options.platform)) fail(`--platform must be linux, win, or mac`)
  if (options.arch !== null && !ARCHES.has(options.arch)) {
    fail(`--arch must be x64 or arm64`)
  }
  if (options.platform === 'mac' && options.arch === null) {
    fail('macOS verification requires --arch')
  }
  options.dir ??= resolve(__dirname, '..', '..', 'dist')
  return options
}

function main(argv) {
  const options = parseArgs(argv)
  const path = join(options.dir, METADATA_FILE[options.platform])
  const verified = verifyMetadata({
    path,
    expectedVersion: version,
    platform: options.platform,
    macArch: options.platform === 'mac' ? options.arch : null
  })
  process.stdout.write(
    `[verify-release-metadata] PASS ${path} (${verified.metadata.files.length} files)\n`
  )
  return 0
}

try {
  process.exit(main(process.argv.slice(2)))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

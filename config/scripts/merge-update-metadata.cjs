'use strict'

/**
 * Assembles the update channel files attached to a GitHub Release.
 *
 * Usage:
 *   node config/scripts/merge-update-metadata.cjs \
 *     [--root release-assets] [--output release-assets/metadata]
 *
 * The two macOS jobs each produce a `latest-mac.yml` with the same filename.
 * This script verifies both, merges their file lists, and copies the Windows
 * and Linux channel files into one directory. Every referenced installer and
 * blockmap is checked against its declared size and SHA-512 first, so a
 * partial download cannot become a published update.
 */

const { resolve } = require('node:path')
const { assembleUpdateMetadata } = require('./lib/update-metadata.cjs')
const { version } = require('../../package.json')

function fail(message) {
  process.stderr.write(`[update-metadata] ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    root: resolve(__dirname, '..', '..', 'release-assets'),
    output: resolve(__dirname, '..', '..', 'release-assets', 'metadata')
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') options.root = resolve(argv[++index])
    else if (arg === '--output') options.output = resolve(argv[++index])
    else fail(`unknown argument: ${arg}`)
  }
  return options
}

function main(argv) {
  const options = parseArgs(argv)
  const result = assembleUpdateMetadata({
    root: options.root,
    output: options.output,
    expectedVersion: version
  })
  process.stdout.write(
    `[update-metadata] assembled ${result.output} for ${version} ` +
      `(${result.macFiles} mac files, blockmaps verified)\n`
  )
  return 0
}

try {
  process.exit(main(process.argv.slice(2)))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

'use strict'

/**
 * Stages the glibc 2.35 node-pty build before Linux packaging.
 *
 * The development `node_modules/node-pty` is built against the workstation glibc
 * and must not become the packaged payload. This script builds the module in the
 * pinned Ubuntu 22.04 image (or consumes a cached artifact), verifies its ELF
 * dependencies, and replaces `build/Release/pty.node`, `lib/`, and
 * `package.json`.
 *
 * Usage:
 *   node config/scripts/native/prepare-linux-pty.cjs [--arch x64|arm64]
 *                                                    [--artifact <dir>]
 *                                                    [--out <dir>]
 *
 * `--artifact` expects a directory containing `node-pty/` as produced by the
 * container build; it enables CI caching without invoking Docker.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const native = require('./docker-node-pty.cjs')

function fail(message) {
  process.stderr.write(`[linux-pty] ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { arch: process.arch, artifact: null, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--arch') options.arch = argv[++index]
    else if (arg === '--artifact') options.artifact = argv[++index]
    else if (arg === '--out') options.out = argv[++index]
    else fail(`unknown argument: ${arg}`)
  }
  if (options.arch !== 'x64' && options.arch !== 'arm64') {
    fail(`unsupported architecture: ${options.arch}`)
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.artifact) {
    const artifactDir = path.join(options.artifact, 'node-pty')
    if (!fs.existsSync(artifactDir)) {
      fail(`--artifact ${options.artifact} does not contain node-pty/`)
    }
    native.stageNodePty(options.arch, artifactDir)
    return
  }

  if (process.platform !== 'linux') {
    fail(
      'Linux native staging runs on Linux with Docker; on other hosts pass ' +
        '--artifact with a tree produced by the Linux build.'
    )
  }

  const outDir =
    options.out ?? fs.mkdtempSync(path.join(os.tmpdir(), `icode-linux-pty-${options.arch}-`))
  const artifactDir = native.buildNodePty(options.arch, outDir)
  native.stageNodePty(options.arch, artifactDir)
  process.stdout.write(`[linux-pty] artifact directory retained at ${outDir}\n`)
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

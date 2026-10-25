'use strict'

/**
 * Self-test for the artifact verifier's failure paths.
 *
 * Each rejection is exercised against a REAL binary rather than a hand-written
 * string, because the thing that matters is whether the check fires on the kind
 * of input packaging actually sees:
 *
 *   - a too-new glibc requirement: the repository's own Electron-built pty.node
 *     (GLIBC_2.42) must be rejected against the 2.35 baseline;
 *   - an undeclared shared library: the pinned Node binary links libdl/libm/
 *     libpthread, none of which are in the allow-list;
 *   - a missing file and a hash mismatch: a copy of a verified tree, damaged.
 *
 * Usage: node scripts/wsl/selftest-verifier.cjs [--tree <dir>]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const verify = require('./verify-artifacts.cjs')

const DEFAULT_TREE = path.resolve(__dirname, '..', '..', 'artifacts', 'wsl-host', 'linux-x64')
const ELECTRON_PTY = path.resolve(
  __dirname,
  '..',
  '..',
  'node_modules',
  'node-pty',
  'build',
  'Release',
  'pty.node'
)

let failures = 0
function check(name, run) {
  try {
    run()
    process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL ${name}\n     ${error.message}\n`)
  }
}

function expectRejection(name, run, pattern) {
  check(name, () => {
    try {
      run()
    } catch (error) {
      if (pattern && !pattern.test(error.message)) {
        throw new Error(`rejected, but for an unexpected reason: ${error.message}`)
      }
      return
    }
    throw new Error('was accepted, but should have been rejected')
  })
}

// --- pure parsers ----------------------------------------------------------
check('parses the highest GLIBC symbol', () => {
  const listing = `
    0000      DF *UND*	0000000000000000  GLIBC_2.14  memcpy
    0000      DF *UND*	0000000000000000  GLIBC_2.34  pthread_create
    0000      DF *UND*	0000000000000000  GLIBC_2.2.5  stat`
  const max = verify.maxGlibcVersion(listing)
  if (max !== '2.34') throw new Error(`expected 2.34, got ${max}`)
  if (verify.compareVersions('2.9', '2.34') >= 0) throw new Error('2.9 must sort below 2.34')
  if (verify.compareVersions('2.35', '2.35') !== 0) throw new Error('equal versions must compare 0')
})

check('parses NEEDED entries', () => {
  const listing = `
  NEEDED               libstdc++.so.6
  NEEDED               libc.so.6
  OTHER                ignored`
  const needed = verify.neededLibraries(listing)
  if (needed.join(',') !== 'libstdc++.so.6,libc.so.6') {
    throw new Error(`unexpected NEEDED list: ${needed.join(',')}`)
  }
})

// --- real-binary rejections ------------------------------------------------
if (fs.existsSync(ELECTRON_PTY)) {
  expectRejection(
    'rejects a binary whose GLIBC requirement exceeds the baseline',
    () => verify.inspectNativeArtifact(ELECTRON_PTY),
    /above the declared baseline 2\.35/
  )
}

const treeArg = process.argv.indexOf('--tree')
const tree = treeArg === -1 ? DEFAULT_TREE : path.resolve(process.argv[treeArg + 1])

if (fs.existsSync(path.join(tree, 'manifest.json'))) {
  check('accepts the built tree', () => {
    const result = verify.verifyTree(tree)
    if (result.fileCount < 1) throw new Error('no files verified')
  })

  const nodeBin = path.join(tree, 'node', 'bin', 'node')
  if (fs.existsSync(nodeBin)) {
    expectRejection(
      'rejects a binary with undeclared shared libraries',
      () => verify.inspectNativeArtifact(nodeBin),
      /undeclared shared libraries/
    )
  }

  // --- damaged copies
  //
  // One copy, repaired between cases: the tree carries a ~120 MB Node binary and
  // duplicating it three times is both slow and needlessly large.
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-wsl-selftest-'))
  try {
    const damaged = path.join(probe, 'tree')
    fs.cpSync(tree, damaged, { recursive: true })

    const expectDamaged = (name, damage, restore, pattern) => {
      const undo = damage()
      try {
        expectRejection(name, () => verify.verifyTree(damaged), pattern)
      } finally {
        restore(undo)
      }
    }

    const ptyLib = path.join(damaged, 'node_modules', 'node-pty', 'lib', 'index.js')
    const savedLib = fs.readFileSync(ptyLib)
    expectDamaged(
      'rejects a tree with a missing required file',
      () => {
        fs.rmSync(ptyLib)
        return savedLib
      },
      (saved) => fs.writeFileSync(ptyLib, saved),
      /missing/
    )

    const hostBundle = path.join(damaged, 'host', 'index.js')
    const savedHost = fs.readFileSync(hostBundle)
    expectDamaged(
      'rejects a tree whose file no longer matches the manifest',
      () => {
        fs.appendFileSync(hostBundle, '\n// tampered\n')
        return savedHost
      },
      (saved) => fs.writeFileSync(hostBundle, saved),
      /hash mismatch/
    )

    const manifestPath = path.join(damaged, 'manifest.json')
    const savedManifest = fs.readFileSync(manifestPath)
    expectDamaged(
      'rejects a tree without a manifest',
      () => {
        fs.rmSync(manifestPath)
        return savedManifest
      },
      (saved) => fs.writeFileSync(manifestPath, saved),
      /missing manifest/
    )

    check('the tree is valid again after the damage was repaired', () => {
      verify.verifyTree(damaged)
    })
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
} else {
  process.stdout.write(`SKIP tree checks: no manifest at ${tree}\n`)
}

if (failures > 0) {
  process.stderr.write(`[wsl-selftest] FAILED (${failures})\n`)
  process.exit(1)
}
process.stdout.write('[wsl-selftest] PASS\n')

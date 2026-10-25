'use strict'

/**
 * Verification for the Linux Host artifact tree.
 *
 * Two jobs:
 *   1. Prove a `pty.node` is loadable on the declared glibc baseline, by reading
 *      its dynamic section rather than by running it — a requirement that is too
 *      new is invisible until the loader refuses it on an older distro.
 *   2. Prove a materialised tree still contains exactly the bytes its manifest
 *      recorded, so packaging cannot ship a stale or half-copied artifact.
 *
 * The parsing functions are exported and pure so they can be exercised against
 * fixture strings as well as against real binaries.
 */

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/** The declared minimum. A symbol newer than this rejects the artifact. */
const GLIBC_BASELINE = '2.35'

/**
 * Shared libraries the artifact may depend on.
 *
 * Deliberately short: every entry here is something every supported distro
 * base image ships. A new entry means a new runtime requirement, which must be
 * declared on purpose rather than discovered when a user's distro lacks it.
 */
const NEEDED_ALLOW_LIST = ['libc.so.6', 'libstdc++.so.6', 'libgcc_s.so.1']

/**
 * Files the deployment tree must contain, relative to its root.
 *
 * `manifest.json` is required but cannot hash itself, so it is listed separately
 * from the files the manifest has to account for.
 */
const REQUIRED_FILES = [
  'host/index.js',
  'node/bin/node',
  'node_modules/node-pty/package.json',
  'node_modules/node-pty/lib/index.js',
  'node_modules/node-pty/build/Release/pty.node',
  'manifest.json'
]

/** Required files whose bytes the manifest must record. */
const REQUIRED_HASHED_FILES = REQUIRED_FILES.filter((name) => name !== 'manifest.json')

class ArtifactError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArtifactError'
  }
}

/** Compares dotted numeric versions without assuming equal segment counts. */
function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Highest GLIBC symbol version referenced by an `objdump -T` listing. */
function maxGlibcVersion(objdumpOutput) {
  let max = null
  for (const match of objdumpOutput.matchAll(/GLIBC_([0-9]+(?:\.[0-9]+)+)/g)) {
    const version = match[1]
    if (max === null || compareVersions(version, max) > 0) max = version
  }
  return max
}

/** `NEEDED` entries from an `objdump -p` listing, in file order. */
function neededLibraries(objdumpOutput) {
  return [...objdumpOutput.matchAll(/^\s+NEEDED\s+(\S+)\s*$/gm)].map((m) => m[1])
}

function runObjdump(flag, file) {
  try {
    return execFileSync('objdump', [flag, file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    throw new ArtifactError(`objdump ${flag} failed for ${file}: ${error.message}`)
  }
}

/**
 * Checks one `pty.node` against the declared baseline and allow-list.
 * Returns the facts so the caller can record them in the manifest.
 */
function inspectNativeArtifact(file, options = {}) {
  const baseline = options.glibcBaseline ?? GLIBC_BASELINE
  const allowList = options.neededAllowList ?? NEEDED_ALLOW_LIST
  if (!fs.existsSync(file)) throw new ArtifactError(`missing native artifact: ${file}`)

  const maxGlibc = maxGlibcVersion(runObjdump('-T', file))
  if (maxGlibc === null) {
    throw new ArtifactError(`${file} references no GLIBC symbol versions; not a glibc ELF?`)
  }
  if (compareVersions(maxGlibc, baseline) > 0) {
    throw new ArtifactError(
      `${file} requires GLIBC_${maxGlibc}, above the declared baseline ${baseline}`
    )
  }

  const needed = neededLibraries(runObjdump('-p', file))
  const unexpected = needed.filter((name) => !allowList.includes(name))
  if (unexpected.length > 0) {
    throw new ArtifactError(
      `${file} depends on undeclared shared libraries: ${unexpected.join(', ')}`
    )
  }

  return { maxGlibc, baseline, needed }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Verifies a materialised tree: every required file is present, every hashed file
 * matches its manifest entry, and no hashed file is missing from disk.
 *
 * `nativeCheck: false` skips the `objdump` inspection. Packaging uses that form:
 * a cross-build host may not have binutils, and packaging should refuse a damaged
 * or stale tree without depending on a toolchain it does not otherwise need. The
 * full check remains the build's and `verify:wsl-host`'s job.
 */
function verifyTree(root, options = {}) {
  const nativeCheck = options.nativeCheck !== false
  const manifestPath = path.join(root, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new ArtifactError(`missing manifest: ${manifestPath}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  for (const relative of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(root, relative))) {
      throw new ArtifactError(`artifact tree is missing ${relative}`)
    }
  }

  if (manifest.architecture !== 'x64') {
    throw new ArtifactError(`manifest architecture is ${manifest.architecture}, expected x64`)
  }
  if (manifest.glibcBaseline !== GLIBC_BASELINE) {
    throw new ArtifactError(
      `manifest glibc baseline is ${manifest.glibcBaseline}, expected ${GLIBC_BASELINE}`
    )
  }

  const files = manifest.files ?? {}
  for (const [relative, expected] of Object.entries(files)) {
    const full = path.join(root, relative)
    if (!fs.existsSync(full)) throw new ArtifactError(`manifest lists ${relative}, which is absent`)
    const actual = sha256(full)
    if (actual !== expected) {
      throw new ArtifactError(
        `hash mismatch for ${relative}\n  manifest ${expected}\n  on disk  ${actual}`
      )
    }
  }

  // A file in the tree that the manifest does not cover would ship unverified.
  const hashed = new Set(Object.keys(files))
  for (const relative of REQUIRED_HASHED_FILES) {
    if (!hashed.has(relative)) throw new ArtifactError(`manifest does not record ${relative}`)
  }

  const shippedPty = path.join(root, 'node_modules/node-pty/build/Release/pty.node')
  const native = nativeCheck ? inspectNativeArtifact(shippedPty) : null
  if (manifest.native?.sha256 !== sha256(shippedPty)) {
    throw new ArtifactError('manifest native artifact hash does not match the shipped pty.node')
  }
  if (manifest.node?.sha256 !== sha256(path.join(root, 'node/bin/node'))) {
    throw new ArtifactError('manifest Node hash does not match the shipped node binary')
  }

  return { manifest, native, fileCount: Object.keys(files).length }
}

function main(argv) {
  const root = argv[0]
  if (!root) {
    process.stderr.write('usage: verify-artifacts.cjs <artifact-root>\n')
    return 2
  }
  try {
    const { manifest, native, fileCount } = verifyTree(path.resolve(root))
    process.stdout.write(
      `[wsl-host] verified ${fileCount} files\n` +
        `[wsl-host] max GLIBC_${native.maxGlibc} (baseline ${native.baseline})\n` +
        `[wsl-host] NEEDED ${native.needed.join(', ')}\n` +
        `[wsl-host] node ${manifest.node.version}  native ${manifest.native.sha256.slice(0, 12)}\n`
    )
    return 0
  } catch (error) {
    process.stderr.write(`[wsl-host] VERIFICATION FAILED: ${error.message}\n`)
    return 1
  }
}

module.exports = {
  ArtifactError,
  GLIBC_BASELINE,
  NEEDED_ALLOW_LIST,
  REQUIRED_FILES,
  REQUIRED_HASHED_FILES,
  compareVersions,
  inspectNativeArtifact,
  maxGlibcVersion,
  neededLibraries,
  sha256,
  verifyTree
}

if (require.main === module) process.exit(main(process.argv.slice(2)))

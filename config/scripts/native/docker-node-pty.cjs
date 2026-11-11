'use strict'

/**
 * Builds node-pty in the pinned Ubuntu 22.04 image and stages it into
 * `node_modules/node-pty` for Linux packaging.
 *
 * Why this exists: a development rebuild uses the workstation glibc (this WSL
 * checkout produces GLIBC_2.42 symbols, while the declared baseline is 2.35).
 * Packaging therefore cannot trust `node_modules` as it stands; it must replace
 * the native module with one built in the same pinned image the WSL Host
 * artifact uses. The build script is shared so both artifacts come from the same
 * toolchain and checksums.
 */

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const verifier = require('../wsl/verify-artifacts.cjs')
const { dockerDnsArgs } = require('../docker-dns.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const BUILD_SCRIPT = path.join(REPO_ROOT, 'config', 'scripts', 'wsl', 'build-node-pty.sh')

/**
 * The image and per-arch Node checksums are pinned by digest/hash. `22.04` alone
 * is mutable, and the glibc promise is only true for the image measured here.
 */
const PINS = {
  ubuntuImage: {
    x64: 'ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956',
    arm64: 'ubuntu:22.04@sha256:a8fb2ba88181746111cbbe2969826d6546b71226785b196c93d2c3445a25000d'
  },
  nodeVersion: 'v24.21.0',
  nodeSha256: {
    x64: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
    arm64: '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2'
  }
}

function log(message) {
  process.stdout.write(`[linux-pty] ${message}\n`)
}

function fail(message) {
  throw new Error(message)
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function assertElfArch(file, expectedArch) {
  const buffer = fs.readFileSync(file)
  if (buffer.length < 20 || buffer.readUInt32BE(0) !== 0x7f454c46) {
    fail(`${file} is not an ELF binary`)
  }
  const machine = buffer.readUInt16LE(18)
  const actual = machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : `unknown (0x${machine.toString(16)})`
  if (actual !== expectedArch) {
    fail(`${file} is ${actual}, expected ${expectedArch}`)
  }
}

function dockerPlatform(arch) {
  return arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
}

function requireDocker() {
  try {
    execFileSync('docker', ['--version'], { stdio: 'ignore' })
  } catch {
    fail('Docker is required to build the glibc 2.35 node-pty artifact')
  }
}

/** Returns a bind-mounted directory to the invoking user (the container runs as root). */
function reclaimOwnership(dir, arch) {
  if (typeof process.getuid !== 'function') return
  try {
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--platform',
        dockerPlatform(arch),
        '-v',
        `${dir}:/reclaim`,
        PINS.ubuntuImage[arch],
        'chown',
        '-R',
        `${process.getuid()}:${process.getgid()}`,
        '/reclaim'
      ],
      { stdio: 'ignore' }
    )
  } catch {
    // Best effort: the staging copy reports the real failure.
  }
}

/**
 * Builds node-pty into `<outDir>/node-pty` and returns the artifact directory.
 * The caller owns cleanup.
 */
function buildNodePty(arch, outDir) {
  if (!PINS.nodeSha256[arch]) fail(`unsupported architecture: ${arch}`)
  requireDocker()
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  log(`building node-pty in ${PINS.ubuntuImage[arch]} (${dockerPlatform(arch)})`)
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      ...dockerDnsArgs(),
      '--platform',
      dockerPlatform(arch),
      '-v',
      `${BUILD_SCRIPT}:/usr/local/bin/build-node-pty.sh:ro`,
      '-v',
      `${outDir}:/out`,
      '-e',
      'OUT_DIR=/out',
      '-e',
      `TARGET_ARCH=${arch}`,
      '-e',
      `NODE_SHA256=${PINS.nodeSha256[arch]}`,
      PINS.ubuntuImage[arch],
      'bash',
      '/usr/local/bin/build-node-pty.sh'
    ],
    { stdio: 'inherit' }
  )
  reclaimOwnership(outDir, arch)
  const artifact = path.join(outDir, 'node-pty', 'build', 'Release', 'pty.node')
  if (!fs.existsSync(artifact)) fail(`build produced no pty.node in ${outDir}`)
  log(`built ${artifact} sha256 ${sha256File(artifact)}`)
  return path.join(outDir, 'node-pty')
}

/**
 * Replaces the development build with the pinned artifact. Prebuilds are left
 * alone: Windows cross-packaging from this checkout still needs them, and the
 * Linux package config excludes them explicitly.
 */
function stageNodePty(arch, artifactDir) {
  const target = path.join(REPO_ROOT, 'node_modules', 'node-pty')
  const sourcePty = path.join(artifactDir, 'build', 'Release', 'pty.node')
  const sourceLib = path.join(artifactDir, 'lib')
  const sourceManifest = path.join(artifactDir, 'package.json')

  for (const [label, file] of [
    ['built pty.node', sourcePty],
    ['built lib directory', sourceLib],
    ['built package.json', sourceManifest]
  ]) {
    if (!fs.existsSync(file)) fail(`artifact is missing ${label}: ${file}`)
  }

  assertElfArch(sourcePty, arch)
  const info = verifier.inspectNativeArtifact(sourcePty)
  log(
    `verified ${arch} artifact against glibc ${info.baseline} ` +
      `(max GLIBC_${info.maxGlibc}; needed ${info.needed.join(', ')})`
  )

  fs.rmSync(path.join(target, 'build'), { recursive: true, force: true })
  fs.mkdirSync(path.join(target, 'build', 'Release'), { recursive: true })
  fs.copyFileSync(sourcePty, path.join(target, 'build', 'Release', 'pty.node'))

  fs.rmSync(path.join(target, 'lib'), { recursive: true, force: true })
  fs.cpSync(sourceLib, path.join(target, 'lib'), { recursive: true })
  fs.copyFileSync(sourceManifest, path.join(target, 'package.json'))

  // Electron-ABI copies from @electron/rebuild are not the packaged payload.
  fs.rmSync(path.join(target, 'bin'), { recursive: true, force: true })

  log(`staged glibc ${info.baseline} node-pty into ${target}`)
  return info
}

module.exports = {
  PINS,
  buildNodePty,
  dockerPlatform,
  stageNodePty
}

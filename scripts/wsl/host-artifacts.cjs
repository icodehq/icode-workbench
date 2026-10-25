'use strict'

/**
 * Builds the Linux x64 Host artifact tree.
 *
 * The tree is what a WSL Host deploys: the existing Electron-free Host bundle,
 * a pinned Node runtime, and a node-pty compiled against the declared glibc
 * baseline. It is deliberately self-contained — nothing in it resolves back to
 * the repository at runtime.
 *
 * Reproducibility is asserted, not assumed: the native artifact is built twice
 * in independent containers and the two hashes must match. A build that differs
 * is a failure, because the manifest would otherwise certify bytes nobody can
 * re-derive.
 *
 * Usage:
 *   node scripts/wsl/host-artifacts.cjs build [--out <dir>] [--skip-rebuild]
 *   node scripts/wsl/host-artifacts.cjs verify [<dir>]
 */

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const verifier = require('./verify-artifacts.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const DEFAULT_OUT = path.join(REPO_ROOT, 'artifacts', 'wsl-host', 'linux-x64')
const BUILD_SCRIPT = path.join(__dirname, 'build-node-pty.sh')

/**
 * Every build input, pinned.
 *
 * The Ubuntu image is pinned by digest as well as tag: `22.04` is mutable, and
 * the glibc baseline we promise is only true of the image we measured.
 */
const PINS = {
  ubuntuImage: 'ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956',
  glibcBaseline: verifier.GLIBC_BASELINE,
  architecture: 'x64',
  nodeVersion: 'v24.21.0',
  nodeSha256: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  nodePtyVersion: '1.1.0',
  nodePtySha256: 'c7517f19083ddcb05f276904680eb2b11a6b5ecab778b8e4e5685a6d645b3f60'
}

function log(message) {
  process.stdout.write(`[wsl-host] ${message}\n`)
}

function fail(message) {
  throw new verifier.ArtifactError(message)
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function requireTool(name, args, hint) {
  try {
    return execFileSync(name, args, { encoding: 'utf8' }).trim()
  } catch {
    fail(`${name} is required but not usable. ${hint ?? ''}`.trim())
  }
}

/**
 * Returns a bind-mounted directory to the invoking user.
 *
 * The build container runs as root, so everything it writes into the mount is
 * root-owned and the host user cannot read it back or delete the temp tree.
 * Reclaiming is done by a container rather than `sudo`, so the build never needs
 * privileges on the host.
 */
function reclaimOwnership(dir) {
  if (typeof process.getuid !== 'function') return
  try {
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${dir}:/reclaim`,
        PINS.ubuntuImage,
        'chown',
        '-R',
        `${process.getuid()}:${process.getgid()}`,
        '/reclaim'
      ],
      { stdio: 'ignore' }
    )
  } catch {
    // Best effort: a failure here surfaces as the cleanup error that follows.
  }
}

/** Builds node-pty once in a throwaway container at a fixed in-container path. */
function buildOnce(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      // Fixed mount points: the compile path is recorded in the binary, so a
      // different path would produce different bytes for identical inputs.
      '-v',
      `${BUILD_SCRIPT}:/usr/local/bin/build-node-pty.sh:ro`,
      '-v',
      `${outDir}:/out`,
      '-e',
      'OUT_DIR=/out',
      PINS.ubuntuImage,
      'bash',
      '/usr/local/bin/build-node-pty.sh'
    ],
    { stdio: 'inherit' }
  )
  reclaimOwnership(outDir)
  const artifact = path.join(outDir, 'node-pty', 'build', 'Release', 'pty.node')
  if (!fs.existsSync(artifact)) fail(`build produced no pty.node in ${outDir}`)
  return sha256File(artifact)
}

/** Copies the existing Electron-free Host bundle. Never rebuilds a second one. */
function copyHostBundle(root) {
  const bundle = path.join(REPO_ROOT, 'out', 'host', 'index.js')
  if (!fs.existsSync(bundle)) {
    fail(`missing ${path.relative(REPO_ROOT, bundle)}; run "pnpm build:host" first`)
  }
  fs.mkdirSync(path.join(root, 'host'), { recursive: true })
  fs.copyFileSync(bundle, path.join(root, 'host', 'index.js'))
  return sha256File(path.join(root, 'host', 'index.js'))
}

/** Downloads the pinned Node release, verifies the published checksum, extracts. */
function acquireNode(root) {
  const cacheDir = path.join(REPO_ROOT, 'artifacts', 'wsl-host', '.cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const tarball = path.join(cacheDir, `node-${PINS.nodeVersion}-linux-x64.tar.xz`)
  const base = `node-${PINS.nodeVersion}-linux-x64`

  if (!fs.existsSync(tarball) || sha256File(tarball) !== PINS.nodeSha256) {
    log(`downloading Node ${PINS.nodeVersion}`)
    execFileSync(
      'curl',
      [
        '-sSL',
        '-o',
        tarball,
        `https://nodejs.org/dist/${PINS.nodeVersion}/${base}.tar.xz`
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    )
  }

  const actual = sha256File(tarball)
  if (actual !== PINS.nodeSha256) {
    fail(
      `Node ${PINS.nodeVersion} checksum mismatch\n  pinned   ${PINS.nodeSha256}\n  download ${actual}`
    )
  }
  log(`Node ${PINS.nodeVersion} checksum verified`)

  // Only the runtime binary and licence are shipped; the npm tree is not needed
  // in a deployment target and would add megabytes for nothing.
  const nodeDir = path.join(root, 'node')
  fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true })
  execFileSync(
    'tar',
    ['-xJf', tarball, '-C', nodeDir, '--strip-components=1', `${base}/bin/node`, `${base}/LICENSE`],
    { stdio: 'inherit' }
  )
  fs.chmodSync(path.join(nodeDir, 'bin', 'node'), 0o755)
  return sha256File(path.join(nodeDir, 'bin', 'node'))
}

/** Every file in the tree except the manifest itself, hashed. */
function hashTree(root) {
  const files = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1
    )) {
      const full = path.join(dir, entry.name)
      const relative = path.relative(root, full).replace(/\\/g, '/')
      if (relative === 'manifest.json') continue
      if (entry.isDirectory()) walk(full)
      else files[relative] = sha256File(full)
    }
  }
  walk(root)
  return files
}

function build(options) {
  requireTool('docker', ['--version'], 'Docker is needed to pin the glibc baseline.')
  const outRoot = options.out ?? DEFAULT_OUT

  // --- reproducible native build
  const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-wsl-pty-a-'))
  const secondDir = options.skipRebuild ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'ade-wsl-pty-b-'))
  try {
    log('building node-pty (1/2)')
    const firstHash = buildOnce(firstDir)
    log(`  hash ${firstHash}`)

    let nativeHash = firstHash
    if (secondDir) {
      log('building node-pty (2/2)')
      const secondHash = buildOnce(secondDir)
      log(`  hash ${secondHash}`)
      if (firstHash !== secondHash) {
        fail(
          `native artifact is not reproducible\n  build 1 ${firstHash}\n  build 2 ${secondHash}`
        )
      }
      log('reproducible: both builds produced identical bytes')
    } else {
      log('skipped the second build (--skip-rebuild): reproducibility NOT re-asserted')
    }

    // --- assemble
    fs.rmSync(outRoot, { recursive: true, force: true })
    fs.mkdirSync(outRoot, { recursive: true })
    const hostSha256 = copyHostBundle(outRoot)
    const nodeSha256 = acquireNode(outRoot)

    const ptySource = path.join(firstDir, 'node-pty')
    fs.cpSync(ptySource, path.join(outRoot, 'node_modules', 'node-pty'), { recursive: true })
    const shippedPty = path.join(outRoot, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
    nativeHash = sha256File(shippedPty)

    // Fail before writing the manifest if the shipped binary is not baseline-safe.
    const native = verifier.inspectNativeArtifact(shippedPty)

    const manifest = {
      artifactVersion: `${PINS.nodeVersion}-node-pty-${PINS.nodePtyVersion}-linux-${PINS.architecture}-glibc${PINS.glibcBaseline}`,
      architecture: PINS.architecture,
      glibcBaseline: PINS.glibcBaseline,
      maxGlibcSymbol: native.maxGlibc,
      needed: native.needed,
      node: {
        version: PINS.nodeVersion,
        sha256: nodeSha256,
        upstreamTarballSha256: PINS.nodeSha256
      },
      native: {
        package: 'node-pty',
        version: PINS.nodePtyVersion,
        upstreamTarballSha256: PINS.nodePtySha256,
        sha256: nativeHash
      },
      host: { bundle: 'host/index.js', sha256: hostSha256 },
      build: {
        image: PINS.ubuntuImage,
        reproducible: secondDir !== null,
        // Filled in by hashTree below so the manifest describes what it ships.
        files: {}
      }
    }
    // files lives at the top level: the verifier reads manifest.files.
    delete manifest.build.files
    manifest.files = hashTree(outRoot)
    fs.writeFileSync(path.join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    const verified = verifier.verifyTree(outRoot)
    log(`verified ${verified.fileCount} files`)
    log(`max GLIBC_${verified.native.maxGlibc} (baseline ${verified.native.baseline})`)
    log(`NEEDED ${verified.native.needed.join(', ')}`)
    log(`artifact ${outRoot}`)
    return outRoot
  } finally {
    fs.rmSync(firstDir, { recursive: true, force: true })
    if (secondDir) fs.rmSync(secondDir, { recursive: true, force: true })
  }
}

function main(argv) {
  const command = argv[0]
  const args = argv.slice(1)
  const outIndex = args.indexOf('--out')
  const options = {
    out: outIndex === -1 ? undefined : path.resolve(args[outIndex + 1]),
    skipRebuild: args.includes('--skip-rebuild')
  }

  try {
    if (command === 'build') {
      build(options)
      return 0
    }
    if (command === 'verify') {
      const root = path.resolve(args.find((a) => !a.startsWith('--')) ?? DEFAULT_OUT)
      const { manifest, native, fileCount } = verifier.verifyTree(root)
      log(`verified ${fileCount} files from ${manifest.artifactVersion}`)
      log(`max GLIBC_${native.maxGlibc}  NEEDED ${native.needed.join(', ')}`)
      return 0
    }
    process.stderr.write('usage: host-artifacts.cjs <build|verify> [--out <dir>] [--skip-rebuild]\n')
    return 2
  } catch (error) {
    process.stderr.write(`[wsl-host] FAILED: ${error.message}\n`)
    return 1
  }
}

module.exports = { PINS, DEFAULT_OUT, build }

if (require.main === module) process.exit(main(process.argv.slice(2)))

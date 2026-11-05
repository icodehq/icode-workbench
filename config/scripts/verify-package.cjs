'use strict'

/**
 * Verifies a packaged directory before it is published.
 *
 * Packages have failed in ways that a build log does not show: the WSL tree
 * absent from a Windows installer, a Linux payload shipped inside a Windows app,
 * or a native module built for the wrong platform/architecture. This script
 * inspects the produced directory and fails loudly on any of those.
 *
 * Usage:
 *   node config/scripts/verify-package.cjs [--platform linux|win|mac]
 *                                          [--arch x64|arm64] [--dir <path>]
 */

const {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join, resolve } = require('node:path')

const REPO_ROOT = resolve(__dirname, '..', '..')
const PLATFORMS = new Set(['linux', 'win', 'mac'])
const ARCHES = new Set(['x64', 'arm64'])

function fail(message) {
  throw new Error(message)
}

function check(condition, message) {
  if (!condition) fail(message)
}

function parseArgs(argv) {
  const options = {
    platform: process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux',
    arch: process.arch,
    dir: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--platform') options.platform = argv[++index]
    else if (arg === '--arch') options.arch = argv[++index]
    else if (arg === '--dir') options.dir = argv[++index]
    else fail(`unknown argument: ${arg}`)
  }
  if (!PLATFORMS.has(options.platform)) fail(`unsupported platform: ${options.platform}`)
  if (!ARCHES.has(options.arch)) fail(`unsupported architecture: ${options.arch}`)
  return options
}

function packageDirectory(options) {
  if (options.dir) return resolve(options.dir)
  if (options.platform === 'linux') return join(REPO_ROOT, 'dist', 'linux-unpacked')
  if (options.platform === 'win') return join(REPO_ROOT, 'dist', 'win-unpacked')
  return join(REPO_ROOT, 'dist', options.arch === 'arm64' ? 'mac-arm64' : 'mac')
}

/** Reads the JSON file tree from an asar header without loading the archive. */
function readAsarHeader(asarPath) {
  const file = openSync(asarPath, 'r')
  try {
    const header = Buffer.alloc(16)
    if (readSync(file, header, 0, 16, 0) !== 16) fail(`cannot read asar header: ${asarPath}`)
    const jsonSize = header.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    if (readSync(file, json, 0, jsonSize, 16) !== jsonSize) fail(`truncated asar header: ${asarPath}`)
    return JSON.parse(json.toString('utf8'))
  } finally {
    closeSync(file)
  }
}

function asarHas(node, parts) {
  if (parts.length === 0) return true
  if (!node || !node.files) return false
  const next = node.files[parts[0]]
  return next ? asarHas(next, parts.slice(1)) : false
}

function binaryInfo(path) {
  const buffer = readFileSync(path)
  if (buffer.length >= 20 && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
    const machine = buffer.readUInt16LE(18)
    return { format: 'ELF', arch: machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : `unknown-0x${machine.toString(16)}` }
  }
  if (buffer.length >= 64 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    const peOffset = buffer.readUInt32LE(0x3c)
    if (buffer.length >= peOffset + 6 && buffer.toString('ascii', peOffset, peOffset + 4) === 'PE\u0000\u0000') {
      const machine = buffer.readUInt16LE(peOffset + 4)
      return { format: 'PE', arch: machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `unknown-0x${machine.toString(16)}` }
    }
  }
  if (buffer.length >= 8) {
    const le = buffer.readUInt32LE(0)
    const be = buffer.readUInt32BE(0)
    const little = le === 0xfeedfacf || le === 0xfeedface
    const big = be === 0xfeedfacf || be === 0xfeedface
    if (little || big) {
      const cpu = little ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4)
      return {
        format: 'Mach-O',
        arch: cpu === 0x01000007 ? 'x64' : cpu === 0x0100000c ? 'arm64' : `unknown-0x${cpu.toString(16)}`
      }
    }
  }
  return fail(`unrecognised native binary format: ${path}`)
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function verifyLinuxGlibc(nativePath) {
  let output
  try {
    output = execFileSync('objdump', ['-T', nativePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      process.stdout.write('[verify-package] objdump unavailable; glibc floor was not re-inspected\n')
      return
    }
    throw error
  }
  const versions = [...output.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map((match) => [Number(match[1]), Number(match[2])])
  if (versions.length === 0) fail(`no GLIBC version symbols found in ${nativePath}`)
  versions.sort(compareVersions)
  const highest = versions[versions.length - 1]
  check(
    compareVersions(highest, [2, 35]) <= 0,
    `packaged pty.node requires GLIBC ${highest.join('.')}; the baseline is 2.35`
  )
  process.stdout.write(`[verify-package] glibc floor ok (max GLIBC_${highest.join('.')})\n`)
}

function main(argv) {
  const options = parseArgs(argv)
  const dir = packageDirectory(options)
  check(existsSync(dir), `package directory not found: ${dir}`)

  // macOS keeps the payload inside the .app bundle; Linux/Windows unpack a
  // plain directory with a top-level resources folder.
  let resources = join(dir, 'resources')
  if (options.platform === 'mac') {
    const app = readdirSync(dir, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && entry.name.endsWith('.app')
    )
    check(app !== undefined, `no .app bundle found in ${dir}`)
    resources = join(dir, app.name, 'Contents', 'Resources')
  }
  const asar = join(resources, 'app.asar')
  check(existsSync(asar), `app.asar is missing from ${dir}`)
  check(statSync(asar).size > 0, `app.asar is empty in ${dir}`)
  const header = readAsarHeader(asar)
  check(asarHas(header, ['out', 'main', 'index.js']), 'app.asar does not contain out/main/index.js')

  const unpacked = join(resources, 'app.asar.unpacked')
  check(existsSync(join(unpacked, 'out', 'host', 'index.js')), 'unpacked Host bundle is missing')

  const ptyDir = join(unpacked, 'node_modules', 'node-pty')
  check(existsSync(ptyDir), 'unpacked node-pty module is missing')
  // The detached Host runs without asar support, so node-pty's JS is unpacked
  // and its helper path must not be expanded twice. afterPack applies the
  // anchored replacement; refuse a package that lost it.
  const unixTerminal = join(ptyDir, 'lib', 'unixTerminal.js')
  if (existsSync(unixTerminal)) {
    check(
      readFileSync(unixTerminal, 'utf8').includes('app\\.asar(?!\\.unpacked)'),
      'node-pty asar helper-path fix is missing from the package'
    )
  }

  const nativePath =
    options.platform === 'linux'
      ? join(ptyDir, 'build', 'Release', 'pty.node')
      : join(
          ptyDir,
          'prebuilds',
          `${options.platform === 'win' ? 'win32' : 'darwin'}-${options.arch}`,
          'pty.node'
        )

  check(existsSync(nativePath), `expected native module is missing: ${nativePath}`)
  const info = binaryInfo(nativePath)
  check(
    info.arch === options.arch,
    `native module architecture mismatch: ${nativePath} is ${info.format} ${info.arch}, expected ${options.arch}`
  )

  if (options.platform === 'linux') {
    check(!existsSync(join(ptyDir, 'prebuilds')), 'Linux package must not ship node-pty prebuilds')
  } else {
    check(
      !existsSync(join(ptyDir, 'build', 'Release', 'pty.node')),
      `${options.platform} package must not ship a host-built pty.node`
    )
    check(!existsSync(join(ptyDir, 'bin')), `${options.platform} package must not ship Electron-ABI bin copies`)
    if (options.platform === 'mac') {
      const helper = join(ptyDir, 'prebuilds', `darwin-${options.arch}`, 'spawn-helper')
      check(existsSync(helper), 'macOS package is missing node-pty spawn-helper')
      // node-pty's tarball omits the executable bit; a non-executable helper
      // makes every PTY fail with "posix_spawnp failed".
      check(
        (statSync(helper).mode & 0o111) !== 0,
        `macOS node-pty spawn-helper is not executable: ${helper}`
      )
    }
  }

  const wslRoot = join(resources, 'artifacts', 'wsl-host')
  if (options.platform === 'win') {
    check(
      existsSync(join(wslRoot, 'linux-x64', 'manifest.json')),
      'Windows package is missing the WSL Host artifact tree'
    )
  } else {
    check(!existsSync(wslRoot), `${options.platform} package must not ship WSL Host artifacts`)
  }

  if (options.platform === 'linux') verifyLinuxGlibc(nativePath)

  process.stdout.write(
    `[verify-package] PASS ${dir} (${options.platform}/${options.arch}, ${info.format})\n`
  )
  return 0
}

try {
  process.exit(main(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`[verify-package] FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

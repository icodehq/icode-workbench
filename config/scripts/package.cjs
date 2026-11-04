'use strict'

/**
 * Platform packaging dispatcher.
 *
 * Why: electron-builder needs a different config per target, and a static config
 * cannot know the requested target when Windows is cross-built from Linux. The
 * dispatcher selects the platform config, prepares platform-specific inputs, and
 * invokes electron-builder's own CLI so `pnpm` never needs a POSIX shell
 * assignment.
 *
 * Usage:
 *   node config/scripts/package.cjs linux [--x64|--arm64]
 *   node config/scripts/package.cjs win [--x64]
 *   node config/scripts/package.cjs mac [--x64|--arm64]
 *   node config/scripts/package.cjs dir
 *
 * Linux packaging stages node-pty in a pinned Ubuntu 22.04 container before
 * electron-builder. Set ICODE_SKIP_NATIVE_STAGE=1 only for a development
 * directory build that is not meant to be shipped.
 */

const { existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')

const REPO_ROOT = resolve(__dirname, '..', '..')
const CONFIGS = {
  linux: 'config/electron-builder.linux.cjs',
  win: 'config/electron-builder.win.cjs',
  mac: 'config/electron-builder.mac.cjs'
}

function hostPlatform() {
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function fail(message) {
  process.stderr.write(`[package] ${message}\n`)
  process.exit(1)
}

function run(command, args) {
  process.stdout.write(`[package] ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' })
  if (result.error) fail(String(result.error.message))
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function electronBuilderCli() {
  try {
    return require.resolve('electron-builder/cli.js')
  } catch {
    const fallback = join(REPO_ROOT, 'node_modules', 'electron-builder', 'cli.js')
    if (existsSync(fallback)) return fallback
    return fail('electron-builder is not installed; run "pnpm install" first')
  }
}

function archFromArgs(args) {
  if (args.includes('--arm64')) return 'arm64'
  if (args.includes('--x64')) return 'x64'
  return process.arch
}

function main(argv) {
  const requested = argv[0]
  if (!requested) {
    fail('usage: node config/scripts/package.cjs <linux|win|mac|dir> [--x64|--arm64]')
  }

  const dirOnly = requested === 'dir'
  const platform = dirOnly ? hostPlatform() : requested
  if (!(platform in CONFIGS)) {
    fail(`unknown target "${requested}"; expected linux, win, mac, or dir`)
  }

  const passthrough = argv.slice(1)
  const hasArch = passthrough.some((arg) => arg === '--x64' || arg === '--arm64')

  if (platform === 'win') {
    // Windows packaging consumes a verified tree; it must never invoke Docker.
    run(process.execPath, ['config/scripts/wsl/prepare-artifacts.cjs', '--verify-only'])
  }

  if (platform === 'mac') {
    // The package's own postinstall does not set the executable bit on its
    // Darwin spawn-helper. Repair it even when install scripts were skipped.
    require('./native/mac-pty-modes.cjs').ensureMacPtyModes(REPO_ROOT)
  }

  if (platform === 'linux') {
    if (process.env.ICODE_SKIP_NATIVE_STAGE === '1') {
      process.stdout.write(
        '[package] ICODE_SKIP_NATIVE_STAGE=1: using the development node-pty build\n'
      )
    } else {
      // Stage the glibc 2.35 build immediately before packaging.
      run(process.execPath, [
        'config/scripts/native/prepare-linux-pty.cjs',
        '--arch',
        archFromArgs(passthrough)
      ])
    }
  }

  const args = [electronBuilderCli(), '--config', CONFIGS[platform], `--${platform}`]
  if (platform === 'win' && !hasArch) args.push('--x64')
  if (dirOnly) args.push('--dir')
  // CI detection makes electron-builder publish implicitly, which fails without
  // GH_TOKEN. Release publishing is a separate workflow step.
  if (!passthrough.some((arg) => arg === '--publish' || arg.startsWith('--publish='))) {
    args.push('--publish', 'never')
  }
  args.push(...passthrough)

  run(process.execPath, args)
}

main(process.argv.slice(2))

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

  const args = [electronBuilderCli(), '--config', CONFIGS[platform], `--${platform}`]
  if (platform === 'win' && !hasArch) args.push('--x64')
  if (dirOnly) args.push('--dir')
  args.push(...passthrough)

  run(process.execPath, args)
}

main(process.argv.slice(2))

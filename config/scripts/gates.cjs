'use strict'

/**
 * Cross-platform compatibility-gate launcher.
 *
 * Why: package scripts previously used POSIX `VAR=value command` syntax and
 * `/tmp` Unix sockets, neither of which cmd.exe can execute. This wrapper sets
 * the same values in JavaScript, derives the platform endpoint, and spawns
 * Electron directly.
 *
 * Usage:
 *   node config/scripts/gates.cjs pty|sqlite|host-start|host-verify|reattach|host-stop|packaged|perf-scm
 */

const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const REPO_ROOT = resolve(__dirname, '..', '..')
const ELECTRON = require('electron')

const GATE_DIR = process.env.ICODE_GATE_DIR ?? join(tmpdir(), 'icode-work1')
const HOST_DIR = join(GATE_DIR, 'host')

function fail(message) {
  process.stderr.write(`[gates] ${message}\n`)
  process.exit(1)
}

/**
 * Mirrors `hostSocketPath` for a profile directory: a Unix socket on POSIX and
 * the deterministic profile-scoped pipe on Windows. Keep this in sync with
 * src/host/paths.ts.
 */
function hostSocketPath(profileDir) {
  const scope = createHash('sha256').update(resolve(profileDir)).digest('hex').slice(0, 12)
  if (process.platform === 'win32') return `\\\\.\\pipe\\icode-host-${scope}`
  return join(profileDir, 'terminal-host.sock')
}

function baseEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function hostEnv() {
  return {
    ...baseEnv(),
    ICODE_HOST_DIR: HOST_DIR,
    ICODE_HOST_SOCKET: hostSocketPath(HOST_DIR)
  }
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env
  })
  if (result.error) fail(result.error.message)
  process.exit(result.status ?? 1)
}

function electron(args, env = baseEnv()) {
  run(ELECTRON, args, env)
}

function electronAsNode(script, env = hostEnv()) {
  run(ELECTRON, [script], { ...env, ELECTRON_RUN_AS_NODE: '1' })
}

function main(argv) {
  const command = argv[0]
  if (!command) fail('usage: node config/scripts/gates.cjs <command>')

  switch (command) {
    case 'pty':
      electronAsNode('tests/compat/pty-smoke.cjs')
      break
    case 'sqlite':
      electron(['.', '--icode-gate-sqlite'])
      break
    case 'host-start':
      electron(['.', '--icode-gate-host-start'], hostEnv())
      break
    case 'host-verify':
      electronAsNode('tests/compat/host-verify.cjs')
      break
    case 'reattach':
      electron(['.', '--icode-gate-reattach'], hostEnv())
      break
    case 'host-stop':
      electronAsNode('tests/compat/host-stop.cjs')
      break
    case 'packaged':
      run(process.execPath, ['tests/compat/packaged-smoke.cjs'], baseEnv())
      break
    case 'perf-scm': {
      // vitest's package exports do not expose its CLI file, but this is the
      // bin entry declared by its package.json.
      const vitest = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
      run(
        process.execPath,
        [
          vitest,
          'run',
          '--config',
          'config/vitest.config.mts',
          'src/main/git/git-workspace-service.test.ts',
          '-t',
          'reads 10k untracked files'
        ],
        { ...baseEnv(), ICODE_PERF: '1' }
      )
      break
    }
    default:
      fail(`unknown gate: ${command}`)
  }
}

try {
  main(process.argv.slice(2))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

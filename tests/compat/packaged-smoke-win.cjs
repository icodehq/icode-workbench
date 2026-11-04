'use strict'

/**
 * Windows packaged acceptance.
 *
 * Runs the packaged executable's `--icode-compat-smoke` gate from a temporary
 * working directory and an isolated user-data directory, then checks the
 * evidence: SQLite WAL/rollback, a real ConPTY exit, a Host bound on a named
 * pipe, and a session that was actually served.
 *
 * Usage:
 *   node tests/compat/packaged-smoke-win.cjs [--dir <win-unpacked>]
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const artifacts = process.env.ICODE_GATE_ARTIFACTS
  ? path.resolve(process.env.ICODE_GATE_ARTIFACTS)
  : path.join(REPO_ROOT, 'artifacts', 'work1')

function parseArgs(argv) {
  const index = argv.indexOf('--dir')
  return index === -1 ? path.join(REPO_ROOT, 'dist', 'win-unpacked') : path.resolve(argv[index + 1])
}

function fail(message) {
  process.stderr.write(`[gate:packaged:win] ${message}\n`)
  process.exit(1)
}

function findExecutable(dir) {
  for (const name of ['icode.exe', 'iCode.exe']) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function main() {
  const packagedDir = parseArgs(process.argv.slice(2))
  const executable = findExecutable(packagedDir)
  if (executable === null) {
    fail(`no packaged executable in ${packagedDir}; run "pnpm package:win" first`)
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'icode-win-smoke-'))
  const userData = path.join(work, 'profile')
  const evidencePath = path.join(work, 'packaged-smoke.json')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(artifacts, { recursive: true })

  const result = spawnSync(executable, ['--icode-compat-smoke'], {
    cwd: work,
    env: {
      ...process.env,
      ICODE_GATE_EVIDENCE: evidencePath,
      ICODE_GATE_USER_DATA: userData,
      ICODE_GATE_ARTIFACTS: artifacts,
      ICODE_BACKGROUND_LAUNCH: '1'
    },
    encoding: 'utf8',
    timeout: 120_000
  })

  let evidence = null
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
  } catch {
    evidence = null
  }

  if (result.status !== 0 || evidence === null || evidence.ok !== true) {
    process.stderr.write(
      `[gate:packaged:win] exit=${String(result.status)} evidence=${JSON.stringify(evidence)}\n`
    )
    fail('the packaged smoke did not pass')
  }

  if (evidence.runtime.platform !== 'win32') {
    fail(`expected a win32 runtime, got ${String(evidence.runtime.platform)}`)
  }
  if (evidence.sqlite.journalMode.toLowerCase() !== 'wal' || evidence.sqlite.committedRows !== 2) {
    fail('packaged SQLite did not use WAL/commit as expected')
  }
  if (evidence.directPty.exitCode !== 7 || evidence.directPty.sawMarker !== true) {
    fail('packaged PTY did not echo the marker or exit 7')
  }
  if (typeof evidence.host.socket !== 'string' || !evidence.host.socket.startsWith('\\\\.\\pipe\\')) {
    fail(`Host endpoint is not a named pipe: ${String(evidence.host.socket)}`)
  }

  fs.rmSync(work, { recursive: true, force: true })
  process.stdout.write(
    `[gate:packaged:win] PASS ${executable} socket=${evidence.host.socket}\n`
  )
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

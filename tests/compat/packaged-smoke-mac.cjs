'use strict'

/**
 * macOS packaged acceptance.
 *
 * Launches the packaged `.app` with a scrubbed PATH and a temporary HOME whose
 * login shell exposes a fake `claude`. It then runs, in order:
 *
 *  1. `--icode-gate-host-start` — starts a detached Host/PTY, then exits.
 *  2. `--icode-gate-reattach`   — a fresh app reattaches to that same PTY.
 *  3. `--icode-compat-smoke`    — packaged SQLite/PTY/Host plus the macOS
 *                                 login-environment, hook, and reattach probes.
 *
 * Every assertion is made from the evidence the packaged executable writes.
 *
 * Usage:
 *   node tests/compat/packaged-smoke-mac.cjs [--app <iCode.app>]
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const artifacts = process.env.ICODE_GATE_ARTIFACTS
  ? path.resolve(process.env.ICODE_GATE_ARTIFACTS)
  : path.join(REPO_ROOT, 'artifacts', 'packaged-mac')

function parseArgs(argv) {
  const index = argv.indexOf('--app')
  return { app: index === -1 ? null : path.resolve(argv[index + 1]) }
}

function fail(message) {
  process.stderr.write(`[gate:packaged:mac] ${message}\n`)
  process.exit(1)
}

function findApp(explicit) {
  if (explicit !== null) {
    if (fs.existsSync(path.join(explicit, 'Contents', 'MacOS'))) return explicit
    const nested = path.join(explicit, 'iCode.app')
    return fs.existsSync(path.join(nested, 'Contents', 'MacOS')) ? nested : null
  }
  const dist = path.join(REPO_ROOT, 'dist')
  if (!fs.existsSync(dist)) return null
  const direct = path.join(dist, 'iCode.app')
  if (fs.existsSync(direct)) return direct
  for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mac')) continue
    const candidate = path.join(dist, entry.name, 'iCode.app')
    if (fs.existsSync(path.join(candidate, 'Contents', 'MacOS'))) return candidate
  }
  return null
}

function findExecutable(app) {
  const macos = path.join(app, 'Contents', 'MacOS')
  for (const name of ['iCode', 'icode']) {
    const candidate = path.join(macos, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeFakeHarness(bin) {
  const harness = path.join(bin, 'claude')
  fs.writeFileSync(
    harness,
    '#!/bin/sh\n' +
      'if [ "$1" = "--version" ]; then\n' +
      '  echo "2.1.0 (Claude Code)"\n' +
      '  exit 0\n' +
      'fi\n' +
      'echo "fake claude"\n'
  )
  fs.chmodSync(harness, 0o755)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function main() {
  const app = findApp(parseArgs(process.argv.slice(2)).app)
  if (app === null) {
    fail('no packaged iCode.app in dist; run "pnpm package:mac" first')
  }
  const executable = findExecutable(app)
  if (executable === null) fail(`no executable under ${app}/Contents/MacOS`)

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'icode-mac-smoke-'))
  const home = path.join(work, 'home')
  // The login rc exposes `$HOME/bin`, so the fake harness lives there.
  const bin = path.join(home, 'bin')
  const profile = path.join(work, 'profile')
  const hostDir = path.join(work, 'host')
  for (const dir of [home, bin, profile, hostDir, artifacts]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  writeFakeHarness(bin)
  fs.writeFileSync(
    path.join(home, '.zshrc'),
    'export PATH="$HOME/bin:$PATH"\nexport LANG=en_US.UTF-8\n'
  )

  const evidencePath = path.join(artifacts, 'packaged-smoke-mac.json')
  const env = {
    HOME: home,
    USER: process.env.USER ?? 'runner',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'runner',
    SHELL: '/bin/zsh',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: os.tmpdir(),
    LANG: 'C',
    ICODE_GATE_USER_DATA: profile,
    ICODE_GATE_ARTIFACTS: artifacts,
    ICODE_GATE_EVIDENCE: evidencePath,
    ICODE_HOST_DIR: hostDir,
    ICODE_GATE_EXPECT_CLAUDE: '1',
    ICODE_GATE_HARNESS_DIR: bin,
    ICODE_GATE_EXPECT_ACTIVITY: '1',
    ICODE_GATE_EXPECT_REATTACH: '1',
    ICODE_BACKGROUND_LAUNCH: '1'
  }
  const run = (args) =>
    spawnSync(executable, args, {
      cwd: work,
      env,
      encoding: 'utf8',
      timeout: 180_000
    })

  const start = run(['--icode-gate-host-start'])
  if (start.status !== 0) {
    process.stderr.write(`${start.stdout ?? ''}${start.stderr ?? ''}\n`)
    fail(`host-start gate failed (exit ${String(start.status)})`)
  }
  const startEvidence = readJson(path.join(artifacts, 'host-start.json'))
  assert(startEvidence !== null && startEvidence.ok === true, 'host-start evidence is not ok')

  const reattach = run(['--icode-gate-reattach'])
  if (reattach.status !== 0) {
    process.stderr.write(`${reattach.stdout ?? ''}${reattach.stderr ?? ''}\n`)
    fail(`reattach gate failed (exit ${String(reattach.status)})`)
  }
  const reattachEvidence = readJson(path.join(artifacts, 'reattach.json'))
  assert(reattachEvidence !== null && reattachEvidence.ok === true, 'reattach evidence is not ok')
  assert(reattachEvidence.created === false, 'reattach created a duplicate PTY')
  assert(
    reattachEvidence.originalPtyPid === reattachEvidence.reattachedPtyPid,
    'reattach changed the PTY pid'
  )

  const smoke = run(['--icode-compat-smoke'])
  const evidence = readJson(evidencePath)
  if (smoke.status !== 0 || evidence === null || evidence.ok !== true) {
    process.stderr.write(`exit=${String(smoke.status)} evidence=${JSON.stringify(evidence)}\n`)
    fail('the packaged smoke did not pass')
  }

  assert(evidence.runtime.platform === 'darwin', `expected darwin, got ${evidence.runtime.platform}`)
  assert(
    evidence.runtime.arch === process.arch,
    `expected ${process.arch}, got ${evidence.runtime.arch}`
  )
  assert(evidence.runtime.isPackaged === true, 'the smoke did not run from a packaged app')
  assert(
    evidence.sqlite.journalMode.toLowerCase() === 'wal' && evidence.sqlite.committedRows === 2,
    'packaged SQLite did not use WAL/commit as expected'
  )
  assert(
    evidence.directPty.exitCode === 7 && evidence.directPty.sawMarker === true,
    'packaged PTY did not echo the marker or exit 7'
  )

  assert(evidence.loginEnvironment.shell === '/bin/zsh', 'login shell was not resolved')
  assert(
    evidence.loginEnvironment.path.split(':').includes(bin),
    `login PATH did not include the fake harness dir: ${evidence.loginEnvironment.path}`
  )
  assert(
    /utf-?8/i.test(evidence.loginEnvironment.lang ?? ''),
    `login locale is not UTF-8: ${String(evidence.loginEnvironment.lang)}`
  )

  assert(evidence.claude !== null, 'Claude was not detected through the login environment')
  assert(evidence.claude.state === 'available', `Claude state: ${evidence.claude.state}`)
  assert(
    evidence.claude.resolvedPath.startsWith(bin),
    `Claude resolved outside the fake harness dir: ${evidence.claude.resolvedPath}`
  )
  assert(evidence.claude.version !== null, 'Claude version probe returned no version')

  assert(evidence.activity !== null && evidence.activity.delivered === true, 'hook did not deliver')
  assert(evidence.activity.event === 'Stop', `hook event was ${evidence.activity.event}`)
  assert(Buffer.byteLength(evidence.activity.socket) <= 104, 'activity socket path is too long')

  assert(evidence.host.socket.startsWith('/'), `Host endpoint is not a Unix socket: ${evidence.host.socket}`)
  assert(Buffer.byteLength(evidence.host.socket) <= 104, 'Host socket path is too long')
  assert(evidence.host.reattach !== null, 'packaged Host did not reattach')
  assert(evidence.host.reattach.created === false, 'packaged reattach created a new PTY')
  assert(
    evidence.host.reattach.incarnationId === evidence.host.incarnationId,
    'packaged reattach changed the incarnation'
  )
  assert(evidence.host.reattach.ptyPid === evidence.host.ptyPid, 'packaged reattach changed the PTY')

  fs.rmSync(work, { recursive: true, force: true })
  process.stdout.write(
    `[gate:packaged:mac] PASS ${executable} socket=${evidence.host.socket} ` +
      `activity=${evidence.activity.socket}\n`
  )
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

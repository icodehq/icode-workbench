'use strict'

/**
 * Gate 5: run the packaged directory build from outside the repository and
 * exercise SQLite, native node-pty, and the unpacked detached host.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '../..')
const artifacts = process.env.ICODE_GATE_ARTIFACTS
  ? path.resolve(process.env.ICODE_GATE_ARTIFACTS)
  : path.join(root, 'artifacts', 'work1')
// Why: electron-builder's pnpm dependency scan can be prohibitively slow on
// DrvFs/9p mounts, so the package may be produced on a POSIX filesystem.
const packagedDir = process.env.ICODE_GATE_PACKAGED_DIR
  ? path.resolve(process.env.ICODE_GATE_PACKAGED_DIR)
  : path.join(root, 'dist', 'linux-unpacked')
const executable = path.join(packagedDir, 'icode')
const resources = path.join(packagedDir, 'resources')
const evidencePath = path.join(artifacts, 'packaged-smoke.json')
const runPath = path.join(artifacts, 'packaged-run.json')
// Why not artifacts/: DrvFs (/mnt/d) cannot enforce the host's 0700/0600
// requirement, and the real userData directory lives on a POSIX filesystem.
//
// Every run gets its own profile *and* runtime directory. XDG_RUNTIME_DIR is
// shared by all iCode instances the user runs, so the smoke must never inherit the
// user's: doing so previously let a gate host unlink the user's live socket.
let runRoot = null
let userData = null
let runtimeDir = null

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** True when `child` is `parent` or lives underneath it. */
function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** The socket this smoke run's Host actually bound, from its own profile log. */
function hostSocketFromLog() {
  const logPath = path.join(userData, 'run', 'host.log')
  try {
    return fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'host-started')?.socket ?? null
  } catch {
    return null
  }
}

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === name) return full
    }
  }
  return null
}

function main() {
  fs.mkdirSync(artifacts, { recursive: true })
  // Created before the packaged check so the paths exist for the record, but
  // removed again if the package is missing (nothing ran).
  runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icode-packaged-smoke-'))
  userData = path.join(runRoot, 'user-data')
  runtimeDir = path.join(runRoot, 'run')
  const checks = {
    packagedDir: fs.existsSync(packagedDir),
    executable: fs.existsSync(executable),
    hostEntry: fs.existsSync(path.join(resources, 'app.asar.unpacked', 'out', 'host', 'index.js')),
    ptyNode:
      findFile(
        path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release'),
        'pty.node'
      ) ?? findFile(path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'), 'pty.node'),
    asar: fs.existsSync(path.join(resources, 'app.asar'))
  }

  if (!checks.packagedDir || !checks.executable) {
    fs.rmSync(runRoot, { recursive: true, force: true })
    writeJson(runPath, { ok: false, error: 'Packaged directory or executable is missing', checks })
    process.stderr.write('[gate:packaged] packaged app is missing\n')
    process.exit(1)
  }
  if (!checks.hostEntry || !checks.ptyNode) {
    fs.rmSync(runRoot, { recursive: true, force: true })
    writeJson(runPath, {
      ok: false,
      error: 'Required unpacked host entry or native PTY is missing',
      checks
    })
    process.stderr.write('[gate:packaged] unpacked host/native dependency is missing\n')
    process.exit(1)
  }

  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  // The runtime directory carries the singleton socket and the Host endpoint,
  // so it must be owner-only.
  fs.chmodSync(runtimeDir, 0o700)
  fs.rmSync(evidencePath, { force: true })

  const startedAt = Date.now()
  const result = spawnSync(executable, ['--icode-compat-smoke'], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      ICODE_GATE_EVIDENCE: evidencePath,
      ICODE_GATE_USER_DATA: userData,
      ICODE_GATE_ARTIFACTS: artifacts,
      ICODE_BACKGROUND_LAUNCH: '1',
      XDG_RUNTIME_DIR: runtimeDir
    },
    encoding: 'utf8',
    timeout: 120000
  })
  const durationMs = Date.now() - startedAt
  let packagedEvidence = null
  try {
    packagedEvidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
  } catch {
    packagedEvidence = null
  }

  // The Host must have bound inside this run's runtime directory, not the
  // user's. Evidence comes from the run's own profile log and from the gate.
  const socket = hostSocketFromLog()
  const reportedSocket = packagedEvidence?.host?.socket ?? null
  const isolation = {
    runtimeDir,
    socket,
    reportedSocket,
    socketInsideRuntime: socket !== null && isInside(runtimeDir, socket),
    reportedSocketInsideRuntime:
      reportedSocket === null || isInside(runtimeDir, reportedSocket),
    socketMatchesReported: reportedSocket === null || reportedSocket === socket
  }
  const isolated =
    isolation.socketInsideRuntime &&
    isolation.reportedSocketInsideRuntime &&
    isolation.socketMatchesReported

  const record = {
    ok: result.status === 0 && packagedEvidence?.ok === true && isolated,
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs,
    cwd: os.tmpdir(),
    executable,
    userData,
    runtimeDir,
    checks,
    isolation,
    packagedEvidence,
    stdoutTail: (result.stdout || '').slice(-2000),
    stderrTail: (result.stderr || '').slice(-4000)
  }
  writeJson(runPath, record)

  if (!record.ok) {
    process.stderr.write(`[gate:packaged] failed (exit=${String(result.status)})\n`)
    if (!isolated) {
      process.stderr.write(
        `[gate:packaged] Host socket is not isolated to ${runtimeDir} (socket=${String(socket)} reported=${String(reportedSocket)})\n`
      )
    }
    process.stderr.write(record.stderrTail)
    process.exit(1)
  }
  process.stdout.write(
    `ICODE_GATE_PACKAGED_OK electron=${packagedEvidence.runtime.electron} abi=${packagedEvidence.runtime.modules} socket=${socket}\n`
  )
}

main()

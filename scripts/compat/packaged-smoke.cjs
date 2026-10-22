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
const artifacts = process.env.ADE_GATE_ARTIFACTS
  ? path.resolve(process.env.ADE_GATE_ARTIFACTS)
  : path.join(root, 'artifacts', 'work1')
// Why: electron-builder's pnpm dependency scan can be prohibitively slow on
// DrvFs/9p mounts, so the package may be produced on a POSIX filesystem.
const packagedDir = process.env.ADE_GATE_PACKAGED_DIR
  ? path.resolve(process.env.ADE_GATE_PACKAGED_DIR)
  : path.join(root, 'dist', 'linux-unpacked')
const executable = path.join(packagedDir, 'ade')
const resources = path.join(packagedDir, 'resources')
const evidencePath = path.join(artifacts, 'packaged-smoke.json')
const runPath = path.join(artifacts, 'packaged-run.json')
// Why not artifacts/: DrvFs (/mnt/d) cannot enforce the host's 0700/0600
// requirement, and the real userData directory lives on a POSIX filesystem.
const userData = path.join(os.tmpdir(), 'ade-packaged-smoke-user-data')

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
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
    writeJson(runPath, { ok: false, error: 'Packaged directory or executable is missing', checks })
    process.stderr.write('[gate:packaged] packaged app is missing\n')
    process.exit(1)
  }
  if (!checks.hostEntry || !checks.ptyNode) {
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
  fs.rmSync(evidencePath, { force: true })

  const startedAt = Date.now()
  const result = spawnSync(executable, ['--ade-compat-smoke'], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      ADE_GATE_EVIDENCE: evidencePath,
      ADE_GATE_USER_DATA: userData,
      ADE_GATE_ARTIFACTS: artifacts,
      ADE_BACKGROUND_LAUNCH: '1'
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

  const record = {
    ok: result.status === 0 && packagedEvidence?.ok === true,
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs,
    cwd: os.tmpdir(),
    executable,
    userData,
    checks,
    packagedEvidence,
    stdoutTail: (result.stdout || '').slice(-2000),
    stderrTail: (result.stderr || '').slice(-4000)
  }
  writeJson(runPath, record)

  if (!record.ok) {
    process.stderr.write(`[gate:packaged] failed (exit=${String(result.status)})\n`)
    process.stderr.write(record.stderrTail)
    process.exit(1)
  }
  process.stdout.write(
    `ADE_GATE_PACKAGED_OK electron=${packagedEvidence.runtime.electron} abi=${packagedEvidence.runtime.modules}\n`
  )
}

main()

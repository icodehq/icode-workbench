'use strict'

/**
 * Self-test for `prepare-artifacts.cjs`.
 *
 * Every case runs against a **temporary copy** of the artifact tree. The real
 * `artifacts/wsl-host/linux-x64` is never renamed, deleted or corrupted: it is
 * the only verified tree on this machine, and a negative test that destroys it
 * would trade a test result for a broken release.
 *
 * The copy is laid out exactly as the repository is — `<root>/scripts/wsl` plus
 * `<root>/artifacts/...` plus `<root>/out/host/index.js` — because the script
 * resolves those paths relative to its own location. That is also what proves the
 * real layout logic, rather than a stubbed one.
 */

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const REAL_TREE = path.join(REPO_ROOT, 'artifacts', 'wsl-host', 'linux-x64')
const SOURCE_SCRIPTS = __dirname

let failures = 0
function check(name, ok, detail) {
  if (ok) {
    process.stdout.write(`PASS ${name}\n`)
    return
  }
  failures += 1
  process.stdout.write(`FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`)
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Hashes of the real tree, to prove the tests did not touch it. */
function snapshotRealTree() {
  const files = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const relative = path.relative(REAL_TREE, full).replace(/\\/g, '/')
      if (entry.isDirectory()) walk(full)
      else files[relative] = sha256(full)
    }
  }
  walk(REAL_TREE)
  return files
}

/** A disposable repository-shaped root with a copy of the scripts and tree. */
function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icode-prepare-fixture-'))
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.cpSync(SOURCE_SCRIPTS, path.join(root, 'scripts', 'wsl'), { recursive: true })
  fs.mkdirSync(path.join(root, 'artifacts', 'wsl-host'), { recursive: true })
  fs.cpSync(REAL_TREE, path.join(root, 'artifacts', 'wsl-host', 'linux-x64'), {
    recursive: true
  })
  fs.mkdirSync(path.join(root, 'out', 'host'), { recursive: true })
  fs.copyFileSync(
    path.join(REPO_ROOT, 'out', 'host', 'index.js'),
    path.join(root, 'out', 'host', 'index.js')
  )
  return root
}

/** Runs the fixture's prepare script; returns `{ status, stdout, stderr }`. */
function runPrepare(root, env = process.env) {
  const script = path.join(root, 'scripts', 'wsl', 'prepare-artifacts.cjs')
  try {
    const stdout = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? '')
    }
  }
}

function treeOf(root) {
  return path.join(root, 'artifacts', 'wsl-host', 'linux-x64')
}

function main() {
  if (!fs.existsSync(path.join(REAL_TREE, 'manifest.json'))) {
    process.stderr.write(`no verified tree to copy at ${REAL_TREE}\n`)
    return 1
  }
  const before = snapshotRealTree()

  // --- positive: an intact tree is accepted without rebuilding.
  {
    const root = makeFixtureRoot()
    const result = runPrepare(root)
    check(
      'an intact tree verifies and is reused (no rebuild)',
      result.status === 0 && /verified \d+ files/.test(result.stdout),
      `${result.status} ${result.stdout.trim().split('\n').slice(-1)}`
    )
    check(
      'nothing is downloaded when the tree already verifies',
      !/building node-pty|downloading Node/.test(result.stdout),
      result.stdout.trim().split('\n').slice(-2).join(' | ')
    )
    fs.rmSync(root, { recursive: true, force: true })
  }

  // --- negative: no manifest at all, and nothing can produce one.
  //
  // A missing tree is normal on a fresh checkout, so the script tries to build;
  // what must fail is the case where it *cannot*. Stripping PATH makes Docker
  // unavailable exactly as it is on a machine without it.
  {
    const root = makeFixtureRoot()
    fs.rmSync(treeOf(root), { recursive: true, force: true })
    const result = runPrepare(root, { ...process.env, PATH: '/nonexistent-bin' })
    check(
      'absent artifacts that cannot be built stop packaging',
      result.status === 1 && /docker/i.test(result.stderr),
      result.stderr.trim().split('\n')[0]
    )
    check(
      'the failure names the corrective action',
      /build:wsl-host|package:win/.test(result.stderr),
      result.stderr.trim().split('\n').filter(Boolean).slice(-2, -1)[0] ?? ''
    )
    fs.rmSync(root, { recursive: true, force: true })
  }

  // --- negative: manifest present, runtime bundle absent.
  {
    const root = makeFixtureRoot()
    fs.rmSync(path.join(treeOf(root), 'host', 'index.js'))
    const result = runPrepare(root)
    check(
      'a manifest-declared file that is absent stops packaging',
      result.status === 1 && /host\/index\.js/.test(result.stderr),
      result.stderr.trim().split('\n')[0]
    )
    fs.rmSync(root, { recursive: true, force: true })
  }

  // --- negative: a manifest-declared runtime file is absent.
  {
    const root = makeFixtureRoot()
    fs.rmSync(path.join(treeOf(root), 'node', 'bin', 'node'))
    const result = runPrepare(root)
    check(
      'a missing manifest-declared file fails with its path',
      result.status === 1 && /node\/bin\/node/.test(result.stderr),
      result.stderr.trim().split('\n')[0]
    )
    fs.rmSync(root, { recursive: true, force: true })
  }

  // --- negative: a manifest-declared file fails its hash.
  {
    const root = makeFixtureRoot()
    const victim = path.join(treeOf(root), 'host', 'index.js')
    const bytes = fs.readFileSync(victim)
    bytes[0] = bytes[0] ^ 0xff
    fs.writeFileSync(victim, bytes)
    const result = runPrepare(root)
    check(
      'a corrupted runtime file fails with a hash mismatch',
      result.status === 1 && /hash mismatch/i.test(result.stderr),
      result.stderr.trim().split('\n')[0]
    )
    check(
      'the mismatch names the file and both hashes',
      /host\/index\.js/.test(result.stderr) && /manifest /.test(result.stderr) && /on disk/.test(result.stderr),
      result.stderr.trim().split('\n').slice(0, 3).join(' | ')
    )
    fs.rmSync(root, { recursive: true, force: true })
  }

  // --- fallback: no `objdump` on the host (as on Windows).
  {
    const root = makeFixtureRoot()
    const result = runPrepare(root, { ...process.env, PATH: '/nonexistent-bin' })
    check(
      'without objdump the tree still verifies on hashes',
      result.status === 0 && /objdump is unavailable/.test(result.stdout),
      `${result.status} ${result.stdout.trim().split('\n').slice(-1)}`
    )
    fs.rmSync(root, { recursive: true, force: true })
  }

  // --- the real tree must be byte-identical afterwards.
  const after = snapshotRealTree()
  check(
    'the real artifact tree is unchanged by the tests',
    Object.keys(before).length === Object.keys(after).length &&
      Object.keys(before).every((file) => before[file] === after[file]),
    `${Object.keys(before).length} files before, ${Object.keys(after).length} after`
  )

  process.stdout.write(failures === 0 ? '\nSELFTEST PASS\n' : `\nSELFTEST FAIL (${failures})\n`)
  return failures === 0 ? 0 : 1
}

process.exit(main())

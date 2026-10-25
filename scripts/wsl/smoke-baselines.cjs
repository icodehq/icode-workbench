'use strict'

/**
 * Runs the shipped native artifact under the pinned Node on each declared
 * baseline distro.
 *
 * The check is only meaningful with the *artifact's* Node and *artifact's*
 * pty.node: using the host's Node would prove the host's glibc, not the
 * deployment target's. Each image gets the tree mounted read-only and nothing
 * else — no apt install, no build tools.
 *
 * Usage: node scripts/wsl/smoke-baselines.cjs [--tree <dir>]
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_TREE = path.resolve(__dirname, '..', '..', 'artifacts', 'wsl-host', 'linux-x64')

/** Declared baseline first, then the two newer baselines the artifact must also serve. */
const BASELINES = [
  { image: 'ubuntu:22.04', glibc: '2.35' },
  { image: 'ubuntu:24.04', glibc: '2.39' },
  { image: 'ubuntu:26.04', glibc: '2.43' }
]

const PROBE = `
const pty = require('/tree/node_modules/node-pty')
const t = pty.spawn('/bin/echo', ['BASELINE_PTY_OK'], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp',
  env: { ...process.env, TERM: 'xterm-256color' }
})
let out = ''
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 8000)
t.onData((d) => { out += d })
t.onExit(({ exitCode }) => {
  clearTimeout(timer)
  const ok = out.includes('BASELINE_PTY_OK') && exitCode === 0
  console.log('pid=' + t.pid + ' exit=' + exitCode + ' output=' + JSON.stringify(out.trim()))
  console.log(ok ? 'BASELINE_RESULT=PASS' : 'BASELINE_RESULT=FAIL')
  process.exit(ok ? 0 : 1)
})
`

function main() {
  const treeArg = process.argv.indexOf('--tree')
  const tree = treeArg === -1 ? DEFAULT_TREE : path.resolve(process.argv[treeArg + 1])
  if (!fs.existsSync(path.join(tree, 'node', 'bin', 'node'))) {
    process.stderr.write(`[wsl-baseline] FAILED: no Node runtime in ${tree}\n`)
    return 1
  }

  // The probe rides a read-only mount rather than an env var: docker forwards
  // only explicitly requested environment, and a multiline script does not
  // survive shell quoting reliably.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-wsl-probe-'))
  const probePath = path.join(probeDir, 'probe.cjs')
  fs.writeFileSync(probePath, PROBE)

  let failures = 0
  for (const baseline of BASELINES) {
    process.stdout.write(`[wsl-baseline] ${baseline.image} (expect glibc ${baseline.glibc})\n`)
    try {
      const output = execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${tree}:/tree:ro`,
          '-v',
          `${probePath}:/probe.cjs:ro`,
          baseline.image,
          'bash',
          '-lc',
          // Report the real libc, then run the artifact's Node against its own pty.node.
          'echo "glibc=$(ldd --version | head -1 | awk \'{print $NF}\')"; /tree/node/bin/node /probe.cjs'
        ],
        { encoding: 'utf8' }
      )
      for (const line of output.trim().split('\n')) process.stdout.write(`  ${line}\n`)
      if (!output.includes('BASELINE_RESULT=PASS')) failures += 1
    } catch (error) {
      process.stderr.write(`  FAILED: ${error.message.split('\n')[0]}\n`)
      failures += 1
    }
  }

  fs.rmSync(probeDir, { recursive: true, force: true })

  if (failures > 0) {
    process.stderr.write(`[wsl-baseline] FAILED on ${failures} baseline(s)\n`)
    return 1
  }
  process.stdout.write(`[wsl-baseline] PASS on all ${BASELINES.length} baselines\n`)
  return 0
}

process.exit(main())

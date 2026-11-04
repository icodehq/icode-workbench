'use strict'

/**
 * Gate 2: Electron-ABI node-pty under ELECTRON_RUN_AS_NODE=1.
 * Uses the real Electron runtime; standalone Node cannot produce process.versions.electron.
 */

const fs = require('node:fs')
const path = require('node:path')
const pty = require('node-pty')

const EXPECTED_ELECTRON = '43.7.8'
const EXPECTED_ABI = '148'
const artifacts = process.env.ICODE_GATE_ARTIFACTS
  ? path.resolve(process.env.ICODE_GATE_ARTIFACTS)
  : path.resolve('artifacts/work1')
const evidencePath = path.join(artifacts, 'pty-smoke.json')

function writeEvidence(value) {
  fs.mkdirSync(artifacts, { recursive: true })
  fs.writeFileSync(evidencePath, `${JSON.stringify(value, null, 2)}\n`)
}

function fail(error) {
  writeEvidence({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    runtime: {
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      modules: process.versions.modules,
      pid: process.pid,
      execPath: process.execPath
    }
  })
  process.stderr.write(`[gate:pty] ${String(error)}\n`)
  process.exit(1)
}

async function main() {
  const electron = process.versions.electron ?? null
  const modules = process.versions.modules ?? null
  if (electron !== EXPECTED_ELECTRON) {
    throw new Error(`Expected Electron ${EXPECTED_ELECTRON}, got ${String(electron)}`)
  }
  if (modules !== EXPECTED_ABI) {
    throw new Error(`Expected Electron ABI ${EXPECTED_ABI}, got ${String(modules)}`)
  }

  const shell =
    process.platform === 'win32'
      ? process.env.ComSpec || 'cmd.exe'
      : process.env.SHELL || '/bin/bash'
  // Bash-only flags would break zsh and cmd.exe; the marker command itself is
  // portable across bash, zsh, PowerShell, and cmd.
  const shellArgs = /(?:^|[\\/])bash(?:\.exe)?$/iu.test(shell) ? ['--noprofile', '--norc'] : []
  const output = await new Promise((resolve, reject) => {
    const term = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' }
    })
    let data = ''
    const timer = setTimeout(() => {
      try {
        term.kill()
      } catch {
        // already gone
      }
      reject(new Error(`PTY timed out. Output: ${JSON.stringify(data.slice(-500))}`))
    }, 10000)
    term.onData((chunk) => {
      data += chunk
    })
    term.onExit(({ exitCode, signal }) => {
      clearTimeout(timer)
      resolve({ data, exitCode, signal, pid: term.pid })
    })
    // PowerShell's line editor treats \n as a continuation; a PTY Enter is \r.
    term.write(`echo GOT:hello; exit 7${process.platform === 'win32' ? '\r' : '\n'}`)
  })

  if (!output.data.includes('GOT:hello')) {
    throw new Error(`PTY did not echo marker. Output: ${JSON.stringify(output.data)}`)
  }
  if (output.exitCode !== 7) {
    throw new Error(`Expected exit code 7, got ${output.exitCode}`)
  }
  if (!(output.pid > 0)) {
    throw new Error('node-pty did not report a child pid')
  }

  const evidence = {
    ok: true,
    evidencePath,
    runtime: {
      electron,
      node: process.versions.node,
      modules,
      chrome: process.versions.chrome ?? null,
      pid: process.pid,
      execPath: process.execPath,
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === '1'
    },
    pty: {
      shell,
      ptyPid: output.pid,
      exitCode: output.exitCode,
      signal: output.signal ?? null,
      sawMarker: true,
      outputTail: output.data.slice(-400)
    }
  }
  writeEvidence(evidence)
  process.stdout.write(`ICODE_GATE_PTY_OK ${JSON.stringify(evidence.pty)}\n`)
}

main().catch(fail)

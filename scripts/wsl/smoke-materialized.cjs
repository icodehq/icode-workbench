'use strict'

/**
 * Proves the artifact tree is deployable on its own.
 *
 * Copies it to a directory outside the repository, then runs the tree's own Node
 * — never the host's — to start the Host from the tree, spawn a PTY, and stream
 * output back. Two assertions matter most:
 *
 *   - `require.resolve('node-pty')` lands inside the copied tree, so nothing
 *     depends on the repository's node_modules or build output;
 *   - the Host handshake succeeds with the protocol this repository speaks, so a
 *     deployment target runs the same contract as a local Host.
 *
 * Usage: node scripts/wsl/smoke-materialized.cjs [--tree <dir>]
 */

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_TREE = path.resolve(__dirname, '..', '..', 'artifacts', 'wsl-host', 'linux-x64')

function log(message) {
  process.stdout.write(`[wsl-smoke] ${message}\n`)
}

function fail(message) {
  throw new Error(message)
}

/** Minimal Host client: newline-delimited JSON, one outstanding request at a time. */
function connect(socketPath, token) {
  const socket = net.connect(socketPath)
  let buffer = ''
  let output = ''
  let exitCode = null
  const waiters = new Map()

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.type === 'event') {
        if (message.event === 'data') output += message.data
        if (message.event === 'exit') exitCode = message.exitCode
      } else if (message.type === 'hello') {
        waiters.get('hello')?.(message)
      } else if (message.id && waiters.has(message.id)) {
        waiters.get(message.id)(message)
        waiters.delete(message.id)
      }
    }
  })

  const hello = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('hello timed out')), 10000)
      waiters.set('hello', (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      socket.write(JSON.stringify({ type: 'hello', protocolVersion: 1, token, clientId: 'wsl-smoke' }) + '\n')
    })

  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10000)
      waiters.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      socket.write(JSON.stringify({ type: 'request', id, method, params }) + '\n')
    })

  return { socket, hello, request, get output() { return output }, get exitCode() { return exitCode } }
}

async function main() {
  const treeArg = process.argv.indexOf('--tree')
  const tree = treeArg === -1 ? DEFAULT_TREE : path.resolve(process.argv[treeArg + 1])
  if (!fs.existsSync(tree)) fail(`no artifact tree at ${tree}; run "node scripts/wsl/host-artifacts.cjs build"`)

  // Copy out of the repository: a deployment target does not have one.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'icode-wsl-materialized-'))
  const deploy = path.join(work, 'wsl-host')
  const runDir = path.join(work, 'run')
  fs.cpSync(tree, deploy, { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  log(`materialized into ${deploy}`)

  const treeNode = path.join(deploy, 'node', 'bin', 'node')
  const cleanEnv = { ...process.env }
  for (const key of ['NODE_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete cleanEnv[key]
  cleanEnv.PATH = `${path.join(deploy, 'node', 'bin')}:${cleanEnv.PATH ?? ''}`

  let cleanup = () => {}
  try {
    // --- self-containment: resolution must land inside the copied tree
    const resolved = execFileSync(
      treeNode,
      ['-e', 'process.stdout.write(require.resolve("node-pty"))'],
      { cwd: path.join(deploy, 'host'), env: cleanEnv, encoding: 'utf8' }
    ).trim()
    if (!resolved.startsWith(deploy)) {
      fail(`node-pty resolved outside the deployment tree: ${resolved}`)
    }
    if (resolved.includes('WSLProjects')) {
      fail(`node-pty resolution reached back into the repository: ${resolved}`)
    }
    log(`resolve ok: ${resolved.replace(deploy, '<tree>')}`)

    // --- Host startup from the tree, under the tree's own Node
    const socketPath = path.join(runDir, 'terminal-host.sock')
    const child = spawn(treeNode, [path.join(deploy, 'host', 'index.js')], {
      cwd: path.join(deploy, 'host'),
      env: { ...cleanEnv, ICODE_HOST_DIR: runDir, ICODE_HOST_SOCKET: socketPath },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })
    cleanup = () => {
      try { child.kill('SIGTERM') } catch {}
    }

    const deadline = Date.now() + 15000
    const ready = () => fs.existsSync(socketPath) && fs.existsSync(path.join(runDir, 'meta.json'))
    while (!ready()) {
      if (Date.now() > deadline) fail(`Host did not start; stderr=${stderr.slice(0, 300)}`)
      await new Promise((r) => setTimeout(r, 100))
    }
    const token = fs.readFileSync(path.join(runDir, 'token'), 'utf8').trim()
    log('Host started from the tree')

    // --- protocol: handshake, PTY, output
    const client = connect(socketPath, token)
    const hello = await client.hello()
    if (!hello.ok) fail(`hello failed: ${JSON.stringify(hello.error)}`)
    log(`hello ok (protocol v${hello.protocolVersion}, host ${hello.hostVersion})`)

    const created = await client.request('r1', 'createOrAttach', {
      sessionId: 'ses_wsl_smoke',
      cwd: '/tmp',
      command: '/bin/sh',
      args: ['-c', 'printf WSL_HOST_SMOKE_OK'],
      cols: 80,
      rows: 24
    })
    if (!created.ok) fail(`createOrAttach failed: ${JSON.stringify(created.error)}`)
    log(`pty live (pid ${created.payload.ptyPid})`)

    const end = Date.now() + 8000
    while (client.exitCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    if (client.exitCode !== 0) fail(`PTY child exited ${client.exitCode}`)
    if (!client.output.includes('WSL_HOST_SMOKE_OK')) {
      fail(`PTY output missing the marker; saw ${JSON.stringify(client.output.slice(0, 200))}`)
    }
    log(`output ok: ${JSON.stringify(client.output.trim())}`)

    await client.request('r2', 'shutdown', {}).catch(() => {})
    client.socket.end()
    log('PASS')
  } finally {
    cleanup()
    await new Promise((r) => setTimeout(r, 300))
    fs.rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`[wsl-smoke] FAILED: ${error.message}\n`)
  process.exit(1)
})

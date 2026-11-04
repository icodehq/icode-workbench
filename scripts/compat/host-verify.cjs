'use strict'

/**
 * Gate 3b: verify that the host outlived the Electron app that created it.
 * Runs under Electron-as-Node so it uses the same Electron binary/reporting.
 */

const fs = require('node:fs')
const path = require('node:path')
const { HostClient } = require('./lib/host-client.cjs')

const artifacts = process.env.ICODE_GATE_ARTIFACTS
  ? path.resolve(process.env.ICODE_GATE_ARTIFACTS)
  : path.resolve('artifacts/work1')
const startPath = path.join(artifacts, 'host-start.json')
const evidencePath = path.join(artifacts, 'host-verify.json')

function writeEvidence(value) {
  fs.mkdirSync(artifacts, { recursive: true })
  fs.writeFileSync(evidencePath, `${JSON.stringify(value, null, 2)}\n`)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function procStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    const fields = stat.slice(close + 2).split(' ')
    return { ppid: Number(fields[1]), state: fields[0] }
  } catch {
    return null
  }
}

function modeOf(file) {
  try {
    return (fs.statSync(file).mode & 0o777).toString(8)
  } catch {
    return null
  }
}

async function main() {
  const start = JSON.parse(fs.readFileSync(startPath, 'utf8'))
  if (!start.ok) throw new Error('host-start evidence is not ok')
  const session = start.session
  const token = fs.readFileSync(path.join(start.hostDir, 'token'), 'utf8').trim()
  const meta = JSON.parse(fs.readFileSync(path.join(start.hostDir, 'meta.json'), 'utf8'))

  const hostAlive = isAlive(session.hostPid)
  const ptyAlive = isAlive(session.ptyPid)
  const originatingAppPid = typeof start.runtime?.pid === 'number' ? start.runtime.pid : null
  const originatingAppAlive = originatingAppPid === null ? null : isAlive(originatingAppPid)
  const client = await HostClient.connect(session.socket, token)
  const listed = await client.request('listSessions')
  const entry = listed.sessions.find((item) => item.sessionId === session.sessionId)
  client.close()

  const result = {
    ok: true,
    runtime: {
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      modules: process.versions.modules,
      pid: process.pid,
      execPath: process.execPath
    },
    host: {
      pid: session.hostPid,
      alive: hostAlive,
      proc: procStat(session.hostPid),
      recordedPid: meta.pid,
      startedAt: meta.startedAt,
      socketMode: modeOf(session.socket),
      tokenMode: modeOf(path.join(start.hostDir, 'token'))
    },
    session: {
      sessionId: session.sessionId,
      ptyPid: session.ptyPid,
      ptyAlive,
      ptyProc: procStat(session.ptyPid),
      presentInHost: Boolean(entry),
      incarnationId: entry?.incarnationId ?? null,
      status: entry?.status ?? null
    },
    originatingApp: { pid: originatingAppPid, alive: originatingAppAlive },
    hostSessionCount: listed.sessions.length,
    evidencePath
  }

  if (originatingAppAlive !== false) {
    throw new Error(`Originating app ${String(originatingAppPid)} is still alive`)
  }
  if (!hostAlive) throw new Error(`Host ${session.hostPid} is not alive after the app exited`)
  if (!ptyAlive) throw new Error(`PTY ${session.ptyPid} is not alive after the app exited`)
  if (!entry) throw new Error('Host no longer lists the original session')
  if (entry.incarnationId !== session.incarnationId) throw new Error('Incarnation changed')
  if (result.host.tokenMode !== '600') throw new Error(`Token mode is ${result.host.tokenMode}`)
  if (result.host.socketMode !== '600') throw new Error(`Socket mode is ${result.host.socketMode}`)

  writeEvidence(result)
  process.stdout.write(
    `ICODE_GATE_HOST_VERIFY_OK host=${session.hostPid} pty=${session.ptyPid} session=${session.sessionId}\n`
  )
}

main().catch((error) => {
  writeEvidence({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  })
  process.stderr.write(`[gate:host:verify] ${String(error)}\n`)
  process.exit(1)
})

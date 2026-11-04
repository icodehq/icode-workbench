'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { HostClient } = require('./lib/host-client.cjs')

const artifacts = process.env.ICODE_GATE_ARTIFACTS
  ? path.resolve(process.env.ICODE_GATE_ARTIFACTS)
  : path.resolve('artifacts/work1')
const startPath = path.join(artifacts, 'host-start.json')
const evidencePath = path.join(artifacts, 'host-stop.json')

function writeEvidence(value) {
  fs.mkdirSync(artifacts, { recursive: true })
  fs.writeFileSync(evidencePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function main() {
  let start
  try {
    start = JSON.parse(fs.readFileSync(startPath, 'utf8'))
  } catch {
    writeEvidence({ ok: true, note: 'No host-start evidence; nothing to stop.' })
    return
  }
  if (!start.ok) {
    writeEvidence({ ok: true, note: 'host-start evidence is not ok; nothing to stop.' })
    return
  }
  const session = start.session
  const tokenPath = path.join(start.hostDir, 'token')
  if (!fs.existsSync(tokenPath)) {
    writeEvidence({ ok: true, hostPid: session.hostPid, note: 'Host already stopped.' })
    return
  }
  const token = fs.readFileSync(tokenPath, 'utf8').trim()
  const client = await HostClient.connect(session.socket, token)
  await client.request('kill', { sessionId: session.sessionId })
  await client.request('shutdown')
  client.close()
  writeEvidence({ ok: true, hostPid: session.hostPid, stopped: true })
  process.stdout.write(`ICODE_GATE_HOST_STOPPED ${session.hostPid}\n`)
}

main().catch((error) => {
  writeEvidence({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  })
  process.stderr.write(`[gate:host:stop] ${String(error)}\n`)
  process.exit(1)
})

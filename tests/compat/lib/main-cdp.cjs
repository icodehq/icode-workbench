'use strict'
/**
 * Minimal CDP client for the Electron main process (`--inspect`).
 *
 * The renderer client (`ui-cdp.cjs`) only enables Page/Runtime; a Node target
 * has no Page domain, so this connects to `type: 'node'` and uses Runtime alone.
 */

async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const target = targets.find((entry) => entry.webSocketDebuggerUrl)
      if (target) return target
    } catch {
      // The inspector is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for the main-process inspector on ${port}`)
}

function createClient(ws) {
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  })
  ws.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP connection closed'))
    pending.clear()
  })
  return {
    send(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      const response = await this.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.exception?.description ??
            JSON.stringify(response.exceptionDetails)
        )
      }
      return response.result.value
    },
    close() {
      ws.close()
    }
  }
}

async function connectMain(port, timeoutMs = 30_000) {
  const target = await waitForTarget(port, timeoutMs)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const client = createClient(ws)
  await client.send('Runtime.enable')
  return client
}

module.exports = { connectMain }

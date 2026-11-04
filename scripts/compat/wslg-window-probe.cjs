'use strict'

/**
 * Minimal read-only X11 window probe.
 *
 * Why: WSLg exposes the Windows desktop as X11 display :0, but this
 * environment has no xdotool/wmctrl/xwininfo. This speaks just enough of the
 * X11 protocol (setup, QueryTree, GetWindowAttributes, GetProperty,
 * GetGeometry) to prove that a mapped top-level window exists on the WSLg
 * display. It never creates, maps, or modifies a window.
 *
 * Usage: node scripts/compat/wslg-window-probe.cjs [--match iCode] [--json]
 */

const net = require('node:net')
const { existsSync } = require('node:fs')

const ATOM_WM_NAME = 39
const ATOM_WM_CLASS = 67
const MAX_WINDOWS = 400

function pad4(length) {
  return (4 - (length % 4)) % 4
}

function x11SocketPath() {
  const display = process.env.DISPLAY || ':0'
  const match = /^(?:[^:]*):(\d+)/.exec(display)
  const number = match ? Number(match[1]) : 0
  return `/tmp/.X11-unix/X${String(number)}`
}

class Connection {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.pending = null
    // Setup replies put the length at byte 6; every later reply puts it at 4.
    this.setupComplete = false
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('X11 connection closed')))
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  fail(error) {
    if (this.pending) {
      const { reject } = this.pending
      this.pending = null
      reject(error)
    }
  }

  drain() {
    if (!this.pending || this.buffer.length < 8) return
    // Setup: 8-byte header + length*4. Every other reply: 32-byte fixed
    // header + length*4.
    const length = this.setupComplete ? this.buffer.readUInt16LE(4) : this.buffer.readUInt16LE(6)
    const total = (this.setupComplete ? 32 : 8) + length * 4
    if (this.buffer.length < total) return
    const message = this.buffer.subarray(0, total)
    this.buffer = this.buffer.subarray(total)
    if (!this.setupComplete) this.setupComplete = true
    const { resolve } = this.pending
    this.pending = null
    resolve(message)
  }

  send(request) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      this.socket.write(request)
    })
  }

  async setup() {
    const request = Buffer.alloc(12)
    request.write('l', 0, 'ascii')
    request.writeUInt16LE(11, 2)
    request.writeUInt16LE(0, 4)
    // Empty auth name and data: 2 + 2 length fields, then padding.
    const reply = await this.send(request)
    const status = reply[0]
    if (status !== 1) {
      throw new Error(`X11 setup failed with status ${String(status)} (auth required?)`)
    }
    // Setup reply: vendor length (1 byte) then maximum request length (2 bytes),
    // so the screen/format counts are at byte offsets 28 and 29.
    const vendorLength = reply[24]
    const screenCount = reply[28]
    const formatCount = reply[29]
    let offset = 40 + vendorLength + pad4(vendorLength) + formatCount * 8
    const screens = []
    for (let index = 0; index < screenCount; index += 1) {
      screens.push({
        root: reply.readUInt32LE(offset),
        width: reply.readUInt16LE(offset + 20),
        height: reply.readUInt16LE(offset + 22)
      })
      const depthCount = reply[offset + 39]
      let next = offset + 40
      for (let depth = 0; depth < depthCount; depth += 1) {
        const visualCount = reply.readUInt16LE(next + 2)
        next += 8 + visualCount * 24
      }
      offset = next
    }
    return { screens, vendorLength }
  }

  async queryTree(window) {
    const request = Buffer.alloc(8)
    request[0] = 15
    request.writeUInt16LE(2, 2)
    request.writeUInt32LE(window, 4)
    const reply = await this.send(request)
    const count = reply.readUInt16LE(16)
    const children = []
    for (let index = 0; index < count; index += 1) {
      children.push(reply.readUInt32LE(32 + index * 4))
    }
    return children
  }

  async attributes(window) {
    const request = Buffer.alloc(8)
    request[0] = 3
    request.writeUInt16LE(2, 2)
    request.writeUInt32LE(window, 4)
    const reply = await this.send(request)
    return {
      class: reply.readUInt16LE(12),
      mapState: reply[26],
      overrideRedirect: reply[27] === 1
    }
  }

  async geometry(window) {
    const request = Buffer.alloc(8)
    request[0] = 14
    request.writeUInt16LE(2, 2)
    request.writeUInt32LE(window, 4)
    const reply = await this.send(request)
    return {
      x: reply.readInt16LE(12),
      y: reply.readInt16LE(14),
      width: reply.readUInt16LE(16),
      height: reply.readUInt16LE(18),
      border: reply.readUInt16LE(20),
      depth: reply[1]
    }
  }

  async property(window, atom) {
    const request = Buffer.alloc(24)
    request[0] = 20
    request.writeUInt16LE(6, 2)
    request.writeUInt32LE(window, 4)
    request.writeUInt32LE(atom, 8)
    request.writeUInt32LE(0, 12) // AnyPropertyType
    request.writeUInt32LE(0, 16) // long offset
    request.writeUInt32LE(256, 20) // long length
    const reply = await this.send(request)
    const format = reply[1]
    const valueLength = reply.readUInt32LE(16)
    if (format !== 8 || valueLength === 0) return null
    const bytes = reply.subarray(32, 32 + valueLength)
    return bytes.toString('utf8').replace(/\0+$/u, '')
  }
}

function isMapped(mapState) {
  return mapState === 2 // IsViewable
}

async function snapshot(match) {
  const socketPath = x11SocketPath()
  if (!existsSync(socketPath)) throw new Error(`No X11 socket at ${socketPath}`)
  const socket = net.createConnection(socketPath)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const connection = new Connection(socket)
  const setup = await connection.setup()
  const root = setup.screens[0]
  if (!root) throw new Error('X11 setup reported no screens')

  const windows = []
  const seen = new Set()
  async function walk(window, depth) {
    if (depth > 4 || seen.size > MAX_WINDOWS) return
    seen.add(window)
    let children = []
    try {
      children = await connection.queryTree(window)
    } catch {
      return
    }
    for (const child of children) {
      if (seen.has(child)) continue
      seen.add(child)
      let attributes
      let geometry
      try {
        attributes = await connection.attributes(child)
        geometry = await connection.geometry(child)
      } catch {
        continue
      }
      const name = await connection.property(child, ATOM_WM_NAME).catch(() => null)
      const className = await connection.property(child, ATOM_WM_CLASS).catch(() => null)
      windows.push({
        id: `0x${child.toString(16)}`,
        name,
        className,
        mapState: attributes.mapState,
        mapped: isMapped(attributes.mapState),
        overrideRedirect: attributes.overrideRedirect,
        ...geometry
      })
      await walk(child, depth + 1)
    }
  }
  await walk(root.root, 0)
  socket.destroy()

  const needle = match.toLowerCase()
  const matches = windows.filter((window) => {
    const haystack = `${window.name ?? ''} ${window.className ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  })
  return {
    display: process.env.DISPLAY ?? ':0',
    socketPath,
    screen: { width: root.width, height: root.height },
    windowCount: windows.length,
    match,
    matches,
    mappedMatches: matches.filter((window) => window.mapped),
    windows: windows.filter((window) => window.mapped)
  }
}

function parseArgs(argv) {
  const options = { match: 'iCode', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--match') options.match = argv[++index] ?? 'iCode'
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const result = await snapshot(options.match)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  process.stdout.write(
    `display ${result.display} ${String(result.screen.width)}x${String(result.screen.height)} ` +
      `${String(result.windowCount)} windows, ${String(result.mappedMatches.length)} mapped match(es)\n`
  )
  for (const window of result.matches) {
    process.stdout.write(
      `  ${window.id} ${window.mapped ? 'mapped' : 'unmapped'} ` +
        `${String(window.width)}x${String(window.height)} name=${JSON.stringify(window.name)} ` +
        `class=${JSON.stringify(window.className)}\n`
    )
  }
}

main().catch((error) => {
  process.stderr.write(`[wslg-probe] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})

'use strict'

const net = require('node:net')
const { randomUUID } = require('node:crypto')

const HOST_PROTOCOL_VERSION = 1

class HostClient {
  constructor(socket, token) {
    this.socket = socket
    this.token = token
    this.buffer = ''
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false
    this.info = null
  }

  static connect(socketPath, token, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath)
      const client = new HostClient(socket, token)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Timed out connecting to the terminal host'))
      }, timeoutMs)
      socket.setNoDelay(true)
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.once('connect', () => {
        client.attach()
        client
          .handshake()
          .then(() => {
            clearTimeout(timer)
            resolve(client)
          })
          .catch((error) => {
            clearTimeout(timer)
            socket.destroy()
            reject(error)
          })
      })
    })
  }

  attach() {
    this.socket.on('data', (chunk) => this.onData(chunk.toString('utf8')))
    this.socket.on('close', () => this.onClose())
    this.socket.on('error', () => this.onClose())
  }

  handshake() {
    return new Promise((resolve, reject) => {
      this.handshakePromise = { resolve, reject }
      this.socket.write(
        `${JSON.stringify({
          type: 'hello',
          protocolVersion: HOST_PROTOCOL_VERSION,
          token: this.token,
          clientId: `icode-gate-${process.pid}`
        })}\n`
      )
    })
  }

  onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index === -1) return
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.type === 'hello') {
        const pending = this.handshakePromise
        this.handshakePromise = null
        if (!pending) continue
        if (message.ok === true) {
          this.info = {
            hostPid: message.hostPid,
            startedAt: message.startedAt,
            protocolVersion: message.protocolVersion,
            hostVersion: message.hostVersion
          }
          pending.resolve(message)
        } else {
          pending.reject(new Error(message.error?.message || 'Host rejected the handshake'))
        }
        continue
      }
      if (message.type === 'event') {
        for (const listener of this.listeners) listener(message)
        continue
      }
      if (message.type === 'response' && typeof message.id === 'string') {
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.ok === true) pending.resolve(message.payload)
        else pending.reject(new Error(message.error?.message || 'Host request failed'))
      }
    }
  }

  onClose() {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Terminal host connection closed'))
    }
    this.pending.clear()
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  write(sessionId, incarnationId, data) {
    return this.request('write', { sessionId, incarnationId, data })
  }

  resize(sessionId, incarnationId, cols, rows) {
    return this.request('resize', { sessionId, incarnationId, cols, rows })
  }

  request(method, params = {}, timeoutMs = 10000) {
    if (!this.socket || !this.socket.writable) {
      return Promise.reject(new Error('Terminal host is not connected'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Host request ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(`${JSON.stringify({ type: 'request', id, method, params })}\n`)
    })
  }

  waitForData(sessionId, marker, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`Timed out waiting for marker ${marker}`))
      }, timeoutMs)
      const off = this.onEvent((event) => {
        if (
          event.event === 'data' &&
          event.sessionId === sessionId &&
          event.data.includes(marker)
        ) {
          clearTimeout(timer)
          off()
          resolve(event)
        }
      })
    })
  }

  close() {
    this.socket?.destroy()
    this.onClose()
  }
}

module.exports = { HostClient, HOST_PROTOCOL_VERSION }

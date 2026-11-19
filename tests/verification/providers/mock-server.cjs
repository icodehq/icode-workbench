#!/usr/bin/env node
/**
 * Local endpoint for hands-on provider verification.
 *
 * Serves the four protocols iCode recipes use, records every request, and
 * answers with a minimal valid body. Run it, point a harness at it through the
 * generated provider plan, then read `/__requests` to prove the request path,
 * auth header, and model.
 *
 *   node tests/verification/providers/mock-server.cjs
 *   LISTENING <port>
 */
'use strict'

const http = require('node:http')

const requests = []

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function text(res, status, value) {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(value)
}

function anthropicBody() {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  }
}

function chatBody() {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
}

function responsesBody() {
  return {
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    model: 'test-model',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok' }]
      }
    ],
    usage: { input_tokens: 1, output_tokens: 1 }
  }
}

function geminiBody() {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'ok' }] },
        finishReason: 'STOP'
      }
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
  }
}

function responseFor(pathname) {
  if (pathname.endsWith('/v1/messages')) return anthropicBody()
  if (pathname.endsWith('/v1/chat/completions')) return chatBody()
  if (pathname.endsWith('/v1/responses')) return responsesBody()
  if (/:streamGenerateContent$/u.test(pathname)) return geminiBody()
  if (/:generateContent$/u.test(pathname)) return geminiBody()
  return { ok: true }
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/__requests') {
      json(res, 200, { requests })
      return
    }
    if (url.pathname === '/__reset') {
      requests.length = 0
      json(res, 200, { ok: true })
      return
    }
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      headers: req.headers,
      body,
      at: Date.now()
    })
    const value = responseFor(url.pathname)
    // Streaming clients often accept a normal JSON body as one response; the
    // verification only needs the request to have been made.
    json(res, 200, value)
  })
})

server.on('error', (error) => {
  text(process.stderr, 1, `mock server error: ${String(error)}\n`)
  process.exitCode = 1
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    text(process.stderr, 1, 'mock server did not bind a TCP port\n')
    process.exit(1)
  }
  process.stdout.write(`LISTENING ${address.port}\n`)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

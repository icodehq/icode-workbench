/**
 * The supervisor CLI is a tiny client for the local control server.
 *
 * It is embedded as a string and written into `userData` so a packaged app does
 * not need a second build target or a PATH entry. It is executed by Electron's
 * own binary with `ELECTRON_RUN_AS_NODE=1`, which is the same mechanism the
 * Claude hook installer already relies on.
 */
export const SUPERVISOR_CLI_SCRIPT = String.raw`#!/usr/bin/env node
'use strict'

const net = require('node:net')
const fs = require('node:fs')

function fail(message, code) {
  process.stderr.write(String(message) + '\n')
  process.exit(code === undefined ? 1 : code)
}

function usage() {
  process.stderr.write([
    'Usage: icode-supervisor --config <control.json> <command> [args]',
    '',
    'Commands:',
    '  state',
    '  tasks list [--status <status>] [--approval <approval>] [--limit <n>]',
    '  tasks get <taskId>',
    '  tasks changes <taskId>',
    '  tasks diff <taskId> --path <file>',
    '  tasks propose --file <path> | --text <json>',
    '  tasks cancel <taskId>',
    '  tasks retry <taskId>',
    '  sessions message <taskId> --text <text>',
    '  review recommend <taskId> --decision accept|reject [--note <text>]',
    '  events wait [--after <cursor>] [--timeout <ms>]',
    ''
  ].join('\n'))
}

const argv = process.argv.slice(2)
let configPath = ''
const rest = []
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--config') {
    configPath = argv[index + 1] || ''
    index += 1
  } else if (argv[index] === '--help' || argv[index] === '-h') {
    usage()
    process.exit(0)
  } else {
    rest.push(argv[index])
  }
}
if (!configPath) {
  usage()
  fail('Missing --config')
}

let config
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (error) {
  fail('Cannot read control config: ' + (error && error.message ? error.message : String(error)))
}
if (!config || typeof config.endpoint !== 'string' || typeof config.token !== 'string') {
  fail('The control config is missing its endpoint or token.')
}

function takeFlag(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue
    const value = args[index + 1]
    args.splice(index, 2)
    return value
  }
  return undefined
}

function takeRepeated(args, name) {
  const values = []
  for (let index = 0; index < args.length; ) {
    if (args[index] !== name) {
      index += 1
      continue
    }
    const value = args[index + 1]
    if (value !== undefined) values.push(value)
    args.splice(index, 2)
  }
  return values
}

function requireValue(value, name) {
  if (value === undefined || value === '') fail('Missing ' + name)
  return value
}

const command = rest.shift()
const sub = rest.shift()
let op
let input = {}

if (command === 'state') {
  op = 'state'
} else if (command === 'tasks' && sub === 'list') {
  op = 'tasks.list'
  const statuses = takeRepeated(rest, '--status')
  const approvals = takeRepeated(rest, '--approval')
  const limit = takeFlag(rest, '--limit')
  if (statuses.length > 0) input.statuses = statuses
  if (approvals.length > 0) input.approvals = approvals
  if (limit !== undefined) input.limit = Number(limit)
} else if (command === 'tasks' && (sub === 'get' || sub === 'changes' || sub === 'cancel' || sub === 'retry')) {
  op = sub === 'get' ? 'tasks.get' : sub === 'changes' ? 'tasks.changes' : sub === 'cancel' ? 'tasks.cancel' : 'tasks.retry'
  input = { taskId: requireValue(rest.shift(), 'taskId') }
} else if (command === 'tasks' && sub === 'diff') {
  op = 'tasks.diff'
  input = {
    taskId: requireValue(rest.shift(), 'taskId'),
    path: requireValue(takeFlag(rest, '--path'), '--path')
  }
} else if (command === 'tasks' && sub === 'propose') {
  op = 'tasks.propose'
  const file = takeFlag(rest, '--file')
  const text = takeFlag(rest, '--text')
  if (file !== undefined) input = { file }
  else if (text !== undefined) input = { tasks: JSON.parse(text) }
  else fail('tasks propose needs --file or --text')
} else if (command === 'sessions' && sub === 'message') {
  op = 'sessions.message'
  input = {
    taskId: requireValue(rest.shift(), 'taskId'),
    text: requireValue(takeFlag(rest, '--text'), '--text')
  }
} else if (command === 'review' && sub === 'recommend') {
  op = 'review.recommend'
  const decision = takeFlag(rest, '--decision')
  if (decision !== 'accept' && decision !== 'reject') fail('--decision must be accept or reject')
  input = {
    taskId: requireValue(rest.shift(), 'taskId'),
    decision,
    note: takeFlag(rest, '--note') || null
  }
} else if (command === 'events' && sub === 'wait') {
  op = 'events.wait'
  const after = takeFlag(rest, '--after')
  const timeout = takeFlag(rest, '--timeout')
  if (after !== undefined) input.after = Number(after)
  if (timeout !== undefined) input.timeoutMs = Number(timeout)
} else {
  usage()
  fail('Unknown command')
}

const request = JSON.stringify({ v: 1, token: config.token, op, input })
const socket = net.createConnection(config.endpoint)
let response = ''
socket.setEncoding('utf8')
socket.on('connect', () => {
  // Keep the connection open: Windows named pipes drop a half-closed client's
  // read side before the server's response can arrive.
  socket.write(request + '\n')
})
socket.on('data', (chunk) => {
  response += chunk
})
socket.on('end', () => {
  let parsed
  try {
    parsed = JSON.parse(response)
  } catch {
    fail('The control server returned invalid JSON: ' + response.slice(0, 500))
  }
  if (!parsed || parsed.ok !== true) {
    const error = parsed && parsed.error ? parsed.error : { message: 'Unknown control error' }
    fail(JSON.stringify(error, null, 2))
  }
  process.stdout.write(JSON.stringify(parsed.value, null, 2) + '\n')
  process.exit(0)
})
socket.on('error', (error) => fail('Cannot reach iCode: ' + error.message))
setTimeout(() => fail('The iCode control request timed out.'), 60_000).unref()
`

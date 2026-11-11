import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ACTIVITY_EVENTS } from '../../shared/domain/activity'

/**
 * The hook script and the Claude settings overlay.
 *
 * The script is written from a string into the app's own userData directory so a
 * packaged app needs no extra unpacked resource, and the overlay is an additive
 * `--settings` file: Claude merges it with the user's own settings, so existing
 * user hooks keep running. iCode never writes `~/.claude/settings.json`.
 */

export const HOOK_SCRIPT_NAME = 'icode-activity-hook.cjs'
export const HOOK_WRAPPER_NAME = 'icode-activity-hook.cmd'
export const SETTINGS_NAME = 'settings.json'
/**
 * The overlay for WSL Agents.
 *
 * A guest Claude runs inside Linux, but the hook process must be the Windows
 * executable that owns the activity socket, so these commands cross the WSL
 * interop boundary. The file therefore cannot be the same one a local Claude
 * reads; both live in the same directory and differ only in their commands.
 */
export const GUEST_SETTINGS_NAME = 'settings.wsl.json'

/**
 * Runs as a Claude hook command. It reads stdin, forwards one bounded JSON
 * object to the activity socket, and exits 0 — always, and quickly.
 *
 * Rules encoded here on purpose:
 * - writes nothing to stdout (Claude consumes hook stdout),
 * - exits 0 even when iCode is unreachable, so an iCode failure cannot block Claude,
 * - reads stdin for at most 100 ms and never waits more than a second for the
 *   ingress to close the connection, so the process cannot linger.
 */
const HOOK_SCRIPT = `#!/usr/bin/env node
'use strict'
const net = require('node:net')
const MAX_BYTES = 8 * 1024
const DEADLINE_MS = 100
const eventName = process.argv[2] || ''
const socketPath = process.env.ICODE_ACTIVITY_SOCKET || ''
const sessionId = process.env.ICODE_SESSION_ID || ''
const incarnationId = process.env.ICODE_SESSION_INCARNATION || ''
function done() { process.exit(0) }
const timer = setTimeout(done, DEADLINE_MS)
timer.unref()
if (!eventName || !socketPath || !sessionId || !incarnationId) done()
const chunks = []
let size = 0
let finished = false
function finish(payload) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  if (!payload) done()
  let socket
  try {
    socket = net.createConnection(socketPath)
  } catch {
    done()
  }
  // The ingress destroys the connection once it has the payload. The guard is
  // a safety net for a server that accepts the pipe and then stalls; a hook
  // must never hold a Claude turn open.
  const guard = setTimeout(done, 1000)
  guard.unref()
  socket.on('error', function () { clearTimeout(guard); done() })
  socket.on('connect', function () {
    try {
      socket.end(JSON.stringify(payload))
    } catch {
      clearTimeout(guard)
      done()
    }
  })
  socket.on('close', function () { clearTimeout(guard); done() })
}
process.stdin.on('data', function (chunk) {
  if (finished) return
  size += chunk.length
  if (size > MAX_BYTES) { finished = true; clearTimeout(timer); done() }
  chunks.push(chunk)
})
process.stdin.on('error', function () { finish(null) })
process.stdin.on('end', function () {
  let input = {}
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { input = {} }
  function text(value, limit) {
    return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : null
  }
  finish({
    event: eventName,
    sessionId: sessionId,
    incarnationId: incarnationId,
    claudeSessionId: text(input.session_id, 128),
    promptId: text(input.prompt_id, 128),
    toolName: text(input.tool_name, 64),
    sentAt: Date.now()
  })
})
`

export type ClaudeHookInstallOptions = {
  /** iCode's own directory under userData, e.g. `<userData>/agent-hooks`. */
  directory: string
  /** Absolute path to the Electron/Node executable used to run the script. */
  execPath: string
  /** Whether the executable needs `ELECTRON_RUN_AS_NODE=1` (packaged Electron). */
  electronRunAsNode: boolean
  /**
   * Present when WSL Agents are supported: writes the guest overlay too.
   *
   * The path is spelled for a guest shell; the script stays in Windows spelling
   * because the process that runs it is a Windows process.
   */
  guest?: {
    guestExecutablePath: string
    activitySocket: string
  }
  /** Host platform; a test seam so Windows/macOS commands are testable on Linux. */
  platform?: NodeJS.Platform
}

export type ClaudeHookInstall = {
  scriptPath: string
  settingsPath: string
  /** Passed to Claude only. Other harnesses keep their existing arguments. */
  launchArgs: string[]
  /** The guest overlay, when `guest` was provided; null otherwise. */
  guestSettingsPath: string | null
  /** Launch arguments for a WSL Agent; empty when no guest overlay exists. */
  guestLaunchArgs: string[]
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * One command per event; the event name travels as argv, not as shell text.
 *
 * A packaged iCode is Electron, not Node. Without `ELECTRON_RUN_AS_NODE=1` the
 * hook would launch a second application window instead of the script, so the
 * variable is part of the command rather than the (unavailable) Hook env.
 */
export function hookCommandFor(
  execPath: string,
  scriptPath: string,
  event: string,
  electronRunAsNode = false,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    // cmd.exe cannot execute the POSIX `env VAR=...` form, and a .cmd wrapper
    // keeps the event name as argv instead of shell text.
    const wrapper = join(dirname(scriptPath), HOOK_WRAPPER_NAME)
    return `"${wrapper}" "${event}"`
  }
  const prefix = electronRunAsNode ? 'env ELECTRON_RUN_AS_NODE=1 ' : ''
  return `${prefix}${shellQuote(execPath)} ${shellQuote(scriptPath)} ${shellQuote(event)}`
}

type HookDetachMode = 'setsid' | 'nohup' | 'none'

/**
 * Claude does not wait for a `StopFailure` hook on its way out; it terminates
 * the process group shortly after starting it. A packaged iCode needs ~90 ms to
 * boot as Node, so that event would be lost. Turn-end hooks therefore detach:
 * fd 0 is duplicated first (asynchronous shells would otherwise get
 * /dev/null), then the real command runs in the background and survives.
 *
 * `setsid` is Linux-only; macOS has no such binary, so it uses `nohup` and a
 * background subshell. Windows runs the hook synchronously: `start` cannot
 * forward the JSON payload on stdin.
 */
function detachedHookCommand(command: string, mode: HookDetachMode): string {
  if (mode === 'none') return command
  if (mode === 'nohup') {
    return `sh -c ${shellQuote(`exec 3<&0; nohup ${command} <&3 >/dev/null 2>&1 &`)}`
  }
  return `sh -c ${shellQuote(`exec 3<&0; (setsid ${command} <&3) >/dev/null 2>&1 &`)}`
}

function buildSettings(
  commandFor: (event: string) => string,
  detachTurnEnd: HookDetachMode
): string {
  const hooks: Record<string, unknown> = {}
  for (const event of ACTIVITY_EVENTS) {
    const command = commandFor(event)
    const turnEnd = event === 'Stop' || event === 'StopFailure'
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: 'command',
          command: turnEnd ? detachedHookCommand(command, detachTurnEnd) : command
        }
      ]
    }
    // Tool events need an explicit matcher; the rest must not carry one.
    if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
      entry.matcher = '*'
    }
    hooks[event] = [entry]
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

export function buildClaudeSettings(
  execPath: string,
  scriptPath: string,
  electronRunAsNode = false,
  platform: NodeJS.Platform = process.platform
): string {
  const detach: HookDetachMode =
    !electronRunAsNode ? 'none' : platform === 'darwin' ? 'nohup' : platform === 'win32' ? 'none' : 'setsid'
  return buildSettings(
    (event) => hookCommandFor(execPath, scriptPath, event, electronRunAsNode, platform),
    detach
  )
}

/**
 * What a guest hook needs in order to become a Windows hook process.
 *
 * Only the constant half is known when the file is written: the executable and
 * script spellings, and the activity endpoint. The session identity is per PTY
 * and is read from the guest environment at hook time.
 */
export type GuestHookAccess = {
  /** The Windows hook executable, spelled so a *guest* shell can start it. */
  guestExecutablePath: string
  /** The script in Windows spelling: this is argv to a Windows process. */
  scriptPath: string
  /** The Windows activity endpoint — a guest has no other route to the ingress. */
  activitySocket: string
}

/**
 * Environment a Windows hook process must receive from the guest.
 *
 * WSL interop hands a launched Windows process a *Windows* environment, so a
 * Linux-only variable would silently disappear. `WSLENV` is the documented
 * bridge: listed names are copied across, without path translation (`/p` would
 * rewrite the very values we need verbatim — a pipe name is not a path).
 */
const GUEST_HOOK_ENV = ['ICODE_ACTIVITY_SOCKET', 'ICODE_SESSION_ID', 'ICODE_SESSION_INCARNATION'] as const

/**
 * One guest hook command: the Windows executable, started from the guest.
 *
 * Paths are quoted rather than concatenated, and the event name stays argv so a
 * settings file can never turn into shell syntax.
 */
export function guestHookCommandFor(
  access: GuestHookAccess,
  event: string,
  electronRunAsNode = false
): string {
  const crossed = electronRunAsNode ? [...GUEST_HOOK_ENV, 'ELECTRON_RUN_AS_NODE'] : GUEST_HOOK_ENV
  const env = [
    `WSLENV=${shellQuote(crossed.join(':'))}`,
    `ICODE_ACTIVITY_SOCKET=${shellQuote(access.activitySocket)}`
  ]
  if (electronRunAsNode) env.push('ELECTRON_RUN_AS_NODE=1')
  return [
    'env',
    ...env,
    shellQuote(access.guestExecutablePath),
    shellQuote(access.scriptPath),
    shellQuote(event)
  ].join(' ')
}

/** The guest overlay: identical events, commands that cross into Windows. */
export function buildGuestClaudeSettings(
  access: GuestHookAccess,
  electronRunAsNode = false
): string {
  // The guest overlay runs inside Linux regardless of the host platform.
  return buildSettings(
    (event) => guestHookCommandFor(access, event, electronRunAsNode),
    electronRunAsNode ? 'setsid' : 'none'
  )
}

/**
 * Writes the script once and returns the launch arguments for Claude.
 * Idempotent: the same paths and content are produced on every call.
 */
export function installClaudeHooks(options: ClaudeHookInstallOptions): ClaudeHookInstall {
  const platform = options.platform ?? process.platform
  const directory = options.directory
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const scriptPath = join(directory, HOOK_SCRIPT_NAME)
  const settingsPath = join(directory, SETTINGS_NAME)

  writeFileSync(scriptPath, HOOK_SCRIPT, { mode: 0o700 })
  try {
    chmodSync(scriptPath, 0o700)
  } catch {
    // Windows ignores POSIX modes; the file is still readable by its owner.
  }

  if (platform === 'win32') {
    const lines = ['@echo off']
    if (options.electronRunAsNode) lines.push('set "ELECTRON_RUN_AS_NODE=1"')
    lines.push(`"${options.execPath}" "${scriptPath}" %*`)
    writeFileSync(join(directory, HOOK_WRAPPER_NAME), `${lines.join('\r\n')}\r\n`, {
      mode: 0o700
    })
  }

  writeFileSync(
    settingsPath,
    buildClaudeSettings(options.execPath, scriptPath, options.electronRunAsNode, platform),
    { mode: 0o600 }
  )

  let guestSettingsPath: string | null = null
  if (options.guest) {
    guestSettingsPath = join(directory, GUEST_SETTINGS_NAME)
    writeFileSync(
      guestSettingsPath,
      buildGuestClaudeSettings(
        {
          guestExecutablePath: options.guest.guestExecutablePath,
          scriptPath,
          activitySocket: options.guest.activitySocket
        },
        options.electronRunAsNode
      ),
      { mode: 0o600 }
    )
  }

  return {
    scriptPath,
    settingsPath,
    launchArgs: ['--settings', settingsPath],
    guestSettingsPath,
    // The guest Claude must read the guest overlay *by its guest spelling*; the
    // caller respells the path because only it knows this is a WSL launch.
    guestLaunchArgs: guestSettingsPath === null ? [] : ['--settings', guestSettingsPath]
  }
}

export function claudeHooksInstalled(directory: string): boolean {
  return existsSync(join(directory, HOOK_SCRIPT_NAME)) && existsSync(join(directory, SETTINGS_NAME))
}

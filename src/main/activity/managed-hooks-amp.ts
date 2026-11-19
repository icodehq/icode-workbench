/**
 * Amp is a TypeScript plugin host, not a settings file with hook commands.
 *
 * The local plugin posts to the activity pipe directly. In WSL the plugin
 * spawns the Windows hook script through interop, because a guest process
 * cannot open a Windows named pipe. Only lifecycle events are subscribed:
 * tool.call is intentionally omitted so iCode never answers Amp permissions.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  MANAGED_HOOK_PROVIDER_SPECS,
  configPathFor,
  type ManagedHookInstallOptions,
  type ManagedHookProvider,
  type ManagedHookProviderStatus
} from './managed-hooks'
import { managedHookGuestConfigPath } from '../../shared/domain/managed-hook-providers'
import {
  readGuestHookText,
  removeGuestHookFile,
  writeGuestHookText,
  type GuestManagedHookOptions
} from './managed-hooks-guest'

export const AMP_PLUGIN_MARKER = '/* icode-managed-amp-plugin */'

type AmpPluginSourceOptions = {
  local: boolean
  guestExecutablePath?: string
  scriptPath?: string
  activitySocket?: string
  electronRunAsNode?: boolean
}

function localPluginSource(): string {
  return [
    "import net from 'node:net'",
    AMP_PLUGIN_MARKER,
    'function post(event: string, payload: Record<string, unknown>): void {',
    "  const socketPath = process.env.ICODE_ACTIVITY_SOCKET || ''",
    "  const sessionId = process.env.ICODE_SESSION_ID || ''",
    "  const incarnationId = process.env.ICODE_SESSION_INCARNATION || ''",
    '  if (!socketPath || !sessionId || !incarnationId) return',
    '  const body = JSON.stringify({',
    '    event,',
    '    sessionId,',
    '    incarnationId,',
    '    claudeSessionId: typeof payload.threadId === "string" ? payload.threadId : null,',
    '    promptId: typeof payload.id === "string" ? payload.id : null,',
    '    toolName: null,',
    '    sentAt: Date.now()',
    '  })',
    '  try {',
    '    const socket = net.createConnection(socketPath)',
    '    socket.on("error", () => undefined)',
    '    socket.on("connect", () => socket.end(body))',
    '    setTimeout(() => socket.destroy(), 1000)',
    '  } catch {',
    '    // Status must never affect the Amp run.',
    '  }',
    '}',
    'export default function (amp: any) {',
    '  amp.on("agent.start", (event: any) => {',
    '    post("UserPromptSubmit", { threadId: event?.thread?.id, id: event?.id })',
    '  })',
    '  amp.on("agent.end", (event: any) => {',
    '    post(event?.status === "cancelled" ? "StopFailure" : "Stop", {',
    '      threadId: event?.thread?.id,',
    '      id: event?.id',
    '    })',
    '  })',
    '}',
    ''
  ].join('\n')
}

function guestPluginSource(options: AmpPluginSourceOptions): string {
  const executable = JSON.stringify(options.guestExecutablePath ?? '')
  const script = JSON.stringify(options.scriptPath ?? '')
  const socket = JSON.stringify(options.activitySocket ?? '')
  const electron = options.electronRunAsNode === true
  return [
    "import { spawn } from 'node:child_process'",
    AMP_PLUGIN_MARKER,
    `const WINDOWS_EXEC = ${executable}`,
    `const SCRIPT = ${script}`,
    `const PIPE = ${socket}`,
    'function post(event: string, payload: Record<string, unknown>): void {',
    "  if (!process.env.ICODE_SESSION_ID || !process.env.ICODE_SESSION_INCARNATION) return",
    electron
      ? '  const env = { ...process.env, WSLENV: "ICODE_ACTIVITY_SOCKET:ICODE_SESSION_ID:ICODE_SESSION_INCARNATION:ELECTRON_RUN_AS_NODE", ICODE_ACTIVITY_SOCKET: PIPE, ELECTRON_RUN_AS_NODE: "1" }'
      : '  const env = { ...process.env, WSLENV: "ICODE_ACTIVITY_SOCKET:ICODE_SESSION_ID:ICODE_SESSION_INCARNATION", ICODE_ACTIVITY_SOCKET: PIPE }',
    '  try {',
    '    const child = spawn(WINDOWS_EXEC, [SCRIPT, "amp", event, event, "none"], {',
    '      env,',
    '      stdio: ["pipe", "ignore", "ignore"]',
    '    })',
    '    child.on("error", () => undefined)',
    '    child.stdin.end(JSON.stringify(payload))',
    '  } catch {',
    '    // Status must never affect the Amp run.',
    '  }',
    '}',
    'export default function (amp: any) {',
    '  amp.on("agent.start", (event: any) => {',
    '    post("UserPromptSubmit", { threadId: event?.thread?.id, id: event?.id })',
    '  })',
    '  amp.on("agent.end", (event: any) => {',
    '    post(event?.status === "cancelled" ? "StopFailure" : "Stop", {',
    '      threadId: event?.thread?.id,',
    '      id: event?.id',
    '    })',
    '  })',
    '}',
    ''
  ].join('\n')
}

function pluginSource(
  options: AmpPluginSourceOptions = { local: true }
): string {
  return options.local ? localPluginSource() : guestPluginSource(options)
}

function isManaged(text: string | null): boolean {
  return text !== null && text.includes(AMP_PLUGIN_MARKER)
}

function statusFromText(
  provider: ManagedHookProvider,
  configPath: string,
  text: string | null
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  if (text === null) {
    return { provider, label: spec.label, state: 'not-installed', configPath, detail: null }
  }
  if (isManaged(text)) {
    return { provider, label: spec.label, state: 'installed', configPath, detail: null }
  }
  return {
    provider,
    label: spec.label,
    state: 'failed',
    configPath,
    detail: 'A user-owned Amp plugin uses iCode’s file name.'
  }
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf8') === text) return
    } catch {
      // Fall through.
    }
  }
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
  writeFileSync(path, text, { encoding: 'utf8', mode })
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, mode)
    } catch {
      // Windows ignores POSIX modes.
    }
  }
}

export function localAmpStatus(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const path = configPathFor(provider, options)
  if (!existsSync(path)) return statusFromText(provider, path, null)
  try {
    return statusFromText(provider, path, readFileSync(path, 'utf8'))
  } catch (error) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export function installLocalAmpHooks(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const path = configPathFor(provider, options)
  if (existsSync(path)) {
    let existing: string
    try {
      existing = readFileSync(path, 'utf8')
    } catch (error) {
      return {
        provider,
        label: spec.label,
        state: 'failed',
        configPath: path,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
    if (!isManaged(existing)) {
      return statusFromText(provider, path, existing)
    }
  }
  writeText(path, pluginSource({ local: true }))
  return statusFromText(provider, path, pluginSource({ local: true }))
}

export function removeLocalAmpHooks(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const path = configPathFor(provider, options)
  if (!existsSync(path)) return statusFromText(provider, path, null)
  let existing: string
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    return statusFromText(provider, path, null)
  }
  if (!isManaged(existing)) return statusFromText(provider, path, existing)
  unlinkSync(path)
  return statusFromText(provider, path, null)
}

function guestPath(options: GuestManagedHookOptions): string {
  return managedHookGuestConfigPath('amp', options.guestHome)
}

export async function guestAmpStatus(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  return statusFromText(options.provider, path, text)
}

export async function installGuestAmpHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const existing = await readGuestHookText(
    options.runner,
    options.distro,
    path,
    options.signal
  )
  if (existing !== null && !isManaged(existing)) {
    return statusFromText(options.provider, path, existing)
  }
  const source = pluginSource({
    local: false,
    guestExecutablePath: options.guestExecutablePath,
    scriptPath: options.scriptPath,
    activitySocket: options.activitySocket,
    electronRunAsNode: options.electronRunAsNode
  })
  if (source !== existing) {
    await writeGuestHookText(options.runner, options.distro, path, source, options.signal)
  }
  return statusFromText(options.provider, path, source)
}

export async function removeGuestAmpHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const existing = await readGuestHookText(
    options.runner,
    options.distro,
    path,
    options.signal
  )
  if (existing === null) return statusFromText(options.provider, path, null)
  if (!isManaged(existing)) return statusFromText(options.provider, path, existing)
  await removeGuestHookFile(options.runner, options.distro, path, options.signal)
  return statusFromText(options.provider, path, null)
}

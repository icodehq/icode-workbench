import type { WslCommandRunner, WslExecOutcome } from '../wsl/exec'
import { isTransportOutcome } from '../wsl/probe'
import { managedHookGuestConfigPath } from '../../shared/domain/managed-hook-providers'
import {
  MANAGED_HOOK_PROVIDER_SPECS,
  applyManagedHookConfig,
  isManagedHookProviderDisabled,
  managedHooksStatusFromConfig,
  parseManagedHookConfig,
  removeManagedHookConfig,
  type ManagedHookEvent,
  type ManagedHookProvider,
  type ManagedHookProviderStatus
} from './managed-hooks'

const CONFIG_TIMEOUT_MS = 10_000
const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const GUEST_HOOK_ENV = [
  'ICODE_ACTIVITY_SOCKET',
  'ICODE_SESSION_ID',
  'ICODE_SESSION_INCARNATION'
] as const

const GUEST_READ = 'if [ -f "$1" ]; then cat -- "$1"; fi'
const GUEST_REMOVE = 'rm -f -- "$1"'
const GUEST_REMOVE_DIR = 'rm -rf -- "$1"'
const GUEST_WRITE = [
  'target="$1"',
  'if [ -L "$target" ]; then',
  '  resolved=$(readlink -f -- "$target" 2>/dev/null || :)',
  '  if [ -n "$resolved" ]; then target="$resolved"; fi',
  'fi',
  'tmp="$target.icode-tmp-$$"',
  'trap \'rm -f -- "$tmp"\' 0 1 2 15',
  'mkdir -p -- "$(dirname -- "$target")" || exit 1',
  'if [ -f "$target" ]; then cp -p -- "$target" "$target.icode.bak" 2>/dev/null || :; fi',
  'cat > "$tmp" || exit 1',
  'chmod 600 -- "$tmp" 2>/dev/null || true',
  'mv -f -- "$tmp" "$target" || exit 1',
  'trap - 0 1 2 15'
].join('\n')

export type GuestManagedHookOptions = {
  runner: WslCommandRunner
  distro: string
  provider: ManagedHookProvider
  guestHome: string
  /** Windows Electron/Node executable, spelled for a guest shell. */
  guestExecutablePath: string
  /** Windows path to icode-managed-hook.cjs; argv to the Windows process. */
  scriptPath: string
  /** Windows named pipe used by the Host activity ingress. */
  activitySocket: string
  electronRunAsNode: boolean
  signal?: AbortSignal
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function guestSuccess(result: WslExecOutcome, action: string): string {
  if (result.status === 'wsl_missing') {
    throw new Error(`WSL is not available while trying to ${action}.`)
  }
  if (result.status === 'timed_out' || result.status === 'cancelled') {
    throw new Error(`Timed out while trying to ${action}.`)
  }
  if (isTransportOutcome(result)) {
    throw new Error(`The WSL distro did not answer while trying to ${action}.`)
  }
  if (result.status !== 'ok') {
    const detail = result.stderr.trim()
    throw new Error(detail.length > 0 ? detail : `Could not ${action}.`)
  }
  return result.stdout
}

/** Guest config path, derived from the shared home-relative default. */
export const guestManagedHookConfigPath = managedHookGuestConfigPath

/**
 * The guest-side command starts a Windows Node/Electron process through WSL
 * interop. `WSLENV` carries the per-PTY identity; the activity pipe is set
 * explicitly because it is a Windows pipe name, not a path that WSL can infer.
 */
export function guestManagedHookCommand(
  options: GuestManagedHookOptions,
  event: ManagedHookEvent
): string {
  const crossed = options.electronRunAsNode
    ? [...GUEST_HOOK_ENV, 'ELECTRON_RUN_AS_NODE']
    : GUEST_HOOK_ENV
  const env = [
    `WSLENV=${shellQuote(crossed.join(':'))}`,
    `ICODE_ACTIVITY_SOCKET=${shellQuote(options.activitySocket)}`
  ]
  if (options.electronRunAsNode) env.push('ELECTRON_RUN_AS_NODE=1')
  return [
    'env',
    ...env,
    shellQuote(options.guestExecutablePath),
    shellQuote(options.scriptPath),
    shellQuote(options.provider),
    shellQuote(event.providerEvent),
    shellQuote(event.canonicalEvent),
    shellQuote(event.response)
  ].join(' ')
}

export async function readGuestHookText(
  runner: WslCommandRunner,
  distro: string,
  path: string,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await runner.run({
    scope: 'guest',
    label: 'managed-hooks-read',
    distro,
    argv: ['sh', '-c', GUEST_READ, 'icode-managed-hooks-read', path],
    timeoutMs: CONFIG_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal })
  })
  const text = guestSuccess(result, 'read a managed hook config')
  if (text.length > MAX_CONFIG_BYTES) throw new Error('The managed hook config is too large.')
  return text.length === 0 ? null : text
}

export async function writeGuestHookText(
  runner: WslCommandRunner,
  distro: string,
  path: string,
  text: string,
  signal?: AbortSignal
): Promise<void> {
  const result = await runner.run({
    scope: 'guest',
    label: 'managed-hooks-write',
    distro,
    argv: ['sh', '-c', GUEST_WRITE, 'icode-managed-hooks-write', path],
    stdin: text,
    timeoutMs: CONFIG_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal })
  })
  guestSuccess(result, 'write a managed hook config')
}

export async function removeGuestHookFile(
  runner: WslCommandRunner,
  distro: string,
  path: string,
  signal?: AbortSignal
): Promise<void> {
  const result = await runner.run({
    scope: 'guest',
    label: 'managed-hooks-remove',
    distro,
    argv: ['sh', '-c', GUEST_REMOVE, 'icode-managed-hooks-remove', path],
    timeoutMs: CONFIG_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal })
  })
  guestSuccess(result, 'remove a managed hook file')
}

/** Removes an iCode-owned plugin directory; callers pass a marker-owned path. */
export async function removeGuestHookDir(
  runner: WslCommandRunner,
  distro: string,
  path: string,
  signal?: AbortSignal
): Promise<void> {
  const result = await runner.run({
    scope: 'guest',
    label: 'managed-hooks-remove-dir',
    distro,
    argv: ['sh', '-c', GUEST_REMOVE_DIR, 'icode-managed-hooks-remove-dir', path],
    timeoutMs: CONFIG_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal })
  })
  guestSuccess(result, 'remove a managed hook directory')
}

async function readGuestConfig(options: GuestManagedHookOptions): Promise<string | null> {
  return readGuestHookText(
    options.runner,
    options.distro,
    guestManagedHookConfigPath(options.provider, options.guestHome),
    options.signal
  )
}

async function writeGuestConfig(
  options: GuestManagedHookOptions,
  text: string
): Promise<void> {
  return writeGuestHookText(
    options.runner,
    options.distro,
    guestManagedHookConfigPath(options.provider, options.guestHome),
    text,
    options.signal
  )
}

function serialized(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function commandFor(
  options: GuestManagedHookOptions,
  event: ManagedHookEvent
): string {
  return guestManagedHookCommand(options, event)
}

function statusFor(
  options: GuestManagedHookOptions,
  config: ReturnType<typeof parseManagedHookConfig>
): ManagedHookProviderStatus {
  return managedHooksStatusFromConfig(options.provider, config, (event) =>
    commandFor(options, event)
  )
}

export async function guestManagedHooksStatus(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestManagedHookConfigPath(options.provider, options.guestHome)
  const text = await readGuestConfig(options)
  return statusFor(options, parseManagedHookConfig(path, text))
}

export async function installGuestManagedHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[options.provider]
  const path = guestManagedHookConfigPath(options.provider, options.guestHome)
  const text = await readGuestConfig(options)
  const config = parseManagedHookConfig(path, text)
  if (config.state === 'invalid') {
    return {
      provider: options.provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: config.detail
    }
  }
  const value = config.state === 'ok' ? config.value : {}
  if (isManagedHookProviderDisabled(options.provider, value)) {
    return statusFor(options, { state: 'ok', value, raw: '', path })
  }
  const applied = applyManagedHookConfig(
    options.provider,
    value,
    (event) => commandFor(options, event),
    (event) => commandFor(options, event)
  )
  if (applied.error !== null) {
    return {
      provider: options.provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: applied.error
    }
  }
  const nextText = serialized(applied.value)
  if (nextText !== text) await writeGuestConfig(options, nextText)
  return statusFor(options, { state: 'ok', value: applied.value, raw: nextText, path })
}

export async function removeGuestManagedHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestManagedHookConfigPath(options.provider, options.guestHome)
  const text = await readGuestConfig(options)
  const config = parseManagedHookConfig(path, text)
  if (config.state !== 'ok') return statusFor(options, config)
  const removed = removeManagedHookConfig(config.value)
  if (removed.changed) await writeGuestConfig(options, serialized(removed.value))
  return statusFor(options, {
    state: 'ok',
    value: removed.value,
    raw: removed.changed ? serialized(removed.value) : (text ?? ''),
    path
  })
}

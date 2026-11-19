/**
 * Antigravity stores hooks as a named bundle inside Gemini's shared
 * `~/.gemini/config/hooks.json`. iCode owns only the `icode-status` bundle
 * entries; other bundles and user hooks inside ours are preserved.
 */

import {
  MANAGED_HOOK_PROVIDER_SPECS,
  cleanAllHookEvents,
  commandValues,
  configPathFor,
  currentManagedCommand,
  definitionHasManagedCommand,
  isRecord,
  readConfig,
  writeConfig,
  type ManagedHookEvent,
  type ManagedHookInstallOptions,
  type ManagedHookProviderStatus,
  type ManagedHookRuntime
} from './managed-hooks'
import { managedHookGuestConfigPath } from '../../shared/domain/managed-hook-providers'
import {
  guestManagedHookCommand,
  readGuestHookText,
  writeGuestHookText,
  type GuestManagedHookOptions
} from './managed-hooks-guest'

export const ANTIGRAVITY_BUNDLE = 'icode-status'
const MAX_CONFIG_BYTES = 4 * 1024 * 1024

function definitionFor(
  event: ManagedHookEvent,
  command: string,
  timeoutSeconds: number
): Record<string, unknown> {
  if (event.matcher !== undefined) {
    return {
      matcher: event.matcher,
      hooks: [{ type: 'command', command, timeout: timeoutSeconds }]
    }
  }
  return { type: 'command', command, timeout: timeoutSeconds }
}

function bundleOf(value: Record<string, unknown>): Record<string, unknown> | null {
  const existing = value[ANTIGRAVITY_BUNDLE]
  if (existing === undefined) return {}
  return isRecord(existing) ? existing : null
}

function applyBundle(
  value: Record<string, unknown>,
  provider: 'antigravity',
  commandForEvent: (event: ManagedHookEvent) => string
): { value: Record<string, unknown>; error: string | null } {
  const bundle = bundleOf(value)
  if (bundle === null) {
    return { value, error: 'The Antigravity bundle in hooks.json is not a JSON object.' }
  }
  const cleaned = cleanAllHookEvents(bundle)
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  for (const event of spec.events) {
    const current = cleaned.value[event.providerEvent]
    if (current !== undefined && !Array.isArray(current)) {
      return {
        value,
        error: `The Antigravity hook "${event.providerEvent}" is not an array.`
      }
    }
    cleaned.value[event.providerEvent] = [
      ...(Array.isArray(current) ? current : []),
      definitionFor(event, commandForEvent(event), spec.timeoutSeconds)
    ]
  }
  return { value: { ...value, [ANTIGRAVITY_BUNDLE]: cleaned.value }, error: null }
}

export function applyAntigravityHooks(
  value: Record<string, unknown>,
  commandForEvent: (event: ManagedHookEvent) => string
): { value: Record<string, unknown>; error: string | null } {
  return applyBundle(value, 'antigravity', commandForEvent)
}

export function removeAntigravityHooks(value: Record<string, unknown>): {
  value: Record<string, unknown>
  changed: boolean
} {
  const bundle = bundleOf(value)
  if (bundle === null) return { value, changed: false }
  const cleaned = cleanAllHookEvents(bundle)
  if (!cleaned.changed) return { value, changed: false }
  const next = { ...value }
  if (Object.keys(cleaned.value).length === 0) delete next[ANTIGRAVITY_BUNDLE]
  else next[ANTIGRAVITY_BUNDLE] = cleaned.value
  return { value: next, changed: true }
}

export function antigravityStatusFromConfig(
  config: ReturnType<typeof readConfig>,
  commandForEvent: (event: ManagedHookEvent) => string
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS.antigravity
  if (config.state !== 'ok') {
    return {
      provider: 'antigravity',
      label: spec.label,
      state: config.state === 'invalid' ? 'failed' : 'not-installed',
      configPath: config.path,
      detail: config.state === 'invalid' ? config.detail : null
    }
  }
  const bundle = bundleOf(config.value)
  if (bundle === null) {
    return {
      provider: 'antigravity',
      label: spec.label,
      state: 'failed',
      configPath: config.path,
      detail: 'The Antigravity bundle in hooks.json is not a JSON object.'
    }
  }
  const missing: string[] = []
  let present = 0
  for (const event of spec.events) {
    const definitions = bundle[event.providerEvent]
    if (definitions !== undefined && !Array.isArray(definitions)) {
      return {
        provider: 'antigravity',
        label: spec.label,
        state: 'failed',
        configPath: config.path,
        detail: `The Antigravity hook "${event.providerEvent}" is not an array.`
      }
    }
    const current =
      Array.isArray(definitions) &&
      definitions.some((definition) => currentManagedCommand(definition, commandForEvent(event)))
    if (current) present += 1
    else missing.push(event.providerEvent)
  }
  let stale = false
  for (const [eventName, definitions] of Object.entries(bundle)) {
    if (!Array.isArray(definitions)) continue
    const expected = spec.events.find((event) => event.providerEvent === eventName)
    const current = expected === undefined ? null : commandForEvent(expected)
    for (const definition of definitions) {
      if (!definitionHasManagedCommand(definition)) continue
      const values = isRecord(definition) ? commandValues(definition) : []
      if (current === null || !values.includes(current)) stale = true
    }
  }
  if (stale) {
    return {
      provider: 'antigravity',
      label: spec.label,
      state: 'partial',
      configPath: config.path,
      detail: 'Managed hook entries are stale.'
    }
  }
  if (missing.length === 0) {
    return {
      provider: 'antigravity',
      label: spec.label,
      state: 'installed',
      configPath: config.path,
      detail: null
    }
  }
  return {
    provider: 'antigravity',
    label: spec.label,
    state: present === 0 ? 'not-installed' : 'partial',
    configPath: config.path,
    detail: present === 0 ? null : `Managed hook missing for: ${missing.join(', ')}`
  }
}

export function localAntigravityStatus(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const path = configPathFor('antigravity', options)
  return antigravityStatusFromConfig(readConfig(path), (event) =>
    runtime.commandFor('antigravity', event)
  )
}

export function installLocalAntigravityHooks(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const path = configPathFor('antigravity', options)
  const config = readConfig(path)
  if (config.state === 'invalid') {
    return {
      provider: 'antigravity',
      label: MANAGED_HOOK_PROVIDER_SPECS.antigravity.label,
      state: 'failed',
      configPath: path,
      detail: config.detail
    }
  }
  const value = config.state === 'ok' ? config.value : {}
  const applied = applyAntigravityHooks(value, (event) =>
    runtime.commandFor('antigravity', event)
  )
  if (applied.error !== null) {
    return {
      provider: 'antigravity',
      label: MANAGED_HOOK_PROVIDER_SPECS.antigravity.label,
      state: 'failed',
      configPath: path,
      detail: applied.error
    }
  }
  writeConfig(path, applied.value)
  return antigravityStatusFromConfig(readConfig(path), (event) =>
    runtime.commandFor('antigravity', event)
  )
}

export function removeLocalAntigravityHooks(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const path = configPathFor('antigravity', options)
  const config = readConfig(path)
  if (config.state !== 'ok') {
    return antigravityStatusFromConfig(config, (event) =>
      runtime.commandFor('antigravity', event)
    )
  }
  const removed = removeAntigravityHooks(config.value)
  if (removed.changed) writeConfig(path, removed.value)
  return antigravityStatusFromConfig(readConfig(path), (event) =>
    runtime.commandFor('antigravity', event)
  )
}

function guestPath(options: GuestManagedHookOptions): string {
  return managedHookGuestConfigPath('antigravity', options.guestHome)
}

function guestCommand(options: GuestManagedHookOptions, event: ManagedHookEvent): string {
  return guestManagedHookCommand(options, event)
}

function parseGuest(path: string, text: string | null): ReturnType<typeof readConfig> {
  if (text === null) return { state: 'missing', path }
  if (text.length > MAX_CONFIG_BYTES) {
    return { state: 'invalid', path, detail: 'The config file is too large.' }
  }
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (withoutBom.trim().length === 0) return { state: 'ok', value: {}, raw: text, path }
  try {
    const parsed: unknown = JSON.parse(withoutBom)
    return isRecord(parsed)
      ? { state: 'ok', value: parsed, raw: text, path }
      : { state: 'invalid', path, detail: 'The config root is not a JSON object.' }
  } catch {
    return { state: 'invalid', path, detail: 'The config is not valid JSON.' }
  }
}

export async function guestAntigravityStatus(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  return antigravityStatusFromConfig(parseGuest(path, text), (event) => guestCommand(options, event))
}

export async function installGuestAntigravityHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  const config = parseGuest(path, text)
  if (config.state === 'invalid') {
    return {
      provider: 'antigravity',
      label: MANAGED_HOOK_PROVIDER_SPECS.antigravity.label,
      state: 'failed',
      configPath: path,
      detail: config.detail
    }
  }
  const value = config.state === 'ok' ? config.value : {}
  const applied = applyAntigravityHooks(value, (event) => guestCommand(options, event))
  if (applied.error !== null) {
    return {
      provider: 'antigravity',
      label: MANAGED_HOOK_PROVIDER_SPECS.antigravity.label,
      state: 'failed',
      configPath: path,
      detail: applied.error
    }
  }
  const next = `${JSON.stringify(applied.value, null, 2)}\n`
  if (next !== text) {
    await writeGuestHookText(options.runner, options.distro, path, next, options.signal)
  }
  return antigravityStatusFromConfig(parseGuest(path, next), (event) =>
    guestCommand(options, event)
  )
}

export async function removeGuestAntigravityHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  const config = parseGuest(path, text)
  if (config.state !== 'ok') {
    return antigravityStatusFromConfig(config, (event) => guestCommand(options, event))
  }
  const removed = removeAntigravityHooks(config.value)
  if (removed.changed) {
    await writeGuestHookText(
      options.runner,
      options.distro,
      path,
      `${JSON.stringify(removed.value, null, 2)}\n`,
      options.signal
    )
  }
  return antigravityStatusFromConfig(parseGuest(path, removed.changed ? `${JSON.stringify(removed.value, null, 2)}\n` : text), (event) => guestCommand(options, event))
}

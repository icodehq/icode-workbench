/**
 * Kiro's global hook file (`$KIRO_HOME/hooks/icode-agent-status.json`), read
 * by kiro-cli 2.31 and later.
 *
 * iCode installs list-form v1 triggers and never edits the user's agent
 * configs. Kiro injects hook stdout into the model context, so managed
 * commands are installed with the silent response mode.
 */

import { existsSync, unlinkSync } from 'node:fs'
import {
  MANAGED_HOOK_PROVIDER_SPECS,
  isManagedHookCommand,
  isRecord,
  type ManagedHookEvent,
  type ManagedHookInstallOptions,
  type ManagedHookProviderStatus,
  type ManagedHookRuntime
} from './managed-hooks'
import {
  guestManagedHookCommand,
  readGuestHookText,
  removeGuestHookFile,
  writeGuestHookText,
  type GuestManagedHookOptions
} from './managed-hooks-guest'
import { readTextOrNull, writeTextAtomic } from './managed-hooks-text'

const HOOK_NAME_PREFIX = 'icode-agent-status-'
const TOOL_TRIGGERS = new Set(['PreToolUse', 'PostToolUse'])

function entryFor(
  event: ManagedHookEvent,
  command: string,
  timeoutSeconds: number
): Record<string, unknown> {
  return {
    name: `${HOOK_NAME_PREFIX}${event.providerEvent}`,
    trigger: event.providerEvent,
    ...(TOOL_TRIGGERS.has(event.providerEvent) ? { matcher: '*' } : {}),
    action: { type: 'command', command },
    timeout: timeoutSeconds
  }
}

function isManagedEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false
  if (typeof entry.name === 'string' && entry.name.startsWith(HOOK_NAME_PREFIX)) return true
  const action = entry.action
  return isRecord(action) && isManagedHookCommand(action.command)
}

function runsCommand(entry: unknown, command: string): boolean {
  if (!isRecord(entry)) return false
  const action = entry.action
  return isRecord(action) && action.command === command
}

function entriesOf(value: Record<string, unknown>): unknown[] | null {
  if (value.hooks === undefined) return []
  return Array.isArray(value.hooks) ? value.hooks : null
}

export function applyKiroHooks(
  value: Record<string, unknown>,
  commandForEvent: (event: ManagedHookEvent) => string
): { value: Record<string, unknown>; error: string | null } {
  const existing = entriesOf(value)
  if (existing === null) {
    return { value, error: 'The Kiro hooks file "hooks" value is not an array.' }
  }
  const spec = MANAGED_HOOK_PROVIDER_SPECS.kiro
  const kept = existing.filter((entry) => !isManagedEntry(entry))
  const additions = spec.events.map((event) =>
    entryFor(event, commandForEvent(event), spec.timeoutSeconds)
  )
  return { value: { ...value, version: 'v1', hooks: [...kept, ...additions] }, error: null }
}

export function removeKiroHooks(value: Record<string, unknown>): {
  value: Record<string, unknown> | null
  changed: boolean
} {
  const existing = entriesOf(value)
  if (existing === null) return { value, changed: false }
  const kept = existing.filter((entry) => !isManagedEntry(entry))
  if (kept.length === existing.length) return { value, changed: false }
  const remainingFields = Object.keys(value).filter(
    (key) => key !== 'version' && key !== 'hooks'
  )
  if (kept.length === 0 && remainingFields.length === 0) {
    return { value: null, changed: true }
  }
  return { value: { ...value, version: 'v1', hooks: kept }, changed: true }
}

type Parsed = { value: Record<string, unknown> } | { error: string } | null

function parseFile(text: string | null): Parsed {
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? { value: parsed } : { error: 'The Kiro hooks file root is not an object.' }
  } catch {
    return { error: 'The Kiro hooks file is not valid JSON.' }
  }
}

function statusFrom(
  configPath: string,
  text: string | null,
  commandForEvent: (event: ManagedHookEvent) => string
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS.kiro
  const base = { provider: 'kiro' as const, label: spec.label, configPath }
  const parsed = parseFile(text)
  if (parsed === null) return { ...base, state: 'not-installed', detail: null }
  if ('error' in parsed) return { ...base, state: 'failed', detail: parsed.error }
  const entries = entriesOf(parsed.value)
  if (entries === null) {
    return { ...base, state: 'failed', detail: 'The Kiro hooks file "hooks" value is not an array.' }
  }
  const missing: string[] = []
  let present = 0
  for (const event of spec.events) {
    const current = entries.some(
      (entry) =>
        isRecord(entry) &&
        entry.trigger === event.providerEvent &&
        runsCommand(entry, commandForEvent(event))
    )
    if (current) present += 1
    else missing.push(event.providerEvent)
  }
  let stale = false
  for (const entry of entries) {
    if (!isManagedEntry(entry) || !isRecord(entry)) continue
    const expected = spec.events.find((event) => event.providerEvent === entry.trigger)
    if (expected === undefined || !runsCommand(entry, commandForEvent(expected))) {
      stale = true
    }
  }
  if (stale) {
    return { ...base, state: 'partial', detail: 'Managed hook entries are stale.' }
  }
  if (missing.length === 0) return { ...base, state: 'installed', detail: null }
  return {
    ...base,
    state: present === 0 ? 'not-installed' : 'partial',
    detail: present === 0 ? null : `Managed hook missing for: ${missing.join(', ')}`
  }
}

export function localKiroStatus(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const path = MANAGED_HOOK_PROVIDER_SPECS.kiro.configPath(
    options.home,
    options.env ?? process.env
  )
  try {
    return statusFrom(path, readTextOrNull(path), (event) => runtime.commandFor('kiro', event))
  } catch (error) {
    return {
      provider: 'kiro',
      label: MANAGED_HOOK_PROVIDER_SPECS.kiro.label,
      state: 'failed',
      configPath: path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export function installLocalKiroHooks(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const path = MANAGED_HOOK_PROVIDER_SPECS.kiro.configPath(
    options.home,
    options.env ?? process.env
  )
  let text: string | null
  try {
    text = readTextOrNull(path)
  } catch (error) {
    return {
      provider: 'kiro',
      label: MANAGED_HOOK_PROVIDER_SPECS.kiro.label,
      state: 'failed',
      configPath: path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  const parsed = parseFile(text)
  if (parsed !== null && 'error' in parsed) {
    return {
      provider: 'kiro',
      label: MANAGED_HOOK_PROVIDER_SPECS.kiro.label,
      state: 'failed',
      configPath: path,
      detail: parsed.error
    }
  }
  const value = parsed === null ? {} : parsed.value
  const applied = applyKiroHooks(value, (event) => runtime.commandFor('kiro', event))
  if (applied.error !== null) {
    return {
      provider: 'kiro',
      label: MANAGED_HOOK_PROVIDER_SPECS.kiro.label,
      state: 'failed',
      configPath: path,
      detail: applied.error
    }
  }
  const next = `${JSON.stringify(applied.value, null, 2)}\n`
  writeTextAtomic(path, next)
  return statusFrom(path, next, (event) => runtime.commandFor('kiro', event))
}

export function removeLocalKiroHooks(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const path = MANAGED_HOOK_PROVIDER_SPECS.kiro.configPath(
    options.home,
    options.env ?? process.env
  )
  let text: string | null
  try {
    text = readTextOrNull(path)
  } catch (error) {
    return {
      provider: 'kiro',
      label: MANAGED_HOOK_PROVIDER_SPECS.kiro.label,
      state: 'failed',
      configPath: path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  const parsed = parseFile(text)
  if (parsed === null) {
    return statusFrom(path, null, (event) => runtime.commandFor('kiro', event))
  }
  if ('error' in parsed) {
    return {
      provider: 'kiro',
      label: MANAGED_HOOK_PROVIDER_SPECS.kiro.label,
      state: 'failed',
      configPath: path,
      detail: parsed.error
    }
  }
  const removed = removeKiroHooks(parsed.value)
  if (!removed.changed) {
    return statusFrom(path, text, (event) => runtime.commandFor('kiro', event))
  }
  if (removed.value === null) {
    if (existsSync(path)) unlinkSync(path)
    return statusFrom(path, null, (event) => runtime.commandFor('kiro', event))
  }
  const next = `${JSON.stringify(removed.value, null, 2)}\n`
  writeTextAtomic(path, next)
  return statusFrom(path, next, (event) => runtime.commandFor('kiro', event))
}

function guestPath(options: GuestManagedHookOptions): string {
  return `${options.guestHome.replace(/\/+$/u, '')}/.kiro/hooks/icode-agent-status.json`
}

export async function guestKiroStatus(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  return statusFrom(path, text, (event) => guestManagedHookCommand(options, event))
}

export async function installGuestKiroHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  const parsed = parseFile(text)
  if (parsed !== null && 'error' in parsed) {
    return {
      provider: 'kiro',
      label: MANAGED_HOOK_PROVIDER_SPECS.kiro.label,
      state: 'failed',
      configPath: path,
      detail: parsed.error
    }
  }
  const applied = applyKiroHooks(parsed === null ? {} : parsed.value, (event) =>
    guestManagedHookCommand(options, event)
  )
  if (applied.error !== null) {
    return {
      provider: 'kiro',
      label: MANAGED_HOOK_PROVIDER_SPECS.kiro.label,
      state: 'failed',
      configPath: path,
      detail: applied.error
    }
  }
  const next = `${JSON.stringify(applied.value, null, 2)}\n`
  if (next !== text) {
    await writeGuestHookText(options.runner, options.distro, path, next, options.signal)
  }
  return statusFrom(path, next, (event) => guestManagedHookCommand(options, event))
}

export async function removeGuestKiroHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  const parsed = parseFile(text)
  if (parsed === null) {
    return statusFrom(path, null, (event) => guestManagedHookCommand(options, event))
  }
  if ('error' in parsed) {
    return {
      provider: 'kiro',
      label: MANAGED_HOOK_PROVIDER_SPECS.kiro.label,
      state: 'failed',
      configPath: path,
      detail: parsed.error
    }
  }
  const removed = removeKiroHooks(parsed.value)
  if (removed.value === null) {
    await removeGuestHookFile(options.runner, options.distro, path, options.signal)
    return statusFrom(path, null, (event) => guestManagedHookCommand(options, event))
  }
  if (removed.changed) {
    const next = `${JSON.stringify(removed.value, null, 2)}\n`
    await writeGuestHookText(options.runner, options.distro, path, next, options.signal)
    return statusFrom(path, next, (event) => guestManagedHookCommand(options, event))
  }
  return statusFrom(path, text, (event) => guestManagedHookCommand(options, event))
}

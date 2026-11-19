/**
 * JSONC settings with a hooks tree: Devin's `config.json` and ZCode's
 * `config.json`.
 *
 * Both providers document JSON (Devin explicitly JSONC) and users keep
 * comments in them. iCode edits only the hook paths it owns through
 * jsonc-parser so unrelated formatting, key order and comments survive.
 */

import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'
import {
  MANAGED_HOOK_PROVIDER_SPECS,
  cleanAllHookEvents,
  commandValues,
  configPathFor,
  currentManagedCommand,
  definitionHasManagedCommand,
  isRecord,
  type ManagedHookEvent,
  type ManagedHookInstallOptions,
  type ManagedHookProvider,
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
import { readTextOrNull, writeTextAtomic } from './managed-hooks-text'

const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const JSON_EDIT_FORMATTING = {
  formattingOptions: { insertSpaces: true, tabSize: 2 }
} as const

type Parsed = { value: Record<string, unknown>; raw: string } | { error: string }

function parseText(raw: string): Parsed {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (withoutBom.trim().length === 0) return { value: {}, raw }
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(withoutBom, errors)
  if (errors.length > 0) return { error: 'The config is not valid JSON.' }
  if (!isRecord(parsed)) return { error: 'The config root is not a JSON object.' }
  return { value: parsed, raw }
}

function edit(text: string, path: readonly string[], value: unknown): string {
  return applyEdits(text, modify(text, [...path], value, JSON_EDIT_FORMATTING))
}

function nestedDefinition(command: string, timeout: number): Record<string, unknown> {
  return { hooks: [{ type: 'command', command, timeout }] }
}

function readHooks(value: Record<string, unknown>): Record<string, unknown> | null {
  const hooks = value.hooks
  if (hooks === undefined) return {}
  return isRecord(hooks) ? hooks : null
}

function zcodeEvents(hooks: Record<string, unknown>): Record<string, unknown> | null {
  const events = hooks.events
  if (events === undefined) return {}
  return isRecord(events) ? events : null
}

function nextEvents(
  previous: Record<string, unknown>,
  provider: ManagedHookProvider,
  commandForEvent: (event: ManagedHookEvent) => string
): { events: Record<string, unknown>; error: string | null } {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const cleaned = cleanAllHookEvents(previous)
  for (const event of spec.events) {
    const current = cleaned.value[event.providerEvent]
    if (current !== undefined && !Array.isArray(current)) {
      return {
        events: previous,
        error: `The config hook "${event.providerEvent}" is not an array.`
      }
    }
    cleaned.value[event.providerEvent] = [
      ...(Array.isArray(current) ? current : []),
      nestedDefinition(commandForEvent(event), spec.timeoutSeconds)
    ]
  }
  return { events: cleaned.value, error: null }
}

export function applyJsoncHooks(
  provider: ManagedHookProvider,
  raw: string,
  commandForEvent: (event: ManagedHookEvent) => string
): { text: string; error: string | null } {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const parsed = parseText(raw)
  if ('error' in parsed) return { text: raw, error: parsed.error }
  const hooks = readHooks(parsed.value)
  if (hooks === null) {
    return { text: raw, error: 'The config "hooks" value is not a JSON object.' }
  }
  const rawIsEmpty = raw.trim().length === 0
  if (provider === 'zcode') {
    const events = zcodeEvents(hooks)
    if (events === null) {
      return { text: raw, error: 'The config "hooks.events" value is not a JSON object.' }
    }
    const next = nextEvents(events, provider, commandForEvent)
    if (next.error !== null) return { text: raw, error: next.error }
    if (rawIsEmpty) {
      return {
        text: `${JSON.stringify({ hooks: { enabled: true, events: next.events } }, null, 2)}\n`,
        error: null
      }
    }
    let text = raw
    if (hooks.enabled !== true) text = edit(text, ['hooks', 'enabled'], true)
    // Include retired event keys so a managed entry from an older install is
    // removed instead of being reported stale forever.
    for (const eventName of new Set([
      ...Object.keys(events),
      ...spec.events.map((event) => event.providerEvent)
    ])) {
      const before = events[eventName]
      const after = next.events[eventName]
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        text = edit(text, ['hooks', 'events', eventName], after)
      }
    }
    return { text, error: null }
  }

  const next = nextEvents(hooks, provider, commandForEvent)
  if (next.error !== null) return { text: raw, error: next.error }
  if (rawIsEmpty) {
    return { text: `${JSON.stringify({ hooks: next.events }, null, 2)}\n`, error: null }
  }
  let text = raw
  for (const eventName of new Set([
    ...Object.keys(hooks),
    ...spec.events.map((event) => event.providerEvent)
  ])) {
    const before = hooks[eventName]
    const after = next.events[eventName]
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      text = edit(text, ['hooks', eventName], after)
    }
  }
  return { text, error: null }
}

export function removeJsoncHooks(
  provider: ManagedHookProvider,
  raw: string
): { text: string; error: string | null } {
  const parsed = parseText(raw)
  if ('error' in parsed) return { text: raw, error: parsed.error }
  const hooks = readHooks(parsed.value)
  if (hooks === null) {
    return { text: raw, error: 'The config "hooks" value is not a JSON object.' }
  }
  const root = provider === 'zcode' ? zcodeEvents(hooks) : hooks
  if (root === null) {
    return { text: raw, error: 'The config "hooks.events" value is not a JSON object.' }
  }
  const cleaned = cleanAllHookEvents(root)
  if (!cleaned.changed) return { text: raw, error: null }
  let text = raw
  for (const event of Object.keys(root)) {
    if (!(event in cleaned.value)) {
      text =
        provider === 'zcode'
          ? edit(text, ['hooks', 'events', event], undefined)
          : edit(text, ['hooks', event], undefined)
    }
  }
  // Defensive: also remove managed entries from events iCode no longer lists.
  for (const [event, value] of Object.entries(cleaned.value)) {
    if (JSON.stringify(root[event]) !== JSON.stringify(value)) {
      text =
        provider === 'zcode'
          ? edit(text, ['hooks', 'events', event], value)
          : edit(text, ['hooks', event], value)
    }
  }
  return { text, error: null }
}

function statusFromText(
  provider: ManagedHookProvider,
  configPath: string,
  raw: string | null,
  commandForEvent: (event: ManagedHookEvent) => string
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  if (raw === null) {
    return { provider, label: spec.label, state: 'not-installed', configPath, detail: null }
  }
  const parsed = parseText(raw)
  if ('error' in parsed) {
    return { provider, label: spec.label, state: 'failed', configPath, detail: parsed.error }
  }
  const hooks = readHooks(parsed.value)
  if (hooks === null) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath,
      detail: 'The config "hooks" value is not a JSON object.'
    }
  }
  const root = provider === 'zcode' ? zcodeEvents(hooks) : hooks
  if (root === null) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath,
      detail: 'The config "hooks.events" value is not a JSON object.'
    }
  }
  const missing: string[] = []
  let present = 0
  for (const event of spec.events) {
    const definitions = root[event.providerEvent]
    if (definitions !== undefined && !Array.isArray(definitions)) {
      return {
        provider,
        label: spec.label,
        state: 'failed',
        configPath,
        detail: `The config hook "${event.providerEvent}" is not an array.`
      }
    }
    const hasCurrent =
      Array.isArray(definitions) &&
      definitions.some((definition) => currentManagedCommand(definition, commandForEvent(event)))
    if (hasCurrent) present += 1
    else missing.push(event.providerEvent)
  }
  let stale = false
  for (const [eventName, definitions] of Object.entries(root)) {
    if (!Array.isArray(definitions)) continue
    const expected = spec.events.find((event) => event.providerEvent === eventName)
    const current = expected === undefined ? null : commandForEvent(expected)
    for (const definition of definitions) {
      if (!definitionHasManagedCommand(definition)) continue
      const values = isRecord(definition) ? commandValues(definition) : []
      if (current === null || !values.includes(current)) stale = true
    }
  }
  if (provider === 'zcode' && hooks.enabled !== true && present > 0) {
    return {
      provider,
      label: spec.label,
      state: 'partial',
      configPath,
      detail: 'ZCode hooks are disabled in the config.'
    }
  }
  if (stale) {
    return {
      provider,
      label: spec.label,
      state: 'partial',
      configPath,
      detail: 'Managed hook entries are stale.'
    }
  }
  if (missing.length === 0) {
    return { provider, label: spec.label, state: 'installed', configPath, detail: null }
  }
  return {
    provider,
    label: spec.label,
    state: present === 0 ? 'not-installed' : 'partial',
    configPath,
    detail: present === 0 ? null : `Managed hook missing for: ${missing.join(', ')}`
  }
}

export function localJsoncStatus(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const path = configPathFor(provider, options)
  let raw: string | null
  try {
    raw = readTextOrNull(path)
  } catch (error) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  if (raw !== null && raw.length > MAX_CONFIG_BYTES) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: 'The config file is too large.'
    }
  }
  return statusFromText(provider, path, raw, (event) => runtime.commandFor(provider, event))
}

export function installLocalJsoncHooks(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const path = configPathFor(provider, options)
  let raw: string | null
  try {
    raw = readTextOrNull(path)
  } catch (error) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  if (raw !== null && raw.length > MAX_CONFIG_BYTES) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: 'The config file is too large.'
    }
  }
  const applied = applyJsoncHooks(provider, raw ?? '', (event) => runtime.commandFor(provider, event))
  if (applied.error !== null) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: applied.error
    }
  }
  const next = applied.text.length > 0 ? applied.text : `${JSON.stringify({}, null, 2)}\n`
  writeTextAtomic(path, next)
  return statusFromText(provider, path, next, (event) => runtime.commandFor(provider, event))
}

export function removeLocalJsoncHooks(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const path = configPathFor(provider, options)
  let raw: string | null
  try {
    raw = readTextOrNull(path)
  } catch (error) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  const removed = removeJsoncHooks(provider, raw ?? '')
  if (removed.error !== null) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: removed.error
    }
  }
  if (removed.text !== raw) writeTextAtomic(path, removed.text)
  return statusFromText(provider, path, removed.text, (event) => runtime.commandFor(provider, event))
}

function guestPath(provider: ManagedHookProvider, guestHome: string): string {
  return managedHookGuestConfigPath(provider, guestHome)
}

function guestCommand(options: GuestManagedHookOptions, event: ManagedHookEvent): string {
  return guestManagedHookCommand(options, event)
}

export async function guestJsoncStatus(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options.provider, options.guestHome)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  return statusFromText(options.provider, path, text, (event) => guestCommand(options, event))
}

export async function installGuestJsoncHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options.provider, options.guestHome)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  const applied = applyJsoncHooks(options.provider, text ?? '', (event) => guestCommand(options, event))
  if (applied.error !== null) {
    return {
      provider: options.provider,
      label: MANAGED_HOOK_PROVIDER_SPECS[options.provider].label,
      state: 'failed',
      configPath: path,
      detail: applied.error
    }
  }
  if (applied.text !== text) {
    await writeGuestHookText(options.runner, options.distro, path, applied.text, options.signal)
  }
  return statusFromText(options.provider, path, applied.text, (event) => guestCommand(options, event))
}

export async function removeGuestJsoncHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options.provider, options.guestHome)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  if (text === null) {
    return statusFromText(options.provider, path, null, (event) => guestCommand(options, event))
  }
  const removed = removeJsoncHooks(options.provider, text)
  if (removed.error !== null) {
    return {
      provider: options.provider,
      label: MANAGED_HOOK_PROVIDER_SPECS[options.provider].label,
      state: 'failed',
      configPath: path,
      detail: removed.error
    }
  }
  if (removed.text !== text) {
    await writeGuestHookText(options.runner, options.distro, path, removed.text, options.signal)
  }
  return statusFromText(options.provider, path, removed.text, (event) => guestCommand(options, event))
}

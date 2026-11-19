/**
 * Muse keeps its own settings.json and loads hook definitions from a separate
 * file named by `managed_hooks_path`.
 *
 * The separate file is iCode-owned and replaced wholesale, matching Muse's
 * managed-hooks contract. settings.json is edited through jsonc-parser so user
 * comments and unrelated settings survive. Muse strips nonstandard environment
 * variables from hooks, so iCode's identity names must also be allowlisted in
 * `managed_hooks_env_vars`.
 */

import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'
import {
  MANAGED_HOOK_PROVIDER_SPECS,
  commandValues,
  configPathFor,
  currentManagedCommand,
  definitionHasManagedCommand,
  isRecord,
  type ManagedHookEvent,
  type ManagedHookInstallOptions,
  type ManagedHookProviderStatus,
  type ManagedHookRuntime
} from './managed-hooks'
import { managedHookGuestConfigPath } from '../../shared/domain/managed-hook-providers'
import {
  guestManagedHookCommand,
  readGuestHookText,
  removeGuestHookFile,
  writeGuestHookText,
  type GuestManagedHookOptions
} from './managed-hooks-guest'
import { readTextOrNull, writeTextAtomic } from './managed-hooks-text'

export const MUSE_MANAGED_HOOKS_FILE = 'muse-hooks.json'
export const MUSE_HOOK_ENV_VARS = [
  'ICODE_ACTIVITY_SOCKET',
  'ICODE_SESSION_ID',
  'ICODE_SESSION_INCARNATION'
] as const

const JSON_EDIT_FORMATTING = {
  formattingOptions: { insertSpaces: true, tabSize: 2 }
} as const

function hooksFilePath(directory: string): string {
  return join(directory, MUSE_MANAGED_HOOKS_FILE)
}

function settingsPath(options: ManagedHookInstallOptions): string {
  return configPathFor('muse', options)
}

function buildHooksFile(commandForEvent: (event: ManagedHookEvent) => string): string {
  const spec = MANAGED_HOOK_PROVIDER_SPECS.muse
  const hooks: Record<string, unknown> = {}
  for (const event of spec.events) {
    // Muse refuses synchronous Interrupt hooks.
    const command = {
      type: 'command',
      command: commandForEvent(event),
      timeout: spec.timeoutSeconds,
      ...(event.providerEvent === 'Interrupt' ? { async: true } : {})
    }
    hooks[event.providerEvent] = [{ hooks: [command] }]
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

type ParsedSettings = { value: Record<string, unknown>; raw: string } | { error: string }

function parseSettings(raw: string): ParsedSettings {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (withoutBom.trim().length === 0) return { value: {}, raw }
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(withoutBom, errors)
  if (errors.length > 0) return { error: 'Muse settings.json is not valid JSON.' }
  if (!isRecord(parsed)) return { error: 'Muse settings.json root is not an object.' }
  return { value: parsed, raw }
}

function edit(text: string, path: readonly string[], value: unknown): string {
  return applyEdits(text, modify(text, [...path], value, JSON_EDIT_FORMATTING))
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null
  return value as string[]
}

function applySettings(
  raw: string,
  hooksPath: string
): { text: string; error: string | null } {
  const parsed = parseSettings(raw)
  if ('error' in parsed) return { text: raw, error: parsed.error }
  const existingEnv = stringList(parsed.value.managed_hooks_env_vars)
  if (existingEnv === null) {
    return { text: raw, error: 'Muse managed_hooks_env_vars is not a string list.' }
  }
  const merged = [
    ...existingEnv,
    ...MUSE_HOOK_ENV_VARS.filter((name) => !existingEnv.includes(name))
  ]
  if (raw.trim().length === 0) {
    return {
      text: `${JSON.stringify(
        {
          schema_version: 1,
          managed_hooks_path: hooksPath,
          managed_hooks_env_vars: merged
        },
        null,
        2
      )}\n`,
      error: null
    }
  }
  let text = raw
  if (parsed.value.schema_version === undefined) text = edit(text, ['schema_version'], 1)
  if (parsed.value.managed_hooks_path !== hooksPath) {
    text = edit(text, ['managed_hooks_path'], hooksPath)
  }
  if (JSON.stringify(parsed.value.managed_hooks_env_vars) !== JSON.stringify(merged)) {
    text = edit(text, ['managed_hooks_env_vars'], merged)
  }
  return { text, error: null }
}

function removeSettings(raw: string): { text: string; changed: boolean; error: string | null } {
  const parsed = parseSettings(raw)
  if ('error' in parsed) return { text: raw, changed: false, error: parsed.error }
  if (parsed.value.managed_hooks_path === undefined) {
    return { text: raw, changed: false, error: null }
  }
  const env = stringList(parsed.value.managed_hooks_env_vars)
  if (env === null) {
    return { text: raw, changed: false, error: 'Muse managed_hooks_env_vars is not a string list.' }
  }
  const filtered = env.filter(
    (name) => !(MUSE_HOOK_ENV_VARS as readonly string[]).includes(name)
  )
  let text = edit(raw, ['managed_hooks_path'], undefined)
  text = edit(
    text,
    ['managed_hooks_env_vars'],
    filtered.length === 0 ? undefined : filtered
  )
  return { text, changed: true, error: null }
}

type ParsedHooks = { hooks: Record<string, unknown> } | { error: string }

function parseHooks(raw: string | null): ParsedHooks | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
      return { error: 'The Muse managed hooks file is not a hooks object.' }
    }
    return { hooks: parsed.hooks }
  } catch {
    return { error: 'The Muse managed hooks file is not valid JSON.' }
  }
}

function statusFrom(
  settingsPathValue: string,
  settingsRaw: string | null,
  hooksPath: string,
  hooksRaw: string | null,
  commandForEvent: (event: ManagedHookEvent) => string
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS.muse
  const base = {
    provider: 'muse' as const,
    label: spec.label,
    configPath: settingsPathValue
  }
  if (settingsRaw === null) return { ...base, state: 'not-installed', detail: null }
  const settings = parseSettings(settingsRaw)
  if ('error' in settings) return { ...base, state: 'failed', detail: settings.error }
  const pointer = settings.value.managed_hooks_path
  if (pointer === undefined) return { ...base, state: 'not-installed', detail: null }
  if (pointer !== hooksPath) {
    return {
      ...base,
      state: 'partial',
      detail: 'Muse managed_hooks_path points at a different hooks file.'
    }
  }
  const env = stringList(settings.value.managed_hooks_env_vars)
  if (env === null) {
    return { ...base, state: 'failed', detail: 'Muse managed_hooks_env_vars is not a string list.' }
  }
  const missingEnv = MUSE_HOOK_ENV_VARS.filter((name) => !env.includes(name))
  const hooks = parseHooks(hooksRaw)
  if (hooks === null) {
    return { ...base, state: 'partial', detail: 'The Muse managed hooks file is missing.' }
  }
  if ('error' in hooks) return { ...base, state: 'partial', detail: hooks.error }
  const missing: string[] = []
  for (const event of spec.events) {
    const definitions = hooks.hooks[event.providerEvent]
    if (definitions !== undefined && !Array.isArray(definitions)) {
      return {
        ...base,
        state: 'partial',
        detail: `The Muse hook "${event.providerEvent}" is not an array.`
      }
    }
    const current =
      Array.isArray(definitions) &&
      definitions.some((definition) => currentManagedCommand(definition, commandForEvent(event)))
    if (!current) missing.push(event.providerEvent)
  }
  let stale = false
  for (const [eventName, definitions] of Object.entries(hooks.hooks)) {
    if (!Array.isArray(definitions)) continue
    const expected = spec.events.find((event) => event.providerEvent === eventName)
    const current = expected === undefined ? null : commandForEvent(expected)
    for (const definition of definitions) {
      if (!definitionHasManagedCommand(definition)) continue
      const values = isRecord(definition) ? commandValues(definition) : []
      if (current === null || !values.includes(current)) stale = true
    }
  }
  if (missing.length === 0 && missingEnv.length === 0 && !stale) {
    return { ...base, state: 'installed', detail: null }
  }
  const details: string[] = []
  if (missingEnv.length > 0) details.push(`Missing hook env allowlist: ${missingEnv.join(', ')}`)
  if (stale) details.push('Managed hook entries are stale')
  if (missing.length > 0) details.push(`Managed hook missing for: ${missing.join(', ')}`)
  return { ...base, state: 'partial', detail: details.join('; ') }
}

export function localMuseStatus(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const configPath = settingsPath(options)
  const path = hooksFilePath(options.directory)
  let settings: string | null
  let hooks: string | null
  try {
    settings = readTextOrNull(configPath)
    hooks = readTextOrNull(path)
  } catch (error) {
    return {
      provider: 'muse',
      label: MANAGED_HOOK_PROVIDER_SPECS.muse.label,
      state: 'failed',
      configPath,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  return statusFrom(configPath, settings, path, hooks, (event) =>
    runtime.commandFor('muse', event)
  )
}

export function installLocalMuseHooks(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const configPath = settingsPath(options)
  const path = hooksFilePath(options.directory)
  let settings: string | null
  try {
    settings = readTextOrNull(configPath)
  } catch (error) {
    return {
      provider: 'muse',
      label: MANAGED_HOOK_PROVIDER_SPECS.muse.label,
      state: 'failed',
      configPath,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  const applied = applySettings(settings ?? '', path)
  if (applied.error !== null) {
    return {
      provider: 'muse',
      label: MANAGED_HOOK_PROVIDER_SPECS.muse.label,
      state: 'failed',
      configPath,
      detail: applied.error
    }
  }
  // Publish the hooks file before the settings pointer so Muse never loads a
  // missing file after an interrupted install.
  writeTextAtomic(path, buildHooksFile((event) => runtime.commandFor('muse', event)))
  writeTextAtomic(configPath, applied.text)
  return localMuseStatus(options, runtime)
}

export function removeLocalMuseHooks(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const configPath = settingsPath(options)
  const path = hooksFilePath(options.directory)
  let settings: string | null
  try {
    settings = readTextOrNull(configPath)
  } catch (error) {
    return {
      provider: 'muse',
      label: MANAGED_HOOK_PROVIDER_SPECS.muse.label,
      state: 'failed',
      configPath,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  if (settings === null) return localMuseStatus(options, runtime)
  const removed = removeSettings(settings)
  if (removed.error !== null) {
    return {
      provider: 'muse',
      label: MANAGED_HOOK_PROVIDER_SPECS.muse.label,
      state: 'failed',
      configPath,
      detail: removed.error
    }
  }
  // Clear the pointer first so a failed delete cannot leave Muse loading ours.
  if (removed.changed) writeTextAtomic(configPath, removed.text)
  if (existsSync(path)) unlinkSync(path)
  return localMuseStatus(options, runtime)
}

function guestSettingsPath(options: GuestManagedHookOptions): string {
  return managedHookGuestConfigPath('muse', options.guestHome)
}

function guestHooksPath(options: GuestManagedHookOptions): string {
  return `${options.guestHome.replace(/\/+$/u, '')}/.icode/agent-hooks/${MUSE_MANAGED_HOOKS_FILE}`
}

export async function guestMuseStatus(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const configPath = guestSettingsPath(options)
  const path = guestHooksPath(options)
  const settings = await readGuestHookText(options.runner, options.distro, configPath, options.signal)
  const hooks = await readGuestHookText(options.runner, options.distro, path, options.signal)
  return statusFrom(configPath, settings, path, hooks, (event) =>
    guestManagedHookCommand(options, event)
  )
}

export async function installGuestMuseHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const configPath = guestSettingsPath(options)
  const path = guestHooksPath(options)
  const settings = await readGuestHookText(options.runner, options.distro, configPath, options.signal)
  const applied = applySettings(settings ?? '', path)
  if (applied.error !== null) {
    return {
      provider: 'muse',
      label: MANAGED_HOOK_PROVIDER_SPECS.muse.label,
      state: 'failed',
      configPath,
      detail: applied.error
    }
  }
  const hooks = buildHooksFile((event) => guestManagedHookCommand(options, event))
  await writeGuestHookText(options.runner, options.distro, path, hooks, options.signal)
  if (applied.text !== settings) {
    await writeGuestHookText(options.runner, options.distro, configPath, applied.text, options.signal)
  }
  return statusFrom(configPath, applied.text, path, hooks, (event) =>
    guestManagedHookCommand(options, event)
  )
}

export async function removeGuestMuseHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const configPath = guestSettingsPath(options)
  const path = guestHooksPath(options)
  const settings = await readGuestHookText(options.runner, options.distro, configPath, options.signal)
  if (settings === null) return guestMuseStatus(options)
  const removed = removeSettings(settings)
  if (removed.error !== null) {
    return {
      provider: 'muse',
      label: MANAGED_HOOK_PROVIDER_SPECS.muse.label,
      state: 'failed',
      configPath,
      detail: removed.error
    }
  }
  if (removed.changed) {
    await writeGuestHookText(options.runner, options.distro, configPath, removed.text, options.signal)
  }
  await removeGuestHookFile(options.runner, options.distro, path, options.signal)
  return statusFrom(configPath, removed.text, path, null, (event) =>
    guestManagedHookCommand(options, event)
  )
}

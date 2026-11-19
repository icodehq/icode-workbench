/**
 * Kimi uses a Claude-compatible hook vocabulary but stores it in TOML.
 *
 * iCode owns one marker-delimited block; everything outside the block is
 * preserved byte-for-byte. The block is removed and rewritten on install so
 * upgrades converge without accumulating duplicate `[[hooks]]` tables.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  MANAGED_HOOK_PROVIDER_SPECS,
  configPathFor,
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

const START_MARKER = '# >>> icode-managed-kimi-hooks (managed by iCode; do not edit) >>>'
const END_MARKER = '# <<< icode-managed-kimi-hooks <<<'
const BACKUP_SUFFIX = '.icode.bak'

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`
}

function eolFor(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function buildBlock(
  commandFor: (event: ManagedHookEvent) => string,
  eol: string
): string {
  const spec = MANAGED_HOOK_PROVIDER_SPECS.kimi
  const tables = spec.events.map((event) =>
    [
      '[[hooks]]',
      `event = ${tomlString(event.providerEvent)}`,
      ...(event.providerEvent === 'SessionStart' ? ['matcher = "^resume$"'] : []),
      `command = ${tomlString(commandFor(event))}`,
      `timeout = ${spec.timeoutSeconds}`
    ].join(eol)
  )
  return [START_MARKER, ...tables, END_MARKER].join(eol)
}

function stripBlocks(text: string): {
  text: string
  changed: boolean
  unbalanced: boolean
} {
  const eol = eolFor(text)
  const lines = text.split(/\r?\n/u)
  const out: string[] = []
  let changed = false
  let index = 0
  while (index < lines.length) {
    if (lines[index]?.trim() !== START_MARKER) {
      out.push(lines[index] ?? '')
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length && lines[end]?.trim() !== END_MARKER) end += 1
    // An unmatched start marker is user data, not an invitation to delete the
    // rest of the file. Fail closed and leave the config untouched.
    if (end >= lines.length) return { text, changed: false, unbalanced: true }
    changed = true
    index = end + 1
  }
  return { text: out.join(eol), changed, unbalanced: false }
}

export function applyKimiHooks(
  text: string,
  commandFor: (event: ManagedHookEvent) => string
): string {
  const parsed = stripBlocks(text)
  if (parsed.unbalanced) return text
  const eol = eolFor(text)
  const stripped = parsed.text.replace(/\s+$/u, '')
  const block = buildBlock(commandFor, eol)
  return stripped.length > 0 ? `${stripped}${eol}${eol}${block}${eol}` : `${block}${eol}`
}

export function removeKimiHooks(text: string): { text: string; changed: boolean } {
  const stripped = stripBlocks(text)
  if (!stripped.changed) return { text, changed: false }
  const eol = eolFor(text)
  const trimmed = stripped.text.replace(/\s+$/u, '')
  return { text: trimmed.length > 0 ? `${trimmed}${eol}` : '', changed: true }
}

export function readKimiManagedEvents(text: string): Set<string> {
  const events = new Set<string>()
  const lines = text.split(/\r?\n/u)
  let index = 0
  while (index < lines.length) {
    if (lines[index]?.trim() !== START_MARKER) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length && lines[end]?.trim() !== END_MARKER) end += 1
    if (end >= lines.length) break
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const match = /^\s*event\s*=\s*"([^"]+)"/u.exec(lines[cursor] ?? '')
      if (match?.[1] !== undefined) events.add(match[1])
    }
    index = end + 1
  }
  return events
}

function statusFromText(
  provider: ManagedHookProvider,
  configPath: string,
  text: string | null
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  if (text === null) {
    return {
      provider,
      label: spec.label,
      state: 'not-installed',
      configPath,
      detail: null
    }
  }
  if (text.trim().length === 0) {
    return {
      provider,
      label: spec.label,
      state: 'not-installed',
      configPath,
      detail: null
    }
  }
  const present = readKimiManagedEvents(text)
  const missing = spec.events.filter((event) => !present.has(event.providerEvent))
  if (missing.length === 0) {
    return { provider, label: spec.label, state: 'installed', configPath, detail: null }
  }
  return {
    provider,
    label: spec.label,
    state: present.size === 0 ? 'not-installed' : 'partial',
    configPath,
    detail:
      present.size === 0
        ? null
        : `Managed hook missing for: ${missing.map((event) => event.providerEvent).join(', ')}`
  }
}

function writeText(path: string, text: string): void {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf8') === text) return
    } catch {
      // Fall through to the atomic write.
    }
  }
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
  const temporary = `${path}.icode-tmp-${String(process.pid)}-${String(
    Math.random()
  ).slice(2)}`
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode, flag: 'wx' })
    if (process.platform !== 'win32') chmodSync(temporary, mode)
    if (existsSync(path)) {
      try {
        copyFileSync(path, `${path}${BACKUP_SUFFIX}`)
      } catch {
        // Best effort.
      }
    }
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary)
      } catch {
        // best effort
      }
    }
  }
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function localKimiStatus(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const path = configPathFor(provider, options)
  return statusFromText(provider, path, readText(path))
}

export function installLocalKimiHooks(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS[provider]
  const path = configPathFor(provider, options)
  const text = readText(path)
  if (text === null && existsSync(path)) {
    return {
      provider,
      label: spec.label,
      state: 'failed',
      configPath: path,
      detail: 'The Kimi config could not be read.'
    }
  }
  const next = applyKimiHooks(text ?? '', (event) => runtime.commandFor(provider, event))
  writeText(path, next)
  return statusFromText(provider, path, next)
}

export function removeLocalKimiHooks(
  provider: ManagedHookProvider,
  options: ManagedHookInstallOptions
): ManagedHookProviderStatus {
  const path = configPathFor(provider, options)
  const text = readText(path)
  if (text === null) return statusFromText(provider, path, null)
  const removed = removeKimiHooks(text)
  if (removed.changed) writeText(path, removed.text)
  return statusFromText(provider, path, removed.text)
}

function guestPaths(options: GuestManagedHookOptions): string {
  return managedHookGuestConfigPath('kimi', options.guestHome)
}

function guestCommandFor(
  options: GuestManagedHookOptions,
  event: ManagedHookEvent
): string {
  return guestManagedHookCommand(options, event)
}

export async function guestKimiStatus(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPaths(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  return statusFromText(options.provider, path, text)
}

export async function installGuestKimiHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPaths(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  const next = applyKimiHooks(text ?? '', (event) => guestCommandFor(options, event))
  if (next !== text) {
    await writeGuestHookText(options.runner, options.distro, path, next, options.signal)
  }
  return statusFromText(options.provider, path, next)
}

export async function removeGuestKimiHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPaths(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  if (text === null) return statusFromText(options.provider, path, null)
  const removed = removeKimiHooks(text)
  if (removed.changed) {
    await writeGuestHookText(
      options.runner,
      options.distro,
      path,
      removed.text,
      options.signal
    )
  }
  return statusFromText(options.provider, path, removed.text)
}

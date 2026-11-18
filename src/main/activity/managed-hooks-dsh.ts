/**
 * DeepSeek Harness (DSH) reads hooks through the
 * `@deepseek-ai/dsh-hooks-claude-code` executor named by a YAML patch layer.
 *
 * iCode owns a marker-delimited `- insert:` row in `$DSH_HOME/cordis.patch.yml`
 * and a separate JSON hooks file. The YAML is edited as text: DSH patch layers
 * are user-owned and a full parse/serialize round trip would discard comments
 * and layout. A nonempty flow-style sequence is refused because block entries
 * cannot be appended to it safely.
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  MANAGED_HOOK_PROVIDER_SPECS,
  commandValues,
  currentManagedCommand,
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
import {
  eolFor,
  readTextOrNull,
  stripMarkerBlock,
  writeTextAtomic
} from './managed-hooks-text'

export const DSH_HOOKS_FILE = 'dsh-hooks.json'
const START_MARKER = '# >>> icode-managed-dsh-hooks (managed by iCode; do not edit) >>>'
const END_MARKER = '# <<< icode-managed-dsh-hooks <<<'
const MANAGED_ROW_ID = 'icode-agent-hooks'
const EXECUTOR_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code'
const HOOK_PROTOCOL_PACKAGE = '@deepseek-ai/dsh-hook-protocol'

function quoteYaml(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function managedBlock(path: string): string[] {
  return [
    START_MARKER,
    '- insert:',
    `    - id: ${MANAGED_ROW_ID}`,
    `      name: '${EXECUTOR_PACKAGE}'`,
    '      config:',
    `        configPath: ${quoteYaml(path)}`,
    END_MARKER
  ]
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

function isComment(line: string): boolean {
  return line.trim().startsWith('#')
}

function bodyLines(lines: readonly string[]): readonly string[] {
  return lines.filter((line) => !isBlank(line) && !isComment(line))
}

function withoutTrailingComment(line: string): string {
  const hash = line.indexOf('#')
  return (hash === -1 ? line : line.slice(0, hash)).trim()
}

function isEmptyFlowDocument(lines: readonly string[]): boolean {
  const body = bodyLines(lines)
  return body.length === 1 && withoutTrailingComment(body[0] ?? '') === '[]'
}

function isUnappendable(text: string): boolean {
  const lines = text.split(/\r?\n/u)
  const body = bodyLines(lines)
  return body.length > 0 && body[0]!.trimStart().startsWith('[') && !isEmptyFlowDocument(lines)
}

function trimTrailingBlank(lines: readonly string[]): string[] {
  let end = lines.length - 1
  while (end >= 0 && isBlank(lines[end] ?? '')) end -= 1
  return lines.slice(0, end + 1)
}

function joinWithEol(lines: readonly string[], eol: string): string {
  const text = lines.join(eol)
  return text.length === 0 ? text : `${text}${eol}`
}

function findMarkerRegion(lines: readonly string[]): { start: number; end: number } | null {
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim()
    if (trimmed === START_MARKER) start = index
    else if (trimmed === END_MARKER && start !== -1) return { start, end: index }
  }
  return null
}

export function applyDshPatch(
  text: string,
  managedHooksPath: string
): { text: string; error: string | null } {
  const eol = eolFor(text)
  const lines = text.split(/\r?\n/u)
  const block = managedBlock(managedHooksPath)
  // Replace an existing row where it sits so patch order and any following
  // YAML document stay intact.
  const region = findMarkerRegion(lines)
  if (region !== null) {
    return {
      text: joinWithEol(
        [...lines.slice(0, region.start), ...block, ...lines.slice(region.end + 1)],
        eol
      ),
      error: null
    }
  }
  const stripped = stripMarkerBlock(text, START_MARKER, END_MARKER)
  if (stripped.unbalanced) {
    return { text, error: 'The DSH managed hook markers are unbalanced.' }
  }
  if (isUnappendable(stripped.text)) {
    return {
      text,
      error:
        'The DSH home patch is flow-style; rewrite it as a block sequence so iCode can add its hooks.'
    }
  }
  const kept = isEmptyFlowDocument(lines)
    ? lines.map((line) =>
        withoutTrailingComment(line) === '[]'
          ? line.slice(line.indexOf('[]') + 2)
          : line
      )
    : lines
  const base = trimTrailingBlank(kept)
  const next =
    base.length === 0 || base.every((line) => isBlank(line))
      ? joinWithEol(block, eol)
      : joinWithEol([...base, '', ...block], eol)
  return { text: next, error: null }
}

export function removeDshPatch(text: string): { text: string; changed: boolean } {
  const stripped = stripMarkerBlock(text, START_MARKER, END_MARKER)
  if (!stripped.changed) return { text, changed: false }
  const eol = eolFor(text)
  const lines = trimTrailingBlank(stripped.text.split(/\r?\n/u))
  const body = lines.every((line) => isBlank(line) || isComment(line))
    ? [...lines, '[]']
    : lines
  return { text: joinWithEol(body, eol), changed: true }
}

export function readDshConfigPath(text: string): string | undefined {
  const lines = text.split(/\r?\n/u)
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === START_MARKER) {
      inBlock = true
      continue
    }
    if (trimmed === END_MARKER) {
      inBlock = false
      continue
    }
    if (!inBlock) continue
    const match = /^\s*configPath:\s*(.+?)\s*$/u.exec(line)
    if (match) return unquoteYaml(match[1] ?? '')
  }
  return undefined
}

function dshHome(configPath: string): string {
  return dirname(configPath)
}

/** Null when every DSH profile can load the executor, or when none exists yet. */
function profilesMissingPackages(home: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(join(home, 'profiles'))
  } catch {
    return null
  }
  const broken = entries
    .map((entry) => join(home, 'profiles', entry))
    .filter((profile) => existsSync(join(profile, 'package.json')))
    .filter(
      (profile) =>
        !existsSync(join(profile, 'node_modules', EXECUTOR_PACKAGE, 'package.json')) ||
        !existsSync(join(profile, 'node_modules', HOOK_PROTOCOL_PACKAGE, 'package.json'))
    )
  if (broken.length === 0) return null
  return `DSH profiles cannot load the hook executor: ${broken.join(', ')}. Add ${EXECUTOR_PACKAGE}@<dsh version> and ${HOOK_PROTOCOL_PACKAGE}@<dsh version> in each profile.`
}

function buildHooksFile(commandForEvent: (event: ManagedHookEvent) => string): string {
  const spec = MANAGED_HOOK_PROVIDER_SPECS.dsh
  const hooks: Record<string, unknown> = {}
  for (const event of spec.events) {
    hooks[event.providerEvent] = [
      {
        hooks: [
          {
            type: 'command',
            command: commandForEvent(event),
            timeout: spec.timeoutSeconds
          }
        ]
      }
    ]
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

type ParsedHooks = { hooks: Record<string, unknown> } | { error: string } | null

function parseHooks(text: string | null): ParsedHooks {
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
      return { error: 'The DSH managed hooks file is not a hooks object.' }
    }
    return { hooks: parsed.hooks }
  } catch {
    return { error: 'The DSH managed hooks file is not valid JSON.' }
  }
}

function statusFrom(
  patchPath: string,
  patchText: string | null,
  hooksPath: string,
  hooksText: string | null,
  commandForEvent: (event: ManagedHookEvent) => string
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS.dsh
  const base = { provider: 'dsh' as const, label: spec.label, configPath: patchPath }
  if (patchText === null) return { ...base, state: 'not-installed', detail: null }
  if (isUnappendable(patchText)) {
    return {
      ...base,
      state: 'failed',
      detail:
        'The DSH home patch is flow-style; rewrite it as a block sequence so iCode can add its hooks.'
    }
  }
  const pointer = readDshConfigPath(patchText)
  if (pointer === undefined) return { ...base, state: 'not-installed', detail: null }
  if (pointer !== hooksPath) {
    return {
      ...base,
      state: 'partial',
      detail: 'The DSH patch row points at a different hooks file.'
    }
  }
  const hooks = parseHooks(hooksText)
  if (hooks === null) {
    return { ...base, state: 'partial', detail: 'The DSH managed hooks file is missing.' }
  }
  if ('error' in hooks) return { ...base, state: 'partial', detail: hooks.error }
  const missing: string[] = []
  let present = 0
  for (const event of spec.events) {
    const definitions = hooks.hooks[event.providerEvent]
    if (definitions !== undefined && !Array.isArray(definitions)) {
      return {
        ...base,
        state: 'partial',
        detail: `The DSH hook "${event.providerEvent}" is not an array.`
      }
    }
    const current =
      Array.isArray(definitions) &&
      definitions.some((definition) => currentManagedCommand(definition, commandForEvent(event)))
    if (current) present += 1
    else missing.push(event.providerEvent)
  }
  let stale = false
  for (const [eventName, definitions] of Object.entries(hooks.hooks)) {
    if (!Array.isArray(definitions)) continue
    const expected = spec.events.find((event) => event.providerEvent === eventName)
    const current = expected === undefined ? null : commandForEvent(expected)
    for (const definition of definitions) {
      if (!isRecord(definition)) continue
      for (const command of commandValues(definition)) {
        if (!isManagedHookCommand(command)) continue
        if (current === null || command !== current) stale = true
      }
    }
  }
  const packageDetail = profilesMissingPackages(dshHome(patchPath))
  if (packageDetail !== null) {
    return { ...base, state: 'partial', detail: packageDetail }
  }
  if (stale) return { ...base, state: 'partial', detail: 'Managed hook entries are stale.' }
  if (missing.length === 0) return { ...base, state: 'installed', detail: null }
  return {
    ...base,
    state: present === 0 ? 'not-installed' : 'partial',
    detail: present === 0 ? null : `Managed hook missing for: ${missing.join(', ')}`
  }
}

function localHooksPath(options: ManagedHookInstallOptions): string {
  return join(options.directory, DSH_HOOKS_FILE)
}

export function localDshStatus(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const patchPath = MANAGED_HOOK_PROVIDER_SPECS.dsh.configPath(
    options.home,
    options.env ?? process.env
  )
  const hooksPath = localHooksPath(options)
  try {
    return statusFrom(
      patchPath,
      readTextOrNull(patchPath),
      hooksPath,
      readTextOrNull(hooksPath),
      (event) => runtime.commandFor('dsh', event)
    )
  } catch (error) {
    return {
      provider: 'dsh',
      label: MANAGED_HOOK_PROVIDER_SPECS.dsh.label,
      state: 'failed',
      configPath: patchPath,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export function installLocalDshHooks(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const patchPath = MANAGED_HOOK_PROVIDER_SPECS.dsh.configPath(
    options.home,
    options.env ?? process.env
  )
  const hooksPath = localHooksPath(options)
  let patchText: string | null
  try {
    patchText = readTextOrNull(patchPath)
  } catch (error) {
    return {
      provider: 'dsh',
      label: MANAGED_HOOK_PROVIDER_SPECS.dsh.label,
      state: 'failed',
      configPath: patchPath,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  const applied = applyDshPatch(patchText ?? '', hooksPath)
  if (applied.error !== null) {
    return {
      provider: 'dsh',
      label: MANAGED_HOOK_PROVIDER_SPECS.dsh.label,
      state: 'failed',
      configPath: patchPath,
      detail: applied.error
    }
  }
  // Publish the hooks file before the patch row references it.
  writeTextAtomic(hooksPath, buildHooksFile((event) => runtime.commandFor('dsh', event)))
  writeTextAtomic(patchPath, applied.text)
  return localDshStatus(options, runtime)
}

export function removeLocalDshHooks(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const patchPath = MANAGED_HOOK_PROVIDER_SPECS.dsh.configPath(
    options.home,
    options.env ?? process.env
  )
  const hooksPath = localHooksPath(options)
  let patchText: string | null
  try {
    patchText = readTextOrNull(patchPath)
  } catch (error) {
    return {
      provider: 'dsh',
      label: MANAGED_HOOK_PROVIDER_SPECS.dsh.label,
      state: 'failed',
      configPath: patchPath,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  if (patchText !== null) {
    const removed = removeDshPatch(patchText)
    if (removed.changed) writeTextAtomic(patchPath, removed.text)
  }
  if (existsSync(hooksPath)) unlinkSync(hooksPath)
  return localDshStatus(options, runtime)
}

function guestPaths(options: GuestManagedHookOptions): { patch: string; hooks: string } {
  const home = options.guestHome.replace(/\/+$/u, '')
  return {
    patch: `${home}/.dsh/cordis.patch.yml`,
    hooks: `${home}/.icode/agent-hooks/${DSH_HOOKS_FILE}`
  }
}

export async function guestDshStatus(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const paths = guestPaths(options)
  const patch = await readGuestHookText(options.runner, options.distro, paths.patch, options.signal)
  const hooks = await readGuestHookText(options.runner, options.distro, paths.hooks, options.signal)
  return statusFrom(paths.patch, patch, paths.hooks, hooks, (event) =>
    guestManagedHookCommand(options, event)
  )
}

export async function installGuestDshHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const paths = guestPaths(options)
  const patch = await readGuestHookText(options.runner, options.distro, paths.patch, options.signal)
  const applied = applyDshPatch(patch ?? '', paths.hooks)
  if (applied.error !== null) {
    return {
      provider: 'dsh',
      label: MANAGED_HOOK_PROVIDER_SPECS.dsh.label,
      state: 'failed',
      configPath: paths.patch,
      detail: applied.error
    }
  }
  const hooks = buildHooksFile((event) => guestManagedHookCommand(options, event))
  await writeGuestHookText(options.runner, options.distro, paths.hooks, hooks, options.signal)
  if (applied.text !== patch) {
    await writeGuestHookText(options.runner, options.distro, paths.patch, applied.text, options.signal)
  }
  return statusFrom(paths.patch, applied.text, paths.hooks, hooks, (event) =>
    guestManagedHookCommand(options, event)
  )
}

export async function removeGuestDshHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const paths = guestPaths(options)
  const patch = await readGuestHookText(options.runner, options.distro, paths.patch, options.signal)
  let nextPatch = patch
  if (patch !== null) {
    const removed = removeDshPatch(patch)
    if (removed.changed) {
      nextPatch = removed.text
      await writeGuestHookText(
        options.runner,
        options.distro,
        paths.patch,
        removed.text,
        options.signal
      )
    }
  }
  await removeGuestHookFile(options.runner, options.distro, paths.hooks, options.signal)
  return statusFrom(paths.patch, nextPatch, paths.hooks, null, (event) =>
    guestManagedHookCommand(options, event)
  )
}

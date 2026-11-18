/**
 * JCode stores hooks as a `[hooks]` TOML table whose values are a command
 * string or an array of command strings.
 *
 * iCode appends its command after user gates (JCode runs every command in
 * order) and inserts missing event keys directly after the `[hooks]` header.
 * Edits are byte-preserving outside the arrays iCode owns; one managed command
 * per event is kept so an upgrade repairs a stale path instead of duplicating.
 */

import {
  MANAGED_HOOK_PROVIDER_SPECS,
  isManagedHookCommand,
  type ManagedHookEvent,
  type ManagedHookInstallOptions,
  type ManagedHookProviderStatus,
  type ManagedHookRuntime
} from './managed-hooks'
import {
  removeGuestHookFile,
  readGuestHookText,
  writeGuestHookText,
  type GuestManagedHookOptions
} from './managed-hooks-guest'
import { eolFor, readTextOrNull, writeTextAtomic } from './managed-hooks-text'

type Assignment = {
  key: string
  lineStart: number
  valueStart: number
  valueEnd: number
}

type HookArrayElement = {
  start: number
  end: number
  value: string
}

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`
}

function skipSpace(text: string, offset: number): number {
  let index = offset
  while (text[index] === ' ' || text[index] === '\t' || text[index] === '\r') index += 1
  return index
}

function skipTrivia(text: string, offset: number): number {
  let index = offset
  while (index < text.length) {
    const char = text[index]
    if (char === '#') {
      const newline = text.indexOf('\n', index)
      index = newline === -1 ? text.length : newline
    } else if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      index += 1
    } else {
      break
    }
  }
  return index
}

function parseString(text: string, offset: number): { value: string; end: number } | null {
  const quote = text[offset]
  if (quote !== '"' && quote !== "'") return null
  let index = offset + 1
  let value = ''
  while (index < text.length) {
    const char = text[index]
    if (char === quote) {
      if (quote === "'") return { value, end: index + 1 }
      if (text[index + 1] === quote) {
        value += quote
        index += 2
        continue
      }
      return { value, end: index + 1 }
    }
    if (quote === '"' && char === '\\') {
      const next = text[index + 1]
      if (next === undefined) return null
      const escapes: Record<string, string> = {
        b: '\b',
        t: '\t',
        n: '\n',
        f: '\f',
        r: '\r',
        '"': '"',
        '\\': '\\'
      }
      if (next === 'u' || next === 'U') {
        const length = next === 'u' ? 4 : 8
        const hex = text.slice(index + 2, index + 2 + length)
        if (!/^[0-9a-fA-F]+$/u.test(hex) || hex.length !== length) return null
        value += String.fromCodePoint(Number.parseInt(hex, 16))
        index += 2 + length
        continue
      }
      value += escapes[next] ?? next
      index += 2
      continue
    }
    value += char
    index += 1
  }
  return null
}

function arrayEnd(text: string, valueStart: number): number | null {
  if (text[valueStart] !== '[') return null
  let index = valueStart + 1
  let depth = 1
  while (index < text.length) {
    const char = text[index]
    if (char === '"' || char === "'") {
      const parsed = parseString(text, index)
      if (parsed === null) return null
      index = parsed.end
      continue
    }
    if (char === '#') {
      const newline = text.indexOf('\n', index)
      index = newline === -1 ? text.length : newline
      continue
    }
    if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return null
}

function valueEnd(text: string, valueStart: number): number | null {
  const first = skipSpace(text, valueStart)
  if (text[first] === '[') return arrayEnd(text, first)
  if (text[first] === '"' || text[first] === "'") return parseString(text, first)?.end ?? null
  const newline = text.indexOf('\n', first)
  return newline === -1 ? text.length : newline
}

function isHooksHeader(line: string): boolean {
  return /^\s*\[\s*hooks\s*\]\s*(?:#.*)?$/u.test(line)
}

function isTableHeader(line: string): boolean {
  return /^\s*\[\[?.*\]\]?\s*(?:#.*)?$/u.test(line)
}

/** Assignments inside `[hooks]`; `null` when the table itself is malformed. */
function scanHooks(
  text: string
): { assignments: Assignment[]; headerEnd: number | null; sectionEnd: number } {
  const assignments: Assignment[] = []
  let headerEnd: number | null = null
  let sectionEnd = text.length
  let inHooks = false
  let lineStart = 0
  let skipUntil = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/u, '')
    const lineEnd = lineStart + line.length
    if (lineStart < skipUntil) {
      lineStart += rawLine.length + 1
      continue
    }
    if (!inHooks) {
      if (isHooksHeader(line)) {
        inHooks = true
        headerEnd = lineEnd
      }
      lineStart += rawLine.length + 1
      continue
    }
    if (isTableHeader(line)) {
      sectionEnd = lineStart
      break
    }
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(line)
    if (match !== null && !line.trimStart().startsWith('#')) {
      const valueStart = lineStart + line.indexOf('=', match[1]?.length ?? 0) + 1
      const end = valueEnd(text, valueStart)
      if (end === null) return { assignments, headerEnd, sectionEnd }
      assignments.push({ key: match[1] ?? '', lineStart, valueStart, valueEnd: end })
      skipUntil = Math.max(lineEnd, end)
    }
    lineStart += rawLine.length + 1
  }
  return { assignments, headerEnd, sectionEnd }
}

function scanArray(text: string, valueStart: number): HookArrayElement[] | null {
  let index = valueStart
  while (text[index] === ' ' || text[index] === '\t') index += 1
  if (text[index] !== '[') return null
  index += 1
  const elements: HookArrayElement[] = []
  index = skipTrivia(text, index)
  while (index < text.length && text[index] !== ']') {
    const parsed = parseString(text, index)
    if (parsed === null) return null
    elements.push({ start: index, end: parsed.end, value: parsed.value })
    index = skipTrivia(text, parsed.end)
    if (text[index] === ',') {
      index = skipTrivia(text, index + 1)
    } else if (text[index] !== ']') {
      return null
    }
  }
  return text[index] === ']' ? elements : null
}

function assignmentValue(
  text: string,
  assignment: Assignment
): { kind: 'array'; elements: HookArrayElement[] } | { kind: 'string'; value: string } | null {
  const start = skipSpace(text, assignment.valueStart)
  if (text[start] === '[') {
    const elements = scanArray(text, start)
    return elements === null ? null : { kind: 'array', elements }
  }
  const parsed = parseString(text, start)
  return parsed === null ? null : { kind: 'string', value: parsed.value }
}

function spliceMany(text: string, edits: Array<{ start: number; end: number }>): string {
  let result = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, edit.start)}${result.slice(edit.end)}`
  }
  return result
}

/**
 * Removes the managed command from every hooks assignment. An array that only
 * carried iCode's command has its whole assignment line removed; a user array
 * keeps its other commands and formatting.
 */
export function removeJcodeHooks(text: string): { text: string; changed: boolean } {
  const scan = scanHooks(text)
  const edits: Array<{ start: number; end: number }> = []
  for (const assignment of scan.assignments) {
    const value = assignmentValue(text, assignment)
    if (value === null) continue
    if (value.kind === 'string') {
      if (isManagedHookCommand(value.value)) {
        const newline = text.indexOf('\n', assignment.valueEnd)
        edits.push({
          start: assignment.lineStart,
          end: newline === -1 ? text.length : newline + 1
        })
      }
      continue
    }
    const managed = value.elements.filter((element) => isManagedHookCommand(element.value))
    if (managed.length === 0) continue
    if (managed.length === value.elements.length) {
      const newline = text.indexOf('\n', assignment.valueEnd)
      edits.push({
        start: assignment.lineStart,
        end: newline === -1 ? text.length : newline + 1
      })
      continue
    }
    for (const element of managed) {
      let end = skipSpace(text, element.end)
      if (text[end] === ',') {
        end = skipSpace(text, end + 1)
      } else {
        const comma = text.lastIndexOf(',', element.start - 1)
        if (comma !== -1 && comma >= assignment.valueStart) {
          edits.push({ start: comma, end: element.end })
          continue
        }
      }
      edits.push({ start: element.start, end })
    }
  }
  const next = spliceMany(text, edits)
  return { text: next, changed: next !== text }
}

function hasManagedElement(text: string, assignment: Assignment): boolean {
  const value = assignmentValue(text, assignment)
  if (value === null) return false
  if (value.kind === 'string') return isManagedHookCommand(value.value)
  return value.elements.some((element) => isManagedHookCommand(element.value))
}

/** Appends or repairs one event key; returns the new text. */
function applyEvent(
  text: string,
  assignment: Assignment,
  command: string
): { text: string; userOwned: boolean } {
  const value = assignmentValue(text, assignment)
  if (value === null) return { text, userOwned: true }
  if (value.kind === 'string') {
    if (!isManagedHookCommand(value.value)) return { text, userOwned: true }
    const next = `${text.slice(0, assignment.valueStart)}${tomlString(command)}${text.slice(assignment.valueEnd)}`
    return { text: next, userOwned: false }
  }
  if (value.elements.some((element) => element.value === command)) {
    return { text, userOwned: false }
  }
  const stale = value.elements.find((element) => isManagedHookCommand(element.value))
  if (stale !== undefined) {
    return {
      text: `${text.slice(0, stale.start)}${tomlString(command)}${text.slice(stale.end)}`,
      userOwned: false
    }
  }
  const close = assignment.valueEnd - 1
  if (value.elements.length === 0) {
    const open = text.indexOf('[', assignment.valueStart)
    if (open === -1 || open > close) return { text, userOwned: true }
    const next = `${text.slice(0, open)}[${tomlString(command)}]${text.slice(close + 1)}`
    return { text: next, userOwned: false }
  }
  const prefix = close > 0 && text[close - 1] === ',' ? ' ' : ', '
  return {
    text: `${text.slice(0, close)}${prefix}${tomlString(command)}${text.slice(close)}`,
    userOwned: false
  }
}

export function applyJcodeHooks(
  source: string,
  commandForEvent: (event: ManagedHookEvent) => string
): { text: string; userOwned: readonly string[] } {
  const spec = MANAGED_HOOK_PROVIDER_SPECS.jcode
  const removed = removeJcodeHooks(source)
  let text = removed.text
  const userOwned: string[] = []
  const missing: ManagedHookEvent[] = []
  for (const event of spec.events) {
    // Each edit changes byte offsets, so locate the assignment again.
    const scan = scanHooks(text)
    const assignment = scan.assignments.find((entry) => entry.key === event.providerEvent)
    if (assignment === undefined) {
      missing.push(event)
      continue
    }
    const applied = applyEvent(text, assignment, commandForEvent(event))
    text = applied.text
    if (applied.userOwned) userOwned.push(event.providerEvent)
  }
  if (missing.length > 0) {
    const eol = eolFor(text)
    const lines = missing
      .map((event) => `${event.providerEvent} = [${tomlString(commandForEvent(event))}]`)
      .join(eol)
    const rescan = scanHooks(text)
    if (rescan.headerEnd !== null) {
      text = `${text.slice(0, rescan.headerEnd)}${eol}${lines}${text.slice(rescan.headerEnd)}`
    } else {
      const stripped = text.replace(/\s+$/u, '')
      text = `${stripped.length > 0 ? `${stripped}${eol}${eol}` : ''}[hooks]${eol}${lines}${eol}`
    }
  }
  return { text, userOwned }
}

function statusFrom(
  configPath: string,
  text: string | null,
  commandForEvent: (event: ManagedHookEvent) => string
): ManagedHookProviderStatus {
  const spec = MANAGED_HOOK_PROVIDER_SPECS.jcode
  const base = { provider: 'jcode' as const, label: spec.label, configPath }
  if (text === null) return { ...base, state: 'not-installed', detail: null }
  const scan = scanHooks(text)
  const byKey = new Map(scan.assignments.map((assignment) => [assignment.key, assignment]))
  const missing: string[] = []
  const userOwned: string[] = []
  let present = 0
  for (const event of spec.events) {
    const assignment = byKey.get(event.providerEvent)
    if (assignment === undefined) {
      missing.push(event.providerEvent)
      continue
    }
    const value = assignmentValue(text, assignment)
    const command = commandForEvent(event)
    if (value === null) {
      userOwned.push(event.providerEvent)
      continue
    }
    if (value.kind === 'string') {
      if (value.value === command) present += 1
      else if (isManagedHookCommand(value.value)) missing.push(event.providerEvent)
      else userOwned.push(event.providerEvent)
      continue
    }
    if (value.elements.some((element) => element.value === command)) present += 1
    else {
      // An array without our command can take one, so it is missing rather
      // than user-owned; only a scalar assignment blocks installation.
      missing.push(event.providerEvent)
    }
  }
  let stale = false
  for (const assignment of scan.assignments) {
    if (!hasManagedElement(text, assignment)) continue
    const expected = spec.events.find((event) => event.providerEvent === assignment.key)
    if (expected === undefined) {
      stale = true
      continue
    }
    const value = assignmentValue(text, assignment)
    const command = commandForEvent(expected)
    if (value === null) stale = true
    else if (value.kind === 'string') stale ||= value.value !== command
    else stale ||= !value.elements.some((element) => element.value === command)
  }
  if (missing.length === 0 && userOwned.length === 0 && !stale) {
    return { ...base, state: 'installed', detail: null }
  }
  const details: string[] = []
  if (stale) details.push('Managed hook entries are stale')
  if (missing.length > 0) details.push(`Managed hook missing for: ${missing.join(', ')}`)
  if (userOwned.length > 0) details.push(`User-owned hooks kept for: ${userOwned.join(', ')}`)
  return {
    ...base,
    state: present === 0 && userOwned.length === 0 ? 'not-installed' : 'partial',
    detail: details.join('; ')
  }
}

function configPath(options: ManagedHookInstallOptions): string {
  return MANAGED_HOOK_PROVIDER_SPECS.jcode.configPath(options.home, options.env ?? process.env)
}

export function localJcodeStatus(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const path = configPath(options)
  try {
    return statusFrom(path, readTextOrNull(path), (event) =>
      runtime.commandFor('jcode', event)
    )
  } catch (error) {
    return {
      provider: 'jcode',
      label: MANAGED_HOOK_PROVIDER_SPECS.jcode.label,
      state: 'failed',
      configPath: path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export function installLocalJcodeHooks(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const path = configPath(options)
  let text: string | null
  try {
    text = readTextOrNull(path)
  } catch (error) {
    return {
      provider: 'jcode',
      label: MANAGED_HOOK_PROVIDER_SPECS.jcode.label,
      state: 'failed',
      configPath: path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  const applied = applyJcodeHooks(text ?? '', (event) => runtime.commandFor('jcode', event))
  writeTextAtomic(path, applied.text)
  return statusFrom(path, applied.text, (event) => runtime.commandFor('jcode', event))
}

export function removeLocalJcodeHooks(
  options: ManagedHookInstallOptions,
  runtime: ManagedHookRuntime
): ManagedHookProviderStatus {
  const path = configPath(options)
  let text: string | null
  try {
    text = readTextOrNull(path)
  } catch (error) {
    return {
      provider: 'jcode',
      label: MANAGED_HOOK_PROVIDER_SPECS.jcode.label,
      state: 'failed',
      configPath: path,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  if (text === null) {
    return statusFrom(path, null, (event) => runtime.commandFor('jcode', event))
  }
  const removed = removeJcodeHooks(text)
  if (removed.changed) writeTextAtomic(path, removed.text)
  return statusFrom(path, removed.text, (event) => runtime.commandFor('jcode', event))
}

function guestPath(options: GuestManagedHookOptions): string {
  return `${options.guestHome.replace(/\/+$/u, '')}/.jcode/config.toml`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function guestWrapperPath(options: GuestManagedHookOptions, event: ManagedHookEvent): string {
  // Keep the shared managed-command marker in the filename so removal can
  // recognize the wrapper from the TOML command alone.
  return `${options.guestHome.replace(/\/+$/u, '')}/.icode/agent-hooks/icode-managed-hook-jcode-${event.providerEvent}.sh`
}

/**
 * JCode supplies the payload in `JCODE_HOOK_PAYLOAD`, not on stdin, and that
 * variable cannot cross WSL interop safely (large tool inputs). The wrapper
 * pipes it to the Windows hook instead.
 */
function guestWrapperSource(
  options: GuestManagedHookOptions,
  event: ManagedHookEvent
): string {
  const crossed = [
    'ICODE_ACTIVITY_SOCKET',
    'ICODE_SESSION_ID',
    'ICODE_SESSION_INCARNATION',
    ...(options.electronRunAsNode ? ['ELECTRON_RUN_AS_NODE'] : [])
  ]
  const env = [
    `WSLENV=${shellQuote(crossed.join(':'))}`,
    `ICODE_ACTIVITY_SOCKET=${shellQuote(options.activitySocket)}`,
    ...(options.electronRunAsNode ? ['ELECTRON_RUN_AS_NODE=1'] : [])
  ]
  return [
    '#!/bin/sh',
    '# icode-managed-jcode-hook (managed by iCode; do not edit)',
    `printf '%s' "\${JCODE_HOOK_PAYLOAD-}" | env ${env.join(' ')} \\`,
    `  ${shellQuote(options.guestExecutablePath)} ${shellQuote(options.scriptPath)} \\`,
    `  'jcode' ${shellQuote(event.providerEvent)} ${shellQuote(event.canonicalEvent)} 'none' \\`,
    '  >/dev/null 2>&1 || :',
    'exit 0',
    ''
  ].join('\n')
}

function guestCommand(options: GuestManagedHookOptions, event: ManagedHookEvent): string {
  return `sh ${shellQuote(guestWrapperPath(options, event))}`
}

async function writeGuestWrappers(options: GuestManagedHookOptions): Promise<void> {
  for (const event of MANAGED_HOOK_PROVIDER_SPECS.jcode.events) {
    await writeGuestHookText(
      options.runner,
      options.distro,
      guestWrapperPath(options, event),
      guestWrapperSource(options, event),
      options.signal
    )
  }
}

async function removeGuestWrappers(options: GuestManagedHookOptions): Promise<void> {
  for (const event of MANAGED_HOOK_PROVIDER_SPECS.jcode.events) {
    await removeGuestHookFile(
      options.runner,
      options.distro,
      guestWrapperPath(options, event),
      options.signal
    )
  }
}

export async function guestJcodeStatus(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  return statusFrom(path, text, (event) => guestCommand(options, event))
}

export async function installGuestJcodeHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  const applied = applyJcodeHooks(text ?? '', (event) => guestCommand(options, event))
  await writeGuestWrappers(options)
  if (applied.text !== text) {
    await writeGuestHookText(options.runner, options.distro, path, applied.text, options.signal)
  }
  return statusFrom(path, applied.text, (event) => guestCommand(options, event))
}

export async function removeGuestJcodeHooks(
  options: GuestManagedHookOptions
): Promise<ManagedHookProviderStatus> {
  const path = guestPath(options)
  const text = await readGuestHookText(options.runner, options.distro, path, options.signal)
  if (text === null) {
    await removeGuestWrappers(options)
    return statusFrom(path, null, (event) => guestCommand(options, event))
  }
  const removed = removeJcodeHooks(text)
  if (removed.changed) {
    await writeGuestHookText(options.runner, options.distro, path, removed.text, options.signal)
  }
  await removeGuestWrappers(options)
  return statusFrom(path, removed.text, (event) => guestCommand(options, event))
}

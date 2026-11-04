/**
 * Workspace trust for agent harnesses.
 *
 * Adding a project is the product's trust decision. A session runs in a fresh
 * worktree, and harnesses remember trust per directory; without this preparation
 * every new worktree would ask the user again. The preparation writes only the
 * trust record a user would create by accepting the harness dialog. It never
 * answers agent permission prompts and never disables a harness's own security
 * checks.
 *
 * Claude Code and Codex are the harnesses with a verified workspace-trust
 * record. OpenCode and the shell have no workspace-trust gate to seed.
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HarnessId } from '../../../shared/domain/harness'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import type { WslCommandRunner, WslExecOutcome } from '../../wsl/exec'
import { readGuestHome } from '../../wsl/host/lifecycle'
import { isTransportOutcome } from '../../wsl/probe'

const MAX_CONFIG_BYTES = 10 * 1024 * 1024
const CONFIG_TIMEOUT_MS = 10_000

const READ_GUEST_CONFIG =
  'if [ -f "$1" ]; then cat -- "$1"; fi'
const WRITE_GUEST_CONFIG = [
  'tmp="$1.ade-tmp-$$"',
  'trap \'rm -f -- "$tmp"\' 0 1 2 15',
  'mkdir -p -- "$(dirname -- "$1")" || exit 1',
  'cat > "$tmp" || exit 1',
  'chmod 600 -- "$tmp" 2>/dev/null || true',
  'mv -f -- "$tmp" "$1" || exit 1',
  'trap - 0 1 2 15'
].join('\n')

export type WorkspaceTrustRequest = {
  harness: HarnessId
  target: ExecutionTarget
  worktreePath: string
}

export type WorkspaceTrustResult =
  | { status: 'trusted' }
  | { status: 'already-trusted' }
  | { status: 'unsupported' }
  | { status: 'failed'; detail: string }

export interface WorkspaceTrustService {
  prepare(request: WorkspaceTrustRequest): Promise<WorkspaceTrustResult>
  remove(request: WorkspaceTrustRequest): Promise<void>
}

export type WorkspaceTrustDeps = {
  runner: WslCommandRunner
  localHome: string
  readGuestHome?: (distro: string) => Promise<string | null>
  platform?: NodeJS.Platform
}

type ConfigFile = {
  path: string
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

type Adapter = {
  prepare(file: ConfigFile, worktreePaths: string[]): Promise<WorkspaceTrustResult>
  remove(file: ConfigFile, worktreePaths: string[]): Promise<void>
}

const UNSUPPORTED: Adapter = {
  prepare: async (_file, _paths) => ({ status: 'unsupported' }),
  remove: async (_file, _paths) => undefined
}

/**
 * Config writes are serialized per file. Harness configs are shared by every
 * session, and an interleaved read-modify-write could drop another session's
 * trust entry.
 */
const configQueues = new Map<string, Promise<void>>()

async function withConfigLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = configQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => gate)
  configQueues.set(key, queued)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (configQueues.get(key) === queued) configQueues.delete(key)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function limitDetail(value: string): string {
  return value.slice(0, 500)
}

function localConfig(path: string): ConfigFile {
  return {
    path,
    async read() {
      let info
      try {
        info = await fs.stat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      if (!info.isFile()) throw new Error(`The harness config is not a file: ${path}`)
      if (info.size > MAX_CONFIG_BYTES) throw new Error(`The harness config is too large: ${path}`)
      return fs.readFile(path, 'utf8')
    },
    async write(text) {
      const directory = dirname(path)
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${path}.ade-tmp-${String(process.pid)}-${String(Math.random()).slice(2)}`
      try {
        await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temporary, path)
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    }
  }
}

function guestConfig(
  runner: WslCommandRunner,
  distro: string,
  path: string
): ConfigFile {
  return {
    path,
    async read() {
      const result = await runner.run({
        scope: 'guest',
        distro,
        argv: ['sh', '-c', READ_GUEST_CONFIG, 'ade-trust-read', path],
        timeoutMs: CONFIG_TIMEOUT_MS
      })
      const text = guestSuccess(result, 'read the harness config')
      if (text.length > MAX_CONFIG_BYTES) {
        throw new Error(`The harness config is too large: ${path}`)
      }
      return text.length === 0 ? null : text
    },
    async write(text) {
      const result = await runner.run({
        scope: 'guest',
        distro,
        argv: ['sh', '-c', WRITE_GUEST_CONFIG, 'ade-trust-write', path],
        stdin: text,
        timeoutMs: CONFIG_TIMEOUT_MS
      })
      guestSuccess(result, 'write the harness config')
    }
  }
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

function claudeConfigPath(target: ExecutionTarget, localHome: string, guestHome: string): string {
  return target.kind === 'local'
    ? join(localHome, '.claude.json')
    : `${guestHome.replace(/\/+$/u, '')}/.claude.json`
}

function codexConfigPath(target: ExecutionTarget, localHome: string, guestHome: string): string {
  return target.kind === 'local'
    ? join(localHome, '.codex', 'config.toml')
    : `${guestHome.replace(/\/+$/u, '')}/.codex/config.toml`
}

function claudeProjectKey(
  target: ExecutionTarget,
  worktreePath: string,
  platform: NodeJS.Platform
): string {
  if (target.kind === 'local' && platform === 'win32') {
    return worktreePath.replace(/\\/gu, '/')
  }
  return worktreePath
}

function codexProjectKeys(
  target: ExecutionTarget,
  worktreePath: string,
  platform: NodeJS.Platform
): string[] {
  if (target.kind !== 'local' || platform !== 'win32') return [worktreePath]
  /*
   * Codex 0.118 stores/looks up the ordinary Windows spelling. The extended
   * `\\?\` form does not match its trust lookup (verified against the real
   * binary), so seeding it would only leave a second, unused project entry.
   */
  return [worktreePath.replace(/\//gu, '\\')]
}

async function prepareClaude(file: ConfigFile, worktreePath: string): Promise<WorkspaceTrustResult> {
  const key = worktreePath
  const raw = await file.read()
  const data: unknown = raw === null || raw.trim().length === 0 ? {} : JSON.parse(raw)
  if (!isRecord(data)) throw new Error('The Claude config is not a JSON object.')
  const projects = data.projects ?? {}
  if (!isRecord(projects)) throw new Error('The Claude projects config is not an object.')
  const existing = projects[key]
  if (existing !== undefined && !isRecord(existing)) {
    throw new Error('The Claude project entry is not an object.')
  }
  if (isRecord(existing) && existing.hasTrustDialogAccepted === true) {
    return { status: 'already-trusted' }
  }
  projects[key] = {
    ...(isRecord(existing) ? existing : {}),
    hasTrustDialogAccepted: true
  }
  data.projects = projects
  await file.write(`${JSON.stringify(data, null, 2)}\n`)
  return { status: 'trusted' }
}

async function removeClaude(file: ConfigFile, worktreePath: string): Promise<void> {
  const raw = await file.read()
  if (raw === null || raw.trim().length === 0) return
  const data: unknown = JSON.parse(raw)
  if (!isRecord(data) || !isRecord(data.projects)) return
  const entry = data.projects[worktreePath]
  if (!isRecord(entry) || entry.hasTrustDialogAccepted !== true) return
  const rest = { ...entry }
  delete rest.hasTrustDialogAccepted
  if (Object.keys(rest).length === 0) delete data.projects[worktreePath]
  else data.projects[worktreePath] = rest
  await file.write(`${JSON.stringify(data, null, 2)}\n`)
}

function tomlKey(value: string): string {
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

function unescapeBasicToml(value: string): string {
  return value.replace(/\\(["\\])/gu, '$1')
}

function projectHeaderPath(line: string): string | null {
  const match = /^\s*\[projects\.(?:'([^']*)'|"((?:\\.|[^"\\])*)")\]\s*(?:#.*)?$/u.exec(line)
  if (match === null) return null
  if (match[1] !== undefined) return match[1]
  return unescapeBasicToml(match[2] ?? '')
}

function isTableHeader(line: string): boolean {
  return /^\s*\[/u.test(line)
}

function ensureTrustInToml(
  lines: string[],
  path: string
): boolean {
  let changed = false
  let header = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (projectHeaderPath(lines[index] ?? '') === path) {
      header = index
      break
    }
  }

  if (header !== -1) {
    let end = lines.length
    for (let index = header + 1; index < lines.length; index += 1) {
      if (isTableHeader(lines[index] ?? '')) {
        end = index
        break
      }
    }
    for (let index = header + 1; index < end; index += 1) {
      const match = /^(\s*trust_level\s*=\s*)(?:"[^"]*"|'[^']*')(.*)$/u.exec(lines[index] ?? '')
      if (match !== null) {
        const next = `${match[1] ?? ''}"trusted"${match[2] ?? ''}`
        if (lines[index] !== next) {
          lines[index] = next
          changed = true
        }
        return changed
      }
    }
    lines.splice(header + 1, 0, 'trust_level = "trusted"')
    return true
  }

  if (lines.length > 0 && (lines.at(-1) ?? '').trim().length > 0) lines.push('')
  lines.push(`[projects.${tomlKey(path)}]`, 'trust_level = "trusted"')
  return true
}

function removeTrustFromToml(lines: string[], path: string): boolean {
  let header = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (projectHeaderPath(lines[index] ?? '') === path) {
      header = index
      break
    }
  }
  if (header === -1) return false
  let end = lines.length
  for (let index = header + 1; index < lines.length; index += 1) {
    if (isTableHeader(lines[index] ?? '')) {
      end = index
      break
    }
  }
  for (let index = header + 1; index < end; index += 1) {
    if (/^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/u.test(lines[index] ?? '')) {
      lines.splice(index, 1)
      return true
    }
  }
  return false
}

function splitToml(text: string): { lines: string[]; newline: string } {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  return { lines: text.length === 0 ? [] : text.split(/\r?\n/u), newline }
}

async function prepareCodex(
  file: ConfigFile,
  paths: string[]
): Promise<WorkspaceTrustResult> {
  const raw = await file.read()
  const { lines, newline } = splitToml(raw ?? '')
  let changed = false
  for (const path of paths) {
    changed = ensureTrustInToml(lines, path) || changed
  }
  if (!changed) return { status: 'already-trusted' }
  await file.write(`${lines.join(newline)}${newline}`)
  return { status: 'trusted' }
}

async function removeCodex(file: ConfigFile, paths: string[]): Promise<void> {
  const raw = await file.read()
  if (raw === null || raw.trim().length === 0) return
  const { lines, newline } = splitToml(raw)
  let changed = false
  for (const path of paths) {
    changed = removeTrustFromToml(lines, path) || changed
  }
  if (changed) await file.write(`${lines.join(newline)}${newline}`)
}

const claudeAdapter: Adapter = {
  prepare: (file, worktreePaths) => prepareClaude(file, worktreePaths[0]!),
  remove: (file, worktreePaths) => removeClaude(file, worktreePaths[0]!)
}

const codexAdapter: Adapter = {
  prepare: (file, worktreePaths) => prepareCodex(file, worktreePaths),
  remove: (file, worktreePaths) => removeCodex(file, worktreePaths)
}

const adapters: Record<HarnessId, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: UNSUPPORTED,
  shell: UNSUPPORTED
}

export function createWorkspaceTrust(deps: WorkspaceTrustDeps): WorkspaceTrustService {
  const platform = deps.platform ?? process.platform
  const guestHome = deps.readGuestHome ?? ((distro) => readGuestHome(deps.runner, distro))

  async function fileFor(target: ExecutionTarget, kind: 'claude' | 'codex'): Promise<ConfigFile> {
    if (target.kind === 'local') {
      return localConfig(
        kind === 'claude'
          ? claudeConfigPath(target, deps.localHome, '')
          : codexConfigPath(target, deps.localHome, '')
      )
    }
    const home = await guestHome(target.distro).catch(() => null)
    if (home === null || !home.startsWith('/')) {
      throw new Error(`${target.distro} did not report a home directory.`)
    }
    const path =
      kind === 'claude'
        ? claudeConfigPath(target, deps.localHome, home)
        : codexConfigPath(target, deps.localHome, home)
    return guestConfig(deps.runner, target.distro, path)
  }

  function projectPaths(
    request: WorkspaceTrustRequest,
    kind: 'claude' | 'codex'
  ): string[] {
    return kind === 'claude'
      ? [claudeProjectKey(request.target, request.worktreePath, platform)]
      : codexProjectKeys(request.target, request.worktreePath, platform)
  }

  return {
    async prepare(request) {
      const adapter = adapters[request.harness]
      if (adapter === undefined) return { status: 'unsupported' }
      if (request.harness === 'opencode' || request.harness === 'shell') {
        return { status: 'unsupported' }
      }
      const kind = request.harness === 'claude' ? 'claude' : 'codex'
      try {
        const file = await fileFor(request.target, kind)
        const paths = projectPaths(request, kind)
        return await withConfigLock(`${request.target.kind}:${file.path}`, () =>
          adapter.prepare(file, paths)
        )
      } catch (error) {
        return { status: 'failed', detail: limitDetail(errorText(error)) }
      }
    },
    async remove(request) {
      if (request.harness === 'opencode' || request.harness === 'shell') return
      const adapter = adapters[request.harness]
      const kind = request.harness === 'claude' ? 'claude' : 'codex'
      try {
        const file = await fileFor(request.target, kind)
        const paths = projectPaths(request, kind)
        await withConfigLock(`${request.target.kind}:${file.path}`, () =>
          adapter.remove(file, paths)
        )
      } catch {
        // Session removal already happened; a stale trust record is harmless.
      }
    }
  }
}

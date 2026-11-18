import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OpenCodePluginApi } from '../../../shared/domain/harness'
import {
  OPENCODE_PLUGIN_MARKER,
  openCodeServerPluginSource,
  openCodeTuiPluginSource
} from './plugin-source'

export const OPENCODE_SERVER_PLUGIN_FILE = 'icode-opencode-status.js'
export const OPENCODE_TUI_PLUGIN_DIR = 'icode-opencode-status-tui'
export const OPENCODE_TUI_PLUGIN_FILE = 'tui.js'

export type OpenCodeInstallState =
  | { state: 'installed'; configDir: string; api: 'v1' | 'v2'; tuiRegistered: boolean }
  | { state: 'not-installed'; configDir: string }
  | { state: 'unsupported'; configDir: string; detail: string }
  | { state: 'failed'; configDir: string; detail: string }

export type OpenCodeInstallerOptions = {
  /** Test seam; the shipped sources are the default. */
  serverSource?: string
  tuiSource?: string
}

function pluginPaths(configDir: string) {
  const plugins = join(configDir, 'plugins')
  return {
    plugins,
    server: join(plugins, OPENCODE_SERVER_PLUGIN_FILE),
    tuiDir: join(plugins, OPENCODE_TUI_PLUGIN_DIR),
    tui: join(plugins, OPENCODE_TUI_PLUGIN_DIR, OPENCODE_TUI_PLUGIN_FILE),
    tuiJson: join(configDir, 'tui.json'),
    tuiJsonc: join(configDir, 'tui.jsonc')
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isMarkerOwned(path: string): Promise<boolean> {
  try {
    return (await fs.readFile(path, 'utf8')).includes(OPENCODE_PLUGIN_MARKER)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.icode-tmp-${String(process.pid)}-${String(Math.random()).slice(2)}`
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, path)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function localInstallStatus(configDir: string): Promise<OpenCodeInstallState> {
  const paths = pluginPaths(configDir)
  if (!(await exists(paths.server))) return { state: 'not-installed', configDir }
  if (!(await isMarkerOwned(paths.server))) {
    return { state: 'failed', configDir, detail: 'A user-owned plugin uses iCode’s file name.' }
  }
  return {
    state: 'installed',
    configDir,
    api: (await hasTuiRegistration(configDir)) ? 'v1' : 'v2',
    tuiRegistered: await hasTuiRegistration(configDir)
  }
}

export async function installLocalOpenCodeIntegration(
  configDir: string,
  api: OpenCodePluginApi,
  options: OpenCodeInstallerOptions = {}
): Promise<OpenCodeInstallState> {
  if (api === 'unknown') {
    return {
      state: 'unsupported',
      configDir,
      detail: 'OpenCode did not report a 1.x or 2.x version.'
    }
  }

  const paths = pluginPaths(configDir)
  try {
    await fs.mkdir(paths.plugins, { recursive: true, mode: 0o700 })
    if (!(await isMarkerOwned(paths.server))) {
      return {
        state: 'failed',
        configDir,
        detail: 'A user-owned plugin uses iCode’s file name.'
      }
    }
    if ((await exists(paths.tui)) && !(await isMarkerOwned(paths.tui))) {
      return {
        state: 'failed',
        configDir,
        detail: 'A user-owned TUI plugin uses iCode’s directory.'
      }
    }

    await writeAtomic(paths.server, options.serverSource ?? openCodeServerPluginSource())
    await writeAtomic(paths.tui, options.tuiSource ?? openCodeTuiPluginSource())

    let tuiRegistered = false
    if (api === 'v1') {
      const registration = await registerTuiPlugin(configDir, paths.tui)
      if (!registration.ok) {
        return { state: 'failed', configDir, detail: registration.detail }
      }
      tuiRegistered = true
    } else {
      await removeTuiRegistration(configDir, paths.tui)
    }
    return { state: 'installed', configDir, api, tuiRegistered }
  } catch (error) {
    return {
      state: 'failed',
      configDir,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function removeLocalOpenCodeIntegration(
  configDir: string
): Promise<OpenCodeInstallState> {
  const paths = pluginPaths(configDir)
  try {
    if (await exists(paths.server)) {
      if (!(await isMarkerOwned(paths.server))) {
        return {
          state: 'failed',
          configDir,
          detail: 'Refusing to remove a user-owned plugin file.'
        }
      }
      await fs.rm(paths.server, { force: true })
    }
    if (await exists(paths.tui)) {
      if (!(await isMarkerOwned(paths.tui))) {
        return {
          state: 'failed',
          configDir,
          detail: 'Refusing to remove a user-owned TUI plugin file.'
        }
      }
      await fs.rm(paths.tui, { force: true })
    }
    await fs.rmdir(paths.tuiDir).catch(() => undefined)
    await removeTuiRegistration(configDir, paths.tui)
    return { state: 'not-installed', configDir }
  } catch (error) {
    return {
      state: 'failed',
      configDir,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

function tuiEntry(tuiPath: string): string {
  return pathToFileURL(tuiPath).href
}

async function hasTuiRegistration(configDir: string): Promise<boolean> {
  const paths = pluginPaths(configDir)
  try {
    const text = await fs.readFile(paths.tuiJson, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    const plugin = (parsed as { plugin?: unknown }).plugin
    return Array.isArray(plugin) && plugin.some((entry) => entry === tuiEntry(paths.tui))
  } catch {
    return false
  }
}

export type TuiRegistrationResult = { ok: true } | { ok: false; detail: string }

/**
 * Registers the 1.x TUI entry without rewriting unrelated keys.
 *
 * A JSONC file is deliberately left untouched and reported: editing comments
 * without a JSONC parser would destroy user formatting. The server plugin remains
 * installed, so a fresh TUI still works; a shared server needs the later parser.
 */
export async function registerTuiPlugin(
  configDir: string,
  tuiPath: string
): Promise<TuiRegistrationResult> {
  const paths = pluginPaths(configDir)
  if (await exists(paths.tuiJsonc)) {
    return {
      ok: false,
      detail: 'tui.jsonc is present; iCode does not edit commented JSON yet.'
    }
  }
  let text = '{}\n'
  if (await exists(paths.tuiJson)) {
    try {
      text = await fs.readFile(paths.tuiJson, 'utf8')
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, detail: 'tui.json is not valid JSON; left untouched.' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, detail: 'tui.json is not an object; left untouched.' }
  }
  const record = parsed as Record<string, unknown>
  const current = record.plugin
  if (current !== undefined && !Array.isArray(current)) {
    return { ok: false, detail: 'tui.json plugin is not a list; left untouched.' }
  }
  const entries = current === undefined ? [] : [...current]
  const entry = tuiEntry(tuiPath)
  if (!entries.includes(entry)) entries.push(entry)
  const updated = JSON.stringify({ ...record, plugin: entries }, null, 2) + '\n'
  if (updated !== text) await writeAtomic(paths.tuiJson, updated)
  return { ok: true }
}

async function removeTuiRegistration(configDir: string, tuiPath: string): Promise<void> {
  const paths = pluginPaths(configDir)
  if (!(await exists(paths.tuiJson))) return
  try {
    const text = await fs.readFile(paths.tuiJson, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const record = parsed as Record<string, unknown>
    if (!Array.isArray(record.plugin)) return
    const entry = tuiEntry(tuiPath)
    if (!record.plugin.includes(entry)) return
    const plugin = record.plugin.filter((item) => item !== entry)
    const updated = JSON.stringify({ ...record, plugin }, null, 2) + '\n'
    await writeAtomic(paths.tuiJson, updated)
  } catch {
    // A malformed user config is never rewritten during removal.
  }
}

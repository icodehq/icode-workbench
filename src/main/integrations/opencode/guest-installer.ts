import type { WslCommandRunner } from '../../wsl/exec'
import type { OpenCodePluginApi } from '../../../shared/domain/harness'
import {
  OPENCODE_PLUGIN_MARKER,
  openCodeServerPluginSource,
  openCodeTuiPluginSource
} from './plugin-source'
import {
  readGuestFile,
  removeGuestDirectory,
  removeGuestFile,
  resolveGuestOpenCodeConfigDir,
  writeGuestFile
} from './guest'

export type GuestInstallState =
  | { state: 'installed'; configDir: string; distro: string; api: 'v1' | 'v2'; tuiRegistered: boolean }
  | { state: 'not-installed'; configDir: string; distro: string }
  | { state: 'unsupported'; configDir: string; distro: string; detail: string }
  | { state: 'failed'; configDir: string; distro: string; detail: string }

function paths(configDir: string) {
  return {
    server: `${configDir}/plugins/icode-opencode-status.js`,
    tui: `${configDir}/plugins/icode-opencode-status-tui/tui.js`,
    tuiDir: `${configDir}/plugins/icode-opencode-status-tui`,
    tuiJson: `${configDir}/tui.json`,
    tuiJsonc: `${configDir}/tui.jsonc`
  }
}

function guestFileUrl(path: string): string {
  return `file://${path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`
}

function owned(text: string | null): boolean {
  return text === null || text.includes(OPENCODE_PLUGIN_MARKER)
}

async function registerGuestTui(
  runner: WslCommandRunner,
  distro: string,
  configDir: string,
  tuiPath: string
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const pathsFor = paths(configDir)
  if ((await readGuestFile(runner, distro, pathsFor.tuiJsonc)) !== null) {
    return { ok: false, detail: 'tui.jsonc is present; iCode does not edit commented JSON yet.' }
  }
  const text = (await readGuestFile(runner, distro, pathsFor.tuiJson)) ?? '{}\n'
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
  const entry = guestFileUrl(tuiPath)
  if (!entries.includes(entry)) entries.push(entry)
  const updated = JSON.stringify({ ...record, plugin: entries }, null, 2) + '\n'
  if (updated !== text) await writeGuestFile(runner, distro, pathsFor.tuiJson, updated)
  return { ok: true }
}

async function removeGuestTui(
  runner: WslCommandRunner,
  distro: string,
  configDir: string,
  tuiPath: string
): Promise<void> {
  const pathsFor = paths(configDir)
  const text = await readGuestFile(runner, distro, pathsFor.tuiJson)
  if (text === null) return
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const record = parsed as Record<string, unknown>
    if (!Array.isArray(record.plugin)) return
    const entry = guestFileUrl(tuiPath)
    if (!record.plugin.includes(entry)) return
    const plugin = record.plugin.filter((item) => item !== entry)
    await writeGuestFile(
      runner,
      distro,
      pathsFor.tuiJson,
      JSON.stringify({ ...record, plugin }, null, 2) + '\n'
    )
  } catch {
    // A malformed user config is never rewritten during removal.
  }
}

export async function installGuestOpenCodeIntegration(
  runner: WslCommandRunner,
  distro: string,
  api: OpenCodePluginApi,
  options: { serverSource?: string; tuiSource?: string } = {}
): Promise<GuestInstallState> {
  let configDir = ''
  try {
    configDir = await resolveGuestOpenCodeConfigDir(runner, distro)
  } catch (error) {
    return {
      state: 'failed',
      configDir,
      distro,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  if (api === 'unknown') {
    return {
      state: 'unsupported',
      configDir,
      distro,
      detail: 'OpenCode did not report a 1.x or 2.x version.'
    }
  }
  const pathsFor = paths(configDir)
  try {
    if (!owned(await readGuestFile(runner, distro, pathsFor.server))) {
      return {
        state: 'failed',
        configDir,
        distro,
        detail: 'A user-owned plugin uses iCode’s file name.'
      }
    }
    if (!owned(await readGuestFile(runner, distro, pathsFor.tui))) {
      return {
        state: 'failed',
        configDir,
        distro,
        detail: 'A user-owned TUI plugin uses iCode’s directory.'
      }
    }
    await writeGuestFile(
      runner,
      distro,
      pathsFor.server,
      options.serverSource ?? openCodeServerPluginSource()
    )
    await writeGuestFile(
      runner,
      distro,
      pathsFor.tui,
      options.tuiSource ?? openCodeTuiPluginSource()
    )
    let tuiRegistered = false
    if (api === 'v1') {
      const registration = await registerGuestTui(runner, distro, configDir, pathsFor.tui)
      if (!registration.ok) {
        return { state: 'failed', configDir, distro, detail: registration.detail }
      }
      tuiRegistered = true
    } else {
      await removeGuestTui(runner, distro, configDir, pathsFor.tui)
    }
    return { state: 'installed', configDir, distro, api, tuiRegistered }
  } catch (error) {
    return {
      state: 'failed',
      configDir,
      distro,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function removeGuestOpenCodeIntegration(
  runner: WslCommandRunner,
  distro: string,
  configDir?: string
): Promise<GuestInstallState> {
  let directory = configDir ?? ''
  try {
    directory = configDir ?? (await resolveGuestOpenCodeConfigDir(runner, distro))
    const pathsFor = paths(directory)
    const server = await readGuestFile(runner, distro, pathsFor.server)
    if (server !== null && !owned(server)) {
      return {
        state: 'failed',
        configDir: directory,
        distro,
        detail: 'Refusing to remove a user-owned plugin file.'
      }
    }
    const tui = await readGuestFile(runner, distro, pathsFor.tui)
    if (tui !== null && !owned(tui)) {
      return {
        state: 'failed',
        configDir: directory,
        distro,
        detail: 'Refusing to remove a user-owned TUI plugin file.'
      }
    }
    if (server !== null) await removeGuestFile(runner, distro, pathsFor.server)
    if (tui !== null) await removeGuestFile(runner, distro, pathsFor.tui)
    await removeGuestDirectory(runner, distro, pathsFor.tuiDir)
    await removeGuestTui(runner, distro, directory, pathsFor.tui)
    return { state: 'not-installed', configDir: directory, distro }
  } catch (error) {
    return {
      state: 'failed',
      configDir: directory,
      distro,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OPENCODE_SERVER_PLUGIN_FILE,
  OPENCODE_TUI_PLUGIN_DIR,
  installLocalOpenCodeIntegration,
  localInstallStatus,
  registerTuiPlugin,
  removeLocalOpenCodeIntegration
} from './installer'
import { OPENCODE_PLUGIN_MARKER } from './plugin-source'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'icode-opencode-installer-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const serverPath = () => join(directory, 'plugins', OPENCODE_SERVER_PLUGIN_FILE)
const tuiPath = () => join(directory, 'plugins', OPENCODE_TUI_PLUGIN_DIR, 'tui.js')
const tuiJson = () => join(directory, 'tui.json')

describe('local OpenCode installer', () => {
  it('installs marker-owned server and TUI files and registers the 1.x TUI', async () => {
    const result = await installLocalOpenCodeIntegration(directory, 'v1')
    expect(result).toMatchObject({ state: 'installed', api: 'v1', tuiRegistered: true })
    expect(readFileSync(serverPath(), 'utf8')).toContain(OPENCODE_PLUGIN_MARKER)
    expect(readFileSync(tuiPath(), 'utf8')).toContain(OPENCODE_PLUGIN_MARKER)
    expect(JSON.parse(readFileSync(tuiJson(), 'utf8'))).toEqual({
      plugin: [pathToFileURL(tuiPath()).href]
    })
    await expect(localInstallStatus(directory)).resolves.toMatchObject({
      state: 'installed',
      api: 'v1'
    })
  })

  it('preserves user TUI entries and is idempotent', async () => {
    writeFileSync(tuiJson(), JSON.stringify({ theme: 'dark', plugin: ['user-plugin'] }) + '\n')
    await installLocalOpenCodeIntegration(directory, 'v1')
    const before = readFileSync(tuiJson(), 'utf8')
    await installLocalOpenCodeIntegration(directory, 'v1')
    expect(readFileSync(tuiJson(), 'utf8')).toBe(before)
    expect(JSON.parse(before)).toEqual({
      theme: 'dark',
      plugin: ['user-plugin', pathToFileURL(tuiPath()).href]
    })
  })

  it('installs the 2.x layout without a TUI registration', async () => {
    await installLocalOpenCodeIntegration(directory, 'v1')
    const result = await installLocalOpenCodeIntegration(directory, 'v2')
    expect(result).toMatchObject({ state: 'installed', api: 'v2', tuiRegistered: false })
    expect(JSON.parse(readFileSync(tuiJson(), 'utf8'))).toEqual({ plugin: [] })
  })

  it('refuses to overwrite a user-owned file with iCode’s name', async () => {
    mkdirSync(join(directory, 'plugins'), { recursive: true })
    writeFileSync(serverPath(), 'user plugin')
    const result = await installLocalOpenCodeIntegration(directory, 'v1')
    expect(result.state).toBe('failed')
    expect(readFileSync(serverPath(), 'utf8')).toBe('user plugin')
  })

  it('installs nothing for an unknown version', async () => {
    const result = await installLocalOpenCodeIntegration(directory, 'unknown')
    expect(result.state).toBe('unsupported')
    await expect(localInstallStatus(directory)).resolves.toMatchObject({ state: 'not-installed' })
  })

  it('reports a JSONC-only TUI config without touching it', async () => {
    writeFileSync(join(directory, 'tui.jsonc'), '{ "plugin": [] /* user comment */ }\n')
    const result = await installLocalOpenCodeIntegration(directory, 'v1')
    expect(result.state).toBe('failed')
    expect(readFileSync(join(directory, 'tui.jsonc'), 'utf8')).toContain('user comment')
  })

  it('removes only marker-owned files and its exact TUI entry', async () => {
    writeFileSync(tuiJson(), JSON.stringify({ plugin: ['user-plugin'] }) + '\n')
    await installLocalOpenCodeIntegration(directory, 'v1')
    const result = await removeLocalOpenCodeIntegration(directory)
    expect(result.state).toBe('not-installed')
    expect(JSON.parse(readFileSync(tuiJson(), 'utf8'))).toEqual({ plugin: ['user-plugin'] })
    await expect(localInstallStatus(directory)).resolves.toMatchObject({ state: 'not-installed' })
  })

  it('does not remove a user-owned file during uninstall', async () => {
    mkdirSync(join(directory, 'plugins'), { recursive: true })
    writeFileSync(serverPath(), 'user plugin')
    const result = await removeLocalOpenCodeIntegration(directory)
    expect(result.state).toBe('failed')
    expect(readFileSync(serverPath(), 'utf8')).toBe('user plugin')
  })
})

describe('TUI registration', () => {
  it('leaves malformed JSON untouched', async () => {
    writeFileSync(tuiJson(), '{not json')
    const result = await registerTuiPlugin(directory, tuiPath())
    expect(result.ok).toBe(false)
    expect(readFileSync(tuiJson(), 'utf8')).toBe('{not json')
  })
})

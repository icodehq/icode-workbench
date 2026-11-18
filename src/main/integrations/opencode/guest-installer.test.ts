import { describe, expect, it } from 'vitest'
import type { WslCommandRunner, WslExecRequest, WslExecOutcome } from '../../wsl/exec'
import {
  installGuestOpenCodeIntegration,
  removeGuestOpenCodeIntegration
} from './guest-installer'
import { OPENCODE_PLUGIN_MARKER } from './plugin-source'

const CONFIG_DIR = '/home/dev/.config/opencode'

function fakeRunner(initial: Record<string, string> = {}): {
  runner: WslCommandRunner
  files: Map<string, string>
} {
  const files = new Map(Object.entries(initial))
  const runner = {
    async run(request: WslExecRequest): Promise<WslExecOutcome> {
      if (request.scope !== 'guest') throw new Error('expected guest')
      const script = request.argv[1] === '-c' ? request.argv[2] : ''
      if (script === undefined) throw new Error('expected sh -c')
      const path = request.argv[4] ?? ''
      if (request.label === 'opencode-config-dir') {
        return { status: 'ok', stdout: CONFIG_DIR, stderr: '' }
      }
      if (request.label === 'opencode-read') {
        return { status: 'ok', stdout: files.get(path) ?? '', stderr: '' }
      }
      if (request.label === 'opencode-write') {
        files.set(path, String(request.stdin ?? ''))
        return { status: 'ok', stdout: '', stderr: '' }
      }
      if (request.label === 'opencode-remove') {
        files.delete(path)
        return { status: 'ok', stdout: '', stderr: '' }
      }
      if (request.label === 'opencode-rmdir') {
        return { status: 'ok', stdout: '', stderr: '' }
      }
      throw new Error(`unexpected request ${String(request.label)}`)
    }
  } as unknown as WslCommandRunner
  return { runner, files }
}

describe('guest OpenCode installer', () => {
  it('installs marker-owned files and registers the guest TUI entry', async () => {
    const { runner, files } = fakeRunner()
    const result = await installGuestOpenCodeIntegration(runner, 'Ubuntu', 'v1')
    expect(result).toMatchObject({
      state: 'installed',
      configDir: CONFIG_DIR,
      api: 'v1',
      tuiRegistered: true
    })
    expect(files.get(`${CONFIG_DIR}/plugins/icode-opencode-status.js`)).toContain(
      OPENCODE_PLUGIN_MARKER
    )
    expect(files.get(`${CONFIG_DIR}/plugins/icode-opencode-status-tui/tui.js`)).toContain(
      OPENCODE_PLUGIN_MARKER
    )
    expect(JSON.parse(files.get(`${CONFIG_DIR}/tui.json`) ?? '{}')).toEqual({
      plugin: ['file:///home/dev/.config/opencode/plugins/icode-opencode-status-tui/tui.js']
    })
  })

  it('removes only marker-owned files and the exact TUI entry', async () => {
    const { runner, files } = fakeRunner()
    await installGuestOpenCodeIntegration(runner, 'Ubuntu', 'v1')
    const result = await removeGuestOpenCodeIntegration(runner, 'Ubuntu')
    expect(result.state).toBe('not-installed')
    expect(files.has(`${CONFIG_DIR}/plugins/icode-opencode-status.js`)).toBe(false)
    expect(files.has(`${CONFIG_DIR}/plugins/icode-opencode-status-tui/tui.js`)).toBe(false)
    expect(JSON.parse(files.get(`${CONFIG_DIR}/tui.json`) ?? '{}')).toEqual({ plugin: [] })
  })

  it('does not overwrite or remove user-owned files', async () => {
    const server = `${CONFIG_DIR}/plugins/icode-opencode-status.js`
    const { runner, files } = fakeRunner({ [server]: 'user plugin' })
    const install = await installGuestOpenCodeIntegration(runner, 'Ubuntu', 'v1')
    expect(install.state).toBe('failed')
    expect(files.get(server)).toBe('user plugin')
    const remove = await removeGuestOpenCodeIntegration(runner, 'Ubuntu')
    expect(remove.state).toBe('failed')
    expect(files.get(server)).toBe('user plugin')
  })

  it('reports an unknown version without writing anything', async () => {
    const { runner, files } = fakeRunner()
    const result = await installGuestOpenCodeIntegration(runner, 'Ubuntu', 'unknown')
    expect(result.state).toBe('unsupported')
    expect(files.size).toBe(0)
  })
})

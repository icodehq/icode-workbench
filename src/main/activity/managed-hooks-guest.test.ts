import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WslCommandRunner, type WslProcessLauncher } from '../wsl/exec'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { ManagedHookProvider } from './managed-hooks'
import {
  guestManagedHookConfigPath,
  installGuestManagedHooks,
  removeGuestManagedHooks,
  type GuestManagedHookOptions
} from './managed-hooks-guest'
import { ManagedHooksService } from './managed-hooks-service'

const roots: string[] = []

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

function guestRunner(files: Map<string, string>): WslCommandRunner {
  const launcher: WslProcessLauncher = async (spec) => {
    const args = [...spec.args]
    const exec = args.indexOf('--exec')
    const guest = args.slice(exec + 1)
    if (guest[0] !== 'sh' || guest[1] !== '-c') {
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    const script = guest[2] ?? ''
    const path = guest[4] ?? ''
    if (script === 'if [ -f "$1" ]; then cat -- "$1"; fi') {
      return {
        code: 0,
        signal: null,
        stdout: files.get(path) ?? '',
        stderr: '',
        timedOut: false
      }
    }
    if (script.includes('tmp="$target.icode-tmp-$$"')) {
      files.set(
        path,
        typeof spec.stdin === 'string' ? spec.stdin : (spec.stdin?.toString('utf8') ?? '')
      )
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    return { code: 1, signal: null, stdout: '', stderr: 'unexpected guest command', timedOut: false }
  }
  return new WslCommandRunner({ launcher, platform: 'win32' })
}

function guestOptions(
  files: Map<string, string>,
  provider: ManagedHookProvider = 'gemini'
): GuestManagedHookOptions {
  return {
    runner: guestRunner(files),
    distro: 'Ubuntu-26.04',
    provider,
    guestHome: '/home/u',
    guestExecutablePath: '/mnt/c/Program Files/iCode/icode.exe',
    scriptPath: 'C:\\Users\\u\\AppData\\Roaming\\iCode\\agent-hooks\\icode-managed-hook.cjs',
    activitySocket: '\\\\.\\pipe\\icode-activity-test',
    electronRunAsNode: true
  }
}

function read(files: Map<string, string>, path: string): Record<string, unknown> {
  return JSON.parse(files.get(path) ?? '{}') as Record<string, unknown>
}

describe('guest managed hooks', () => {
  it('writes a Gemini config whose command crosses into the Windows hook', async () => {
    const files = new Map<string, string>()
    const options = guestOptions(files)
    const status = await installGuestManagedHooks(options)
    expect(status.state).toBe('installed')
    expect(status.configPath).toBe('/home/u/.gemini/settings.json')

    const config = read(files, status.configPath)
    const hooks = config.hooks as Record<string, Array<Record<string, unknown>>>
    const before = (hooks.BeforeAgent?.[0]?.hooks ?? []) as Array<Record<string, unknown>>
    const command = String(before[0]?.command)
    expect(command).toContain("WSLENV='ICODE_ACTIVITY_SOCKET:ICODE_SESSION_ID:ICODE_SESSION_INCARNATION:ELECTRON_RUN_AS_NODE'")
    expect(command).toContain("ICODE_ACTIVITY_SOCKET='\\\\.\\pipe\\icode-activity-test'")
    expect(command).toContain("'/mnt/c/Program Files/iCode/icode.exe'")
    expect(command).toContain('icode-managed-hook.cjs')
    expect(command).toContain("'gemini' 'BeforeAgent' 'UserPromptSubmit' 'json'")
  })

  it('preserves user hooks and removes only managed entries', async () => {
    const files = new Map<string, string>()
    const path = guestManagedHookConfigPath('gemini', '/home/u')
    files.set(
      path,
      JSON.stringify({
        theme: 'dark',
        hooks: { BeforeAgent: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] }
      })
    )
    const options = guestOptions(files)
    await installGuestManagedHooks(options)
    expect(
      (read(files, path).hooks as Record<string, unknown[]>).BeforeAgent
    ).toHaveLength(2)

    const removed = await removeGuestManagedHooks(options)
    expect(removed.state).toBe('not-installed')
    expect(read(files, path)).toEqual({
      theme: 'dark',
      hooks: { BeforeAgent: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] }
    })
  })

  it('writes Cursor version and rejects invalid JSON', async () => {
    const files = new Map<string, string>()
    const cursor = guestOptions(files, 'cursor')
    expect((await installGuestManagedHooks(cursor)).state).toBe('installed')
    expect(read(files, '/home/u/.cursor/hooks.json').version).toBe(1)

    const invalid = guestOptions(files)
    const gemini = guestManagedHookConfigPath('gemini', '/home/u')
    files.set(gemini, '{not json')
    expect((await installGuestManagedHooks(invalid)).state).toBe('failed')
    expect(files.get(gemini)).toBe('{not json')
  })

  it('installs on first WSL session and cleans tracked plus discovered distros on disable', async () => {
    const files = new Map<string, string>()
    const base = mkdtempSync(join(tmpdir(), 'icode-managed-hooks-guest-service-'))
    roots.push(base)
    let enabled = true
    const options = {
      directory: join(base, 'agent-hooks'),
      home: join(base, 'home'),
      execPath: process.execPath,
      electronRunAsNode: false,
      platform: 'linux' as const,
      env: {},
      loadEnabled: () => enabled,
      saveEnabled: (next: boolean) => {
        enabled = next
        return true
      },
      isAvailable: () => false,
      runner: guestRunner(files),
      readGuestHome: async () => '/home/u',
      guestExecutablePath: '/mnt/c/Program Files/iCode/icode.exe',
      activitySocket: '\\\\.\\pipe\\icode-activity-test',
      guestStatePath: join(base, 'guest-state.json')
    }
    const service = new ManagedHooksService(options)
    await service.prepareForSession(
      'gemini',
      { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: 'reg-1' },
      { state: 'available', harness: 'gemini' } as unknown as HarnessDetectionResult
    )
    expect(read(files, '/home/u/.gemini/settings.json').hooks).toBeTruthy()

    // A restart has no in-memory tracking; the ledger must still clean the
    // guest entry when the user turns the setting off.
    const afterRestart = new ManagedHooksService({ ...options, runner: guestRunner(files) })
    await afterRestart.setEnabled(false)
    expect(read(files, '/home/u/.gemini/settings.json').hooks).toEqual({})
  })
})

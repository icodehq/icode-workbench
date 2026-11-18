import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WslCommandRunner, type WslProcessLauncher } from '../wsl/exec'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import {
  ensureManagedHookScript,
  installManagedHooksForProvider,
  removeManagedHooksForProvider,
  type ManagedHookInstallOptions
} from './managed-hooks'
import {
  installGuestAmpHooks,
  installLocalAmpHooks,
  removeLocalAmpHooks
} from './managed-hooks-amp'
import { installLocalKimiHooks, removeLocalKimiHooks } from './managed-hooks-kimi'
import { ManagedHooksService } from './managed-hooks-service'

const roots: string[] = []

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

function options(base?: string): ManagedHookInstallOptions {
  const root = base ?? mkdtempSync(join(tmpdir(), 'icode-managed-extra-'))
  if (base === undefined) roots.push(root)
  return {
    directory: join(root, 'agent-hooks'),
    home: join(root, 'home'),
    execPath: process.execPath,
    electronRunAsNode: false,
    platform: 'linux',
    env: {}
  }
}

function text(path: string): string {
  return readFileSync(path, 'utf8')
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

describe('Grok and Droid JSON hooks', () => {
  it('installs Grok into its dedicated hook file with tool matchers', () => {
    const opts = options()
    const path = join(opts.home, '.grok', 'hooks', 'icode-status.json')
    const status = installManagedHooksForProvider('grok', opts)
    expect(status.state).toBe('installed')
    const config = JSON.parse(text(path)) as {
      hooks: Record<string, Array<Record<string, unknown>>>
    }
    expect(config.hooks.PreToolUse?.[0]).toMatchObject({ matcher: '.*' })
    expect(config.hooks.StopCancelled?.[0]?.hooks).toBeTruthy()
    expect(removeManagedHooksForProvider('grok', opts).state).toBe('not-installed')
  })

  it('respects Droid hooksDisabled and adds its matcher', () => {
    const opts = options()
    const path = join(opts.home, '.factory', 'settings.json')
    write(path, JSON.stringify({ hooksDisabled: true }))
    expect(installManagedHooksForProvider('droid', opts).state).toBe('not-installed')
    write(path, JSON.stringify({ hooksDisabled: false, theme: 'dark' }))
    expect(installManagedHooksForProvider('droid', opts).state).toBe('installed')
    const config = JSON.parse(text(path)) as {
      hooks: Record<string, Array<Record<string, unknown>>>
      theme: string
    }
    expect(config.theme).toBe('dark')
    expect(config.hooks.PreToolUse?.[0]).toMatchObject({ matcher: '*' })
    removeManagedHooksForProvider('droid', opts)
    expect(JSON.parse(text(path))).toEqual({ hooksDisabled: false, theme: 'dark', hooks: {} })
  })
})

describe('Claude-compatible providers', () => {
  it('installs Qoder and Qoder China into their own settings files', () => {
    const opts = options()
    for (const [provider, dir] of [
      ['qoder', '.qoder'],
      ['qoder-cn', '.qoder-cn']
    ] as const) {
      const path = join(opts.home, dir, 'settings.json')
      expect(installManagedHooksForProvider(provider, opts).state).toBe('installed')
      const config = JSON.parse(text(path)) as {
        hooks: Record<string, Array<Record<string, unknown>>>
      }
      expect(config.hooks.SessionEnd?.[0]?.hooks).toBeTruthy()
      expect(config.hooks.PermissionRequest?.[0]).toMatchObject({ matcher: '*' })
      expect(removeManagedHooksForProvider(provider, opts).state).toBe('not-installed')
    }
  })

  it('does not install CodeBuddy events that would reset or falsely wait', () => {
    const opts = options()
    const path = join(opts.home, '.codebuddy', 'settings.json')
    expect(installManagedHooksForProvider('codebuddy', opts).state).toBe('installed')
    const config = JSON.parse(text(path)) as { hooks: Record<string, unknown> }
    expect(config.hooks.SessionStart).toBeUndefined()
    expect(config.hooks.PermissionRequest).toBeUndefined()
    expect(config.hooks.UserPromptSubmit).toBeTruthy()
  })

  it('installs OpenClaude and preserves unrelated settings', () => {
    const opts = options()
    const path = join(opts.home, '.openclaude', 'settings.json')
    write(path, JSON.stringify({ theme: 'dark', hooks: {} }))
    expect(installManagedHooksForProvider('openclaude', opts).state).toBe('installed')
    const config = JSON.parse(text(path)) as { theme: string; hooks: Record<string, unknown> }
    expect(config.theme).toBe('dark')
    expect(config.hooks.StopFailure).toBeTruthy()
  })
})

describe('Kimi TOML hooks', () => {
  it('writes a marker-owned block and removes only that block', () => {
    const opts = options()
    const path = join(opts.home, '.kimi-code', 'config.toml')
    write(path, 'model = "kimi"\n\n[ui]\ntheme = "dark"\n')
    const runtime = ensureManagedHookScript(opts)
    expect(installLocalKimiHooks('kimi', opts, runtime).state).toBe('installed')
    const installed = text(path)
    expect(installed.startsWith('model = "kimi"')).toBe(true)
    expect(installed).toContain('# >>> icode-managed-kimi-hooks')
    expect(installed).toContain('event = "UserPromptSubmit"')
    expect(installed).toContain('matcher = "^resume$"')
    expect(installed).toContain("'kimi' 'PermissionRequest' 'PermissionRequest' 'none'")
    expect(removeLocalKimiHooks('kimi', opts).state).toBe('not-installed')
    expect(text(path)).toBe('model = "kimi"\n\n[ui]\ntheme = "dark"\n')
  })

  it('is idempotent and preserves CRLF', () => {
    const opts = options()
    const path = join(opts.home, '.kimi-code', 'config.toml')
    write(path, 'model = "kimi"\r\n')
    const runtime = ensureManagedHookScript(opts)
    installLocalKimiHooks('kimi', opts, runtime)
    installLocalKimiHooks('kimi', opts, runtime)
    const installed = text(path)
    expect(installed.match(/# >>> icode-managed-kimi-hooks/g)).toHaveLength(1)
    expect(installed).toContain('\r\n')
  })
})

describe('Amp plugin hooks', () => {
  it('writes a marker-owned plugin and refuses an unmanaged file', () => {
    const opts = options()
    const path = join(opts.home, '.config', 'amp', 'plugins', 'icode-agent-status.ts')
    expect(installLocalAmpHooks('amp', opts).state).toBe('installed')
    const source = text(path)
    expect(source).toContain('icode-managed-amp-plugin')
    expect(source).toContain('agent.start')
    expect(source).toContain('agent.end')
    expect(removeLocalAmpHooks('amp', opts).state).toBe('not-installed')

    write(path, '// user plugin\n')
    expect(installLocalAmpHooks('amp', opts).state).toBe('failed')
    expect(text(path)).toBe('// user plugin\n')
  })

  it('generates a guest plugin that spawns the Windows hook', async () => {
    const files = new Map<string, string>()
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
      return { code: 1, signal: null, stdout: '', stderr: 'unexpected', timedOut: false }
    }
    const runner = new WslCommandRunner({ launcher, platform: 'win32' })
    const status = await installGuestAmpHooks({
      runner,
      distro: 'Ubuntu-26.04',
      provider: 'amp',
      guestHome: '/home/u',
      guestExecutablePath: '/mnt/c/iCode/icode.exe',
      scriptPath: 'C:\\iCode\\agent-hooks\\icode-managed-hook.cjs',
      activitySocket: '\\\\.\\pipe\\icode-activity-test',
      electronRunAsNode: true
    })
    expect(status.state).toBe('installed')
    const source = files.get('/home/u/.config/amp/plugins/icode-agent-status.ts') ?? ''
    expect(source).toContain('spawn')
    expect(source).toContain('WSLENV')
    expect(source).toContain('/mnt/c/iCode/icode.exe')
    expect(source).toContain('icode-managed-hook.cjs')
  })
})

describe('service dispatch for new formats', () => {
  it('installs and removes Kimi and Amp through the shared setting', async () => {
    const base = mkdtempSync(join(tmpdir(), 'icode-managed-extra-service-'))
    roots.push(base)
    let enabled = true
    const service = new ManagedHooksService({
      directory: join(base, 'agent-hooks'),
      home: join(base, 'home'),
      execPath: process.execPath,
      electronRunAsNode: false,
      platform: 'linux',
      env: {},
      loadEnabled: () => enabled,
      saveEnabled: (next) => {
        enabled = next
        return true
      },
      isAvailable: (provider) => provider === 'kimi' || provider === 'amp'
    })
    const state = service.refresh()
    const byProvider = Object.fromEntries(state.providers.map((entry) => [entry.provider, entry]))
    expect(byProvider.kimi?.state).toBe('installed')
    expect(byProvider.amp?.state).toBe('installed')
    expect(text(join(base, 'home', '.kimi-code', 'config.toml'))).toContain(
      'icode-managed-kimi-hooks'
    )
    expect(text(join(base, 'home', '.config', 'amp', 'plugins', 'icode-agent-status.ts'))).toContain(
      'icode-managed-amp-plugin'
    )
    await service.setEnabled(false)
    expect(text(join(base, 'home', '.kimi-code', 'config.toml'))).not.toContain(
      'icode-managed-kimi-hooks'
    )
  })

  it('installs guest Kimi on a WSL session', async () => {
    const files = new Map<string, string>()
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
      return { code: 1, signal: null, stdout: '', stderr: 'unexpected', timedOut: false }
    }
    const base = mkdtempSync(join(tmpdir(), 'icode-managed-extra-guest-'))
    roots.push(base)
    const service = new ManagedHooksService({
      directory: join(base, 'agent-hooks'),
      home: join(base, 'home'),
      execPath: process.execPath,
      electronRunAsNode: false,
      platform: 'linux',
      env: {},
      loadEnabled: () => true,
      saveEnabled: () => true,
      isAvailable: () => false,
      runner: new WslCommandRunner({ launcher, platform: 'win32' }),
      readGuestHome: async () => '/home/u',
      guestExecutablePath: '/mnt/c/iCode/icode.exe',
      activitySocket: '\\\\.\\pipe\\icode-activity-test',
      guestStatePath: join(base, 'guest-state.json')
    })
    await service.prepareForSession(
      'kimi',
      { kind: 'wsl', distro: 'Ubuntu-26.04', distroId: 'reg-1' },
      { state: 'available', harness: 'kimi' } as unknown as HarnessDetectionResult
    )
    expect(files.get('/home/u/.kimi-code/config.toml')).toContain(
      'icode-managed-kimi-hooks'
    )
  })
})

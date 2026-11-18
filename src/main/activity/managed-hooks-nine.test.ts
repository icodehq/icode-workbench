import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WslCommandRunner, type WslProcessLauncher } from '../wsl/exec'
import {
  ensureManagedHookScript,
  installManagedHooksForProvider,
  removeManagedHooksForProvider,
  type ManagedHookInstallOptions
} from './managed-hooks'
import {
  installLocalAntigravityHooks,
  removeLocalAntigravityHooks
} from './managed-hooks-antigravity'
import {
  installGuestJsoncHooks,
  installLocalJsoncHooks,
  removeLocalJsoncHooks
} from './managed-hooks-jsonc'
import {
  installLocalMuseHooks,
  removeLocalMuseHooks
} from './managed-hooks-muse'
import {
  installLocalKiroHooks,
  removeLocalKiroHooks
} from './managed-hooks-kiro'
import {
  installLocalJcodeHooks,
  localJcodeStatus,
  removeLocalJcodeHooks
} from './managed-hooks-jcode'
import {
  installGuestDshHooks,
  installLocalDshHooks,
  removeLocalDshHooks
} from './managed-hooks-dsh'
import {
  installGuestHermesHooks,
  installLocalHermesHooks,
  removeLocalHermesHooks
} from './managed-hooks-hermes'
import { installGuestMuseHooks } from './managed-hooks-muse'
import { installGuestJcodeHooks } from './managed-hooks-jcode'
import { installGuestKiroHooks } from './managed-hooks-kiro'
import { ManagedHooksService } from './managed-hooks-service'

const roots: string[] = []

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'icode-managed-nine-'))
  roots.push(base)
  return base
}

function options(base = root(), env: NodeJS.ProcessEnv = {}): ManagedHookInstallOptions {
  return {
    directory: join(base, 'agent-hooks'),
    home: join(base, 'home'),
    execPath: process.execPath,
    electronRunAsNode: false,
    platform: 'linux',
    env
  }
}

function text(path: string): string {
  return readFileSync(path, 'utf8')
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function runtime(opts: ManagedHookInstallOptions) {
  return ensureManagedHookScript(opts)
}

describe('Command Code', () => {
  it('installs tool matchers and Stop without touching user hooks', () => {
    const opts = options()
    const path = join(opts.home, '.commandcode', 'settings.json')
    write(path, JSON.stringify({ hooks: { Stop: [{ command: 'user-stop' }] }, theme: 'dark' }))
    expect(installManagedHooksForProvider('command-code', opts).state).toBe('installed')
    const config = JSON.parse(text(path)) as {
      hooks: Record<string, Array<Record<string, unknown>>>
      theme: string
    }
    expect(config.theme).toBe('dark')
    expect(config.hooks.Stop?.map((entry) => entry.command)).toContain('user-stop')
    expect(config.hooks.PreToolUse?.[0]).toMatchObject({ matcher: '.*' })
    expect(removeManagedHooksForProvider('command-code', opts).state).toBe('not-installed')
    expect(JSON.parse(text(path)).hooks.Stop).toEqual([{ command: 'user-stop' }])
  })
})

describe('Antigravity bundle', () => {
  it('installs direct and nested definitions into its own bundle', () => {
    const opts = options()
    const path = join(opts.home, '.gemini', 'config', 'hooks.json')
    write(path, JSON.stringify({ other: { Stop: [{ command: 'user' }] } }))
    const rt = runtime(opts)
    expect(installLocalAntigravityHooks(opts, rt).state).toBe('installed')
    const config = JSON.parse(text(path)) as Record<string, any>
    expect(config.other.Stop).toEqual([{ command: 'user' }])
    expect(config['icode-status'].PreInvocation[0]).toMatchObject({ type: 'command' })
    expect(config['icode-status'].PreToolUse[0]).toMatchObject({ matcher: '*' })
    expect(config['icode-status'].PreToolUse[0].hooks[0].command).toContain("'ask'")
    expect(config['icode-status'].Stop[0].command).toContain("'stop'")
    expect(removeLocalAntigravityHooks(opts, rt).state).toBe('not-installed')
    expect(JSON.parse(text(path))).toEqual({ other: { Stop: [{ command: 'user' }] } })
  })
})

describe('Devin and ZCode JSONC', () => {
  it('preserves Devin comments and user hooks', () => {
    const opts = options()
    const path = join(opts.home, '.config', 'devin', 'config.json')
    const original = `{
  // keep this comment
  "hooks": {
    "UserPromptSubmit": [{ "command": "user-prompt" }]
  }
}
`
    write(path, original)
    const rt = runtime(opts)
    expect(installLocalJsoncHooks('devin', opts, rt).state).toBe('installed')
    const installed = text(path)
    expect(installed).toContain('// keep this comment')
    expect(installed).toContain('user-prompt')
    const config = JSON.parse(installed.replace(/^.*\/\/.*$/gmu, '')) as {
      hooks: Record<string, unknown[]>
    }
    expect(config.hooks.UserPromptSubmit).toHaveLength(2)
    expect(config.hooks.PermissionRequest).toBeTruthy()
    expect(removeLocalJsoncHooks('devin', opts, rt).state).toBe('not-installed')
    expect(text(path)).toContain('// keep this comment')
    expect(text(path)).toContain('user-prompt')
  })

  it('enables ZCode hooks and preserves user entries', () => {
    const opts = options()
    const path = join(opts.home, '.zcode', 'cli', 'config.json')
    write(
      path,
      JSON.stringify({ theme: 'dark', hooks: { enabled: false, events: { Stop: [{ hooks: [{ command: 'user' }] }] } } })
    )
    const rt = runtime(opts)
    expect(installLocalJsoncHooks('zcode', opts, rt).state).toBe('installed')
    const config = JSON.parse(text(path)) as {
      theme: string
      hooks: { enabled: boolean; events: Record<string, unknown[]> }
    }
    expect(config.theme).toBe('dark')
    expect(config.hooks.enabled).toBe(true)
    expect(config.hooks.events.Stop).toHaveLength(2)
    expect(removeLocalJsoncHooks('zcode', opts, rt).state).toBe('not-installed')
    const removed = JSON.parse(text(path)) as {
      hooks: { enabled: boolean; events: Record<string, unknown[]> }
    }
    expect(removed.hooks.enabled).toBe(true)
    expect(removed.hooks.events.Stop).toHaveLength(1)
  })
})

describe('Muse managed hooks file', () => {
  it('sets the pointer and env allowlist, then removes only its names', () => {
    const opts = options()
    const path = join(opts.home, '.config', 'muse', 'settings.json')
    write(
      path,
      JSON.stringify({
        schema_version: 1,
        theme: 'dark',
        managed_hooks_env_vars: ['USERPROFILE']
      })
    )
    const rt = runtime(opts)
    expect(installLocalMuseHooks(opts, rt).state).toBe('installed')
    const settings = JSON.parse(text(path)) as {
      theme: string
      managed_hooks_path: string
      managed_hooks_env_vars: string[]
    }
    expect(settings.theme).toBe('dark')
    expect(settings.managed_hooks_path).toBe(join(opts.directory, 'muse-hooks.json'))
    expect(settings.managed_hooks_env_vars).toEqual(
      expect.arrayContaining(['USERPROFILE', 'ICODE_ACTIVITY_SOCKET', 'ICODE_SESSION_ID', 'ICODE_SESSION_INCARNATION'])
    )
    const hooks = JSON.parse(text(join(opts.directory, 'muse-hooks.json'))) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
    }
    expect(hooks.hooks.Interrupt?.[0]?.hooks[0]?.async).toBe(true)
    expect(hooks.hooks.PermissionRequest?.[0]?.hooks[0]?.command).toContain('muse')
    expect(removeLocalMuseHooks(opts, rt).state).toBe('not-installed')
    const removed = JSON.parse(text(path)) as {
      managed_hooks_path?: string
      managed_hooks_env_vars?: string[]
    }
    expect(removed.managed_hooks_path).toBeUndefined()
    expect(removed.managed_hooks_env_vars).toEqual(['USERPROFILE'])
    expect(() => readFileSync(join(opts.directory, 'muse-hooks.json'))).toThrow()
  })
})

describe('Kiro standalone hooks', () => {
  it('writes v1 list hooks and removes the file when it owned all entries', () => {
    const opts = options()
    const path = join(opts.home, '.kiro', 'hooks', 'icode-agent-status.json')
    const rt = runtime(opts)
    expect(installLocalKiroHooks(opts, rt).state).toBe('installed')
    const config = JSON.parse(text(path)) as {
      version: string
      hooks: Array<Record<string, any>>
    }
    expect(config.version).toBe('v1')
    expect(config.hooks.find((entry) => entry.trigger === 'PreToolUse')).toMatchObject({
      matcher: '*',
      action: { type: 'command' }
    })
    expect(config.hooks.find((entry) => entry.trigger === 'SessionEnd')).toBeTruthy()
    expect(removeLocalKiroHooks(opts, rt).state).toBe('not-installed')
    expect(() => readFileSync(path)).toThrow()
  })

  it('keeps user hooks in the standalone file', () => {
    const opts = options()
    const path = join(opts.home, '.kiro', 'hooks', 'icode-agent-status.json')
    write(
      path,
      JSON.stringify({
        version: 'v1',
        hooks: [{ name: 'user', trigger: 'Stop', action: { type: 'command', command: 'user.sh' } }]
      })
    )
    const rt = runtime(opts)
    installLocalKiroHooks(opts, rt)
    const config = JSON.parse(text(path)) as { hooks: Array<Record<string, unknown>> }
    expect(config.hooks.some((entry) => entry.name === 'user')).toBe(true)
    removeLocalKiroHooks(opts, rt)
    const removed = JSON.parse(text(path)) as { hooks: Array<Record<string, unknown>> }
    expect(removed.hooks).toHaveLength(1)
    expect(removed.hooks[0]?.name).toBe('user')
  })
})

describe('JCode TOML hooks', () => {
  it('appends after user gates and restores the original byte-for-byte', () => {
    const opts = options()
    const path = join(opts.home, '.jcode', 'config.toml')
    const original = `model = "x"

[hooks]
pre_tool = ["user-gate.sh"]

[ui]
theme = "dark"
`
    write(path, original)
    const rt = runtime(opts)
    expect(installLocalJcodeHooks(opts, rt).state).toBe('installed')
    const installed = text(path)
    expect(installed).toContain('pre_tool = ["user-gate.sh", ')
    expect(installed).toContain('turn_start = [')
    expect(installed.indexOf('turn_start')).toBeLessThan(installed.indexOf('pre_tool'))
    expect(installed).toContain('[ui]')
    expect(removeLocalJcodeHooks(opts, rt).state).toBe('not-installed')
    expect(text(path)).toBe(original)
  })

  it('edits several user arrays without reusing stale offsets', () => {
    const opts = options()
    const path = join(opts.home, '.jcode', 'config.toml')
    const original = '[hooks]\npre_tool = ["a.sh"]\npost_tool = ["b.sh"]\nturn_end = ["c.sh"]\n'
    write(path, original)
    const rt = runtime(opts)
    expect(installLocalJcodeHooks(opts, rt).state).toBe('installed')
    const installed = text(path)
    expect(installed).toContain('pre_tool = ["a.sh", ')
    expect(installed).toContain('post_tool = ["b.sh", ')
    expect(installed).toContain('turn_end = ["c.sh", ')
    removeLocalJcodeHooks(opts, rt)
    expect(text(path)).toBe(original)
  })

  it('keeps a user-owned scalar hook and reports partial', () => {
    const opts = options()
    const path = join(opts.home, '.jcode', 'config.toml')
    write(path, '[hooks]\nturn_end = "user.sh"\n')
    const rt = runtime(opts)
    const status = installLocalJcodeHooks(opts, rt)
    expect(status.state).toBe('partial')
    expect(status.detail).toContain('turn_end')
    expect(text(path)).toContain('turn_end = "user.sh"')
    expect(localJcodeStatus(opts, rt).state).toBe('partial')
  })
})

describe('DSH patch and hooks file', () => {
  it('adds the insert row and removes it with the managed file', () => {
    const opts = options()
    const rt = runtime(opts)
    expect(installLocalDshHooks(opts, rt).state).toBe('installed')
    const patch = text(join(opts.home, '.dsh', 'cordis.patch.yml'))
    expect(patch).toContain('@deepseek-ai/dsh-hooks-claude-code')
    expect(patch).toContain(join(opts.directory, 'dsh-hooks.json'))
    const hooks = JSON.parse(text(join(opts.directory, 'dsh-hooks.json'))) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
    }
    expect(hooks.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toContain('dsh')
    expect(removeLocalDshHooks(opts, rt).state).toBe('not-installed')
    expect(text(join(opts.home, '.dsh', 'cordis.patch.yml'))).toBe('[]\n')
    expect(() => readFileSync(join(opts.directory, 'dsh-hooks.json'))).toThrow()
  })

  it('refuses a nonempty flow-style patch', () => {
    const opts = options()
    write(join(opts.home, '.dsh', 'cordis.patch.yml'), '[foo, bar]\n')
    const status = installLocalDshHooks(opts, runtime(opts))
    expect(status.state).toBe('failed')
    expect(text(join(opts.home, '.dsh', 'cordis.patch.yml'))).toBe('[foo, bar]\n')
  })

  it('replaces its row in place instead of moving it past later rows', () => {
    const opts = options()
    const patchPath = join(opts.home, '.dsh', 'cordis.patch.yml')
    write(
      patchPath,
      '# >>> icode-managed-dsh-hooks (managed by iCode; do not edit) >>>\n- insert:\n    - id: icode-agent-hooks\n      name: old\n      config:\n        configPath: old.json\n# <<< icode-managed-dsh-hooks <<<\n- insert:\n    - id: user-row\n'
    )
    installLocalDshHooks(opts, runtime(opts))
    const installed = text(patchPath)
    expect(installed.indexOf('icode-agent-hooks')).toBeLessThan(installed.indexOf('user-row'))
    expect(installed).toContain('@deepseek-ai/dsh-hooks-claude-code')
    expect(installed).not.toContain('configPath: old.json')
  })
})

describe('Hermes plugin and YAML', () => {
  it('enables the plugin, allowlists iCode env, and preserves comments', () => {
    const base = root()
    const hermesHome = join(base, 'hermes')
    const opts = options(base, { HERMES_HOME: hermesHome })
    const configPath = join(hermesHome, 'config.yaml')
    write(
      configPath,
      `# user config\nplugins:\n  enabled:\n    - other\n  disabled:\n    - icode-status\nterminal:\n  client_env_passthrough:\n    - USERPROFILE\n`
    )
    expect(installLocalHermesHooks(opts).state).toBe('installed')
    const config = text(configPath)
    expect(config).toContain('# user config')
    expect(config).toContain('- other')
    expect(config).toContain('- icode-status')
    expect(config).toContain('- ICODE_ACTIVITY_SOCKET')
    const init = text(join(hermesHome, 'plugins', 'icode-status', '__init__.py'))
    expect(init).toContain('Managed by iCode')
    expect(init).toContain('register_hook')
    expect(init).toContain('AF_UNIX')
    expect(removeLocalHermesHooks(opts).state).toBe('not-installed')
    const removed = text(configPath)
    expect(removed).toContain('- other')
    expect(removed).not.toContain('- icode-status')
    expect(removed).toContain('- USERPROFILE')
    expect(removed).not.toContain('- ICODE_ACTIVITY_SOCKET')
    expect(() => readFileSync(join(hermesHome, 'plugins', 'icode-status', '__init__.py'))).toThrow()
  })
})

describe('guest installers', () => {
  function guestFiles(): {
    files: Map<string, string>
    runner: WslCommandRunner
  } {
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
      if (script === 'rm -f -- "$1"') {
        files.delete(path)
        return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
      }
      if (script === 'rm -rf -- "$1"') {
        for (const key of [...files.keys()]) {
          if (key.startsWith(`${path}/`)) files.delete(key)
        }
        return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
      }
      return { code: 1, signal: null, stdout: '', stderr: 'unexpected', timedOut: false }
    }
    return { files, runner: new WslCommandRunner({ launcher, platform: 'win32' }) }
  }

  function guestOptions(
    runner: WslCommandRunner,
    provider: Parameters<typeof installGuestJsoncHooks>[0]['provider']
  ) {
    return {
      runner,
      distro: 'Ubuntu-26.04',
      provider,
      guestHome: '/home/u',
      guestExecutablePath: '/mnt/c/iCode/icode.exe',
      scriptPath: 'C:\\iCode\\agent-hooks\\icode-managed-hook.cjs',
      activitySocket: '\\\\.\\pipe\\icode-activity-test',
      electronRunAsNode: true,
      signal: undefined
    }
  }

  it('installs Devin as a guest JSONC config with an interop command', async () => {
    const { files, runner } = guestFiles()
    const status = await installGuestJsoncHooks(guestOptions(runner, 'devin'))
    expect(status.state).toBe('installed')
    const config = JSON.parse(files.get('/home/u/.config/devin/config.json') ?? '{}') as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(config.hooks.PermissionRequest?.[0]?.hooks[0]?.command).toContain('WSLENV')
    expect(config.hooks.PermissionRequest?.[0]?.hooks[0]?.command).toContain('/mnt/c/iCode/icode.exe')
  })

  it('installs Muse with a guest hooks-file pointer', async () => {
    const { files, runner } = guestFiles()
    const status = await installGuestMuseHooks(guestOptions(runner, 'muse'))
    expect(status.state).toBe('installed')
    const settings = JSON.parse(files.get('/home/u/.config/muse/settings.json') ?? '{}') as {
      managed_hooks_path: string
    }
    expect(settings.managed_hooks_path).toBe('/home/u/.icode/agent-hooks/muse-hooks.json')
    expect(files.get('/home/u/.icode/agent-hooks/muse-hooks.json')).toContain('WSLENV')
  })

  it('installs JCode, Kiro, DSH and Hermes under the guest home', async () => {
    const { files, runner } = guestFiles()
    expect((await installGuestJcodeHooks(guestOptions(runner, 'jcode'))).state).toBe(
      'installed'
    )
    expect(files.get('/home/u/.jcode/config.toml')).toContain('turn_start = [')
    expect(files.get('/home/u/.jcode/config.toml')).toContain(
      "sh '/home/u/.icode/agent-hooks/icode-managed-hook-jcode-turn_start.sh'"
    )
    expect(
      files.get('/home/u/.icode/agent-hooks/icode-managed-hook-jcode-turn_start.sh')
    ).toContain("printf '%s' \"${JCODE_HOOK_PAYLOAD-}\"")
    expect(
      files.get('/home/u/.icode/agent-hooks/icode-managed-hook-jcode-turn_start.sh')
    ).toContain('WSLENV=')
    expect((await installGuestKiroHooks(guestOptions(runner, 'kiro'))).state).toBe(
      'installed'
    )
    expect(files.get('/home/u/.kiro/hooks/icode-agent-status.json')).toContain('SessionEnd')
    expect((await installGuestDshHooks(guestOptions(runner, 'dsh'))).state).toBe(
      'installed'
    )
    expect(files.get('/home/u/.dsh/cordis.patch.yml')).toContain(
      '/home/u/.icode/agent-hooks/dsh-hooks.json'
    )
    expect((await installGuestHermesHooks(guestOptions(runner, 'hermes'))).state).toBe(
      'installed'
    )
    const init = files.get('/home/u/.hermes/plugins/icode-status/__init__.py') ?? ''
    expect(init).toContain('subprocess.run')
    expect(init).toContain('WSLENV')
    const config = files.get('/home/u/.hermes/config.yaml') ?? ''
    expect(config).toContain('- icode-status')
    expect(config).toContain('- ICODE_ACTIVITY_SOCKET')
  })
})

describe('service dispatch across all formats', () => {
  it('installs and removes every provider through the shared setting', async () => {
    const base = root()
    const env = {
      HERMES_HOME: join(base, 'hermes'),
      DSH_HOME: join(base, 'dsh-home'),
      JCODE_HOME: join(base, 'jcode-home'),
      KIRO_HOME: join(base, 'kiro-home')
    }
    let enabled = true
    const service = new ManagedHooksService({
      directory: join(base, 'agent-hooks'),
      home: join(base, 'home'),
      execPath: process.execPath,
      electronRunAsNode: false,
      platform: 'linux',
      env,
      loadEnabled: () => enabled,
      saveEnabled: (next) => {
        enabled = next
        return true
      },
      isAvailable: () => true
    })
    const state = service.refresh()
    expect(state.providers).toHaveLength(21)
    const failed = state.providers.filter((provider) => provider.state === 'failed')
    expect(failed).toEqual([])
    expect(state.providers.find((provider) => provider.provider === 'hermes')?.state).toBe(
      'installed'
    )
    expect(state.providers.find((provider) => provider.provider === 'jcode')?.state).toBe(
      'installed'
    )
    expect(state.providers.find((provider) => provider.provider === 'dsh')?.state).toBe(
      'installed'
    )
    await service.setEnabled(false)
    const disabled = service.getState()
    expect(disabled.providers.every((provider) => provider.state === 'disabled')).toBe(true)
    expect(text(join(base, 'jcode-home', 'config.toml'))).not.toContain('icode-managed-hook')
    expect(text(join(base, 'dsh-home', 'cordis.patch.yml'))).toBe('[]\n')
    expect(text(join(base, 'hermes', 'config.yaml'))).not.toContain('- icode-status')
  })
})

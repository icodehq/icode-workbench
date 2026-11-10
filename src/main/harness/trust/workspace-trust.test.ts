import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionTarget } from '../../../shared/domain/repository'
import { WslCommandRunner, type WslProcessLauncher } from '../../wsl/exec'
import { createWorkspaceTrust } from './workspace-trust'

const roots: string[] = []
const WSL: ExecutionTarget = {
  kind: 'wsl',
  distro: 'Ubuntu-26.04',
  distroId: 'reg-1'
}
const LOCAL: ExecutionTarget = { kind: 'local' }

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'icode-trust-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function localService(home: string, platform: NodeJS.Platform = 'linux') {
  return createWorkspaceTrust({
    runner: {} as WslCommandRunner,
    localHome: home,
    readGuestHome: async () => null,
    platform
  })
}

function guestService(home: string, files: Map<string, string>) {
  let calls = 0
  let homeReads = 0
  const launcher: WslProcessLauncher = async (spec) => {
    calls += 1
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
    if (script.includes('tmp="$1.icode-tmp-$$"')) {
      files.set(path, typeof spec.stdin === 'string' ? spec.stdin : (spec.stdin?.toString('utf8') ?? ''))
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    return { code: 1, signal: null, stdout: '', stderr: 'unexpected guest command', timedOut: false }
  }
  const trust = createWorkspaceTrust({
    runner: new WslCommandRunner({ launcher, platform: 'win32' }),
    localHome: home,
    readGuestHome: async () => {
      homeReads += 1
      return '/home/u'
    },
    platform: 'win32'
  })
  return {
    trust,
    calls: () => calls,
    homeReads: () => homeReads
  }
}

describe('Claude workspace trust', () => {
  it('adds trust without losing an existing project entry', async () => {
    const home = tempHome()
    const config = join(home, '.claude.json')
    writeFileSync(
      config,
      JSON.stringify(
        {
          projects: {
            '/other': { hasTrustDialogAccepted: true, allowedTools: ['Read'] }
          },
          top: 'keep'
        },
        null,
        2
      )
    )
    const trust = localService(home)
    const path = join(home, 'worktrees', 'repo', 'ses')

    await expect(trust.prepare({ harness: 'claude', target: LOCAL, worktreePath: path })).resolves.toEqual({
      status: 'trusted'
    })
    await expect(trust.prepare({ harness: 'claude', target: LOCAL, worktreePath: path })).resolves.toEqual({
      status: 'already-trusted'
    })
    const data = JSON.parse(readFileSync(config, 'utf8'))
    expect(data.top).toBe('keep')
    expect(data.projects['/other']).toMatchObject({
      hasTrustDialogAccepted: true,
      allowedTools: ['Read']
    })
    expect(data.projects[path]).toEqual({ hasTrustDialogAccepted: true })
  })

  it('normalizes a Windows worktree key to the harness spelling', async () => {
    const home = tempHome()
    const trust = localService(home, 'win32')

    await trust.prepare({
      harness: 'claude',
      target: LOCAL,
      worktreePath: 'C:\\Users\\you\\icode\\worktrees\\repo\\ses'
    })

    const data = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(data.projects['C:/Users/you/icode/worktrees/repo/ses']).toEqual({
      hasTrustDialogAccepted: true
    })
  })

  it('refuses malformed JSON instead of overwriting it', async () => {
    const home = tempHome()
    const config = join(home, '.claude.json')
    writeFileSync(config, '{ not json')
    const trust = localService(home)

    const result = await trust.prepare({
      harness: 'claude',
      target: LOCAL,
      worktreePath: join(home, 'worktree')
    })
    expect(result.status).toBe('failed')
    expect(readFileSync(config, 'utf8')).toBe('{ not json')
  })

  it('removes only the trust marker on cleanup', async () => {
    const home = tempHome()
    const config = join(home, '.claude.json')
    const path = '/worktrees/repo/ses'
    writeFileSync(
      config,
      JSON.stringify(
        {
          projects: {
            [path]: { hasTrustDialogAccepted: true, allowedTools: ['Read'] }
          }
        },
        null,
        2
      )
    )
    const trust = localService(home)
    await trust.remove({ harness: 'claude', target: LOCAL, worktreePath: path })
    const data = JSON.parse(readFileSync(config, 'utf8'))
    expect(data.projects[path]).toEqual({ allowedTools: ['Read'] })
  })
})

describe('Codex workspace trust', () => {
  it('adds a project table while preserving comments and other tables', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.codex'), { recursive: true })
    const config = join(home, '.codex', 'config.toml')
    writeFileSync(
      config,
      ['# keep this comment', '[model]', 'name = "o3"', '', '[projects.\'/other\']', 'trust_level = "trusted"', ''].join('\n')
    )
    const trust = localService(home)

    await expect(
      trust.prepare({ harness: 'codex', target: LOCAL, worktreePath: '/worktrees/repo/ses' })
    ).resolves.toEqual({ status: 'trusted' })
    const text = readFileSync(config, 'utf8')
    expect(text).toContain('# keep this comment')
    expect(text).toContain('[model]')
    expect(text).toContain("name = \"o3\"")
    expect(text).toContain("[projects.'/other']")
    expect(text).toContain("[projects.'/worktrees/repo/ses']")
    expect(text).toContain('trust_level = "trusted"')
  })

  it('seeds the ordinary Codex project key on Windows', async () => {
    const home = tempHome()
    const trust = localService(home, 'win32')
    const path = 'C:\\Users\\you\\icode\\worktrees\\repo\\ses'
    await trust.prepare({ harness: 'codex', target: LOCAL, worktreePath: path })
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(text).toContain("[projects.'C:\\Users\\you\\icode\\worktrees\\repo\\ses']")
    // The extended prefix is not Codex's trust key and must not be invented.
    expect(text).not.toContain('\\\\?\\')
  })

  it('updates an existing project table and cleans up', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.codex'), { recursive: true })
    const config = join(home, '.codex', 'config.toml')
    writeFileSync(
      config,
      ['[projects.\'/worktrees/repo/ses\']', 'trust_level = "untrusted"', '', '[other]', 'keep = true', ''].join('\n')
    )
    const trust = localService(home)
    await trust.prepare({ harness: 'codex', target: LOCAL, worktreePath: '/worktrees/repo/ses' })
    expect(readFileSync(config, 'utf8')).toContain('trust_level = "trusted"')
    await trust.remove({ harness: 'codex', target: LOCAL, worktreePath: '/worktrees/repo/ses' })
    const text = readFileSync(config, 'utf8')
    expect(text).not.toContain('trust_level = "trusted"')
    expect(text).toContain('[other]')
    expect(text).toContain('keep = true')
  })
})

describe('target routing and unsupported harnesses', () => {
  it('writes a WSL config through the guest runner, not the local home', async () => {
    const home = tempHome()
    const files = new Map<string, string>()
    const { trust } = guestService(home, files)
    const path = '/home/u/.icode/worktrees/scope/repo/ses'

    await expect(trust.prepare({ harness: 'claude', target: WSL, worktreePath: path })).resolves.toEqual({
      status: 'trusted'
    })
    const guestConfig = files.get('/home/u/.claude.json')
    expect(guestConfig).toContain(path)
    expect(guestConfig).toContain('"hasTrustDialogAccepted": true')
    expect(() => readFileSync(join(home, '.claude.json'))).toThrow()
  })

  it('uses one read and one write spawn when the home reader is supplied', async () => {
    const home = tempHome()
    const files = new Map<string, string>()
    const service = guestService(home, files)
    const path = '/home/u/.icode/worktrees/scope/repo/ses'

    await service.trust.prepare({ harness: 'claude', target: WSL, worktreePath: path })
    expect(service.calls()).toBe(2)
    expect(service.homeReads()).toBe(1)

    // A second prepare finds the entry already trusted: read only.
    await service.trust.prepare({ harness: 'claude', target: WSL, worktreePath: path })
    expect(service.calls()).toBe(3)
    expect(service.homeReads()).toBe(2)
  })

  it('has no config write for OpenCode or Shell', async () => {
    const home = tempHome()
    const trust = localService(home)
    await expect(
      trust.prepare({ harness: 'opencode', target: LOCAL, worktreePath: '/worktrees/opencode' })
    ).resolves.toEqual({ status: 'unsupported' })
    await expect(
      trust.prepare({ harness: 'shell', target: LOCAL, worktreePath: '/worktrees/shell' })
    ).resolves.toEqual({ status: 'unsupported' })
    expect(() => readFileSync(join(home, '.claude.json'))).toThrow()
  })
})

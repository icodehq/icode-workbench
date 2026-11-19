import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  LOCAL_EXECUTION_TARGET,
  type ExecutionTarget
} from '../../shared/domain/repository'
import type {
  ProviderLaunchPlan,
  ProviderSeedSpec
} from '../../shared/domain/provider-recipes'
import { makeTempRoot, type TempRoot } from '../persistence/persistence-test-fixtures'
import {
  ProviderDeliveryPathError,
  materializePlan,
  pruneProviderRuntime,
  removeProviderRuntime
} from './provider-materializer'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempRoot(): TempRoot {
  const root = makeTempRoot('icode-provider-materializer-')
  cleanups.push(root.cleanup)
  return root
}

function envPlan(): ProviderLaunchPlan {
  return {
    args: ['--model', 'model'],
    env: { A: '1' },
    delivery: { kind: 'env' }
  }
}

function filePlan(contents = '{"key":"value"}'): ProviderLaunchPlan {
  return {
    args: ['--flag'],
    env: { A: '1' },
    delivery: {
      kind: 'file',
      pathEnv: 'ICODE_TEST_FILE',
      pathArgs: ['--config', '{path}'],
      relativePath: 'config/provider.json',
      contents,
      format: 'json'
    }
  }
}

function dirPlan(): ProviderLaunchPlan {
  return {
    args: [],
    env: {},
    delivery: {
      kind: 'dir',
      pathEnv: 'ICODE_TEST_HOME',
      files: [{ relativePath: 'models.json', contents: '{"providers":{}}' }]
    }
  }
}

describe('provider materializer', () => {
  it('passes env-only plans through without touching disk', () => {
    const root = tempRoot()
    const result = materializePlan({
      userDataDir: root.dir,
      providerId: 'prv_env',
      plan: envPlan(),
      target: LOCAL_EXECUTION_TARGET
    })
    expect(result).toEqual({ args: ['--model', 'model'], env: { A: '1' } })
    expect(existsSync(join(root.dir, 'provider-runtime'))).toBe(false)
  })

  it('writes a content-addressed file and fills its path into env and args', () => {
    const root = tempRoot()
    const result = materializePlan({
      userDataDir: root.dir,
      providerId: 'prv_file',
      plan: filePlan(),
      target: LOCAL_EXECUTION_TARGET
    })
    const path = result.env.ICODE_TEST_FILE!
    expect(path).toContain(join('provider-runtime', 'prv_file'))
    expect(readFileSync(path, 'utf8')).toBe('{"key":"value"}')
    expect(result.args).toEqual(['--flag', '--config', path])

    const other = materializePlan({
      userDataDir: root.dir,
      providerId: 'prv_file',
      plan: filePlan('{"key":"changed"}'),
      target: LOCAL_EXECUTION_TARGET
    })
    expect(other.env.ICODE_TEST_FILE).not.toBe(path)
    expect(readFileSync(path, 'utf8')).toBe('{"key":"value"}')
  })

  it('keeps a stable home for directory delivery and marks it as generated', () => {
    const root = tempRoot()
    const first = materializePlan({
      userDataDir: root.dir,
      providerId: 'prv_dir',
      plan: dirPlan(),
      target: LOCAL_EXECUTION_TARGET
    })
    const second = materializePlan({
      userDataDir: root.dir,
      providerId: 'prv_dir',
      plan: dirPlan(),
      target: LOCAL_EXECUTION_TARGET
    })
    expect(first.env.ICODE_TEST_HOME).toBe(second.env.ICODE_TEST_HOME)
    const home = first.env.ICODE_TEST_HOME!
    expect(readFileSync(join(home, 'models.json'), 'utf8')).toBe('{"providers":{}}')
    expect(existsSync(join(home, '.icode-generated'))).toBe(true)
  })

  it('merges an existing JSON config instead of replacing it', () => {
    const root = tempRoot()
    const seedDir = join(root.dir, '.copilot')
    mkdirSync(seedDir, { recursive: true })
    writeFileSync(
      join(seedDir, 'providers.json'),
      JSON.stringify({
        providers: [{ id: 'existing', type: 'openai', baseUrl: 'https://old' }],
        models: [{ id: 'old-model', provider: 'existing' }]
      })
    )
    const plan = filePlan(
      JSON.stringify({
        providers: [{ id: 'icode', type: 'openai', baseUrl: 'https://new' }],
        models: [{ id: 'new-model', provider: 'icode' }]
      })
    )
    const result = materializePlan({
      userDataDir: root.dir,
      homeDir: root.dir,
      env: {},
      providerId: 'prv_merge',
      plan,
      seed: { homePaths: [['.copilot', 'providers.json']] },
      target: LOCAL_EXECUTION_TARGET
    })
    const merged = JSON.parse(readFileSync(result.env.ICODE_TEST_FILE!, 'utf8')) as {
      providers: Array<{ id: string }>
      models: Array<{ id: string }>
    }
    expect(merged.providers.map((entry) => entry.id)).toEqual([
      'existing',
      'icode'
    ])
    expect(merged.models.map((entry) => entry.id)).toEqual(['old-model', 'new-model'])
  })

  it('merges an existing YAML config', () => {
    const root = tempRoot()
    const seedDir = join(root.dir, '.continue')
    mkdirSync(seedDir, { recursive: true })
    writeFileSync(
      join(seedDir, 'config.yaml'),
      'models:\n  - name: existing\n    provider: openai\n    model: old\n'
    )
    const plan: ProviderLaunchPlan = {
      args: [],
      env: {},
      delivery: {
        kind: 'file',
        pathArgs: ['--config', '{path}'],
        relativePath: 'config.yaml',
        contents:
          'models:\n  - name: iCode\n    provider: openai\n    model: new\n',
        format: 'yaml'
      }
    }
    const result = materializePlan({
      userDataDir: root.dir,
      homeDir: root.dir,
      env: {},
      providerId: 'prv_yaml',
      plan,
      seed: { homePaths: [['.continue', 'config.yaml']] },
      target: LOCAL_EXECUTION_TARGET
    })
    const merged = readFileSync(result.args[1]!, 'utf8')
    expect(merged).toContain('name: existing')
    expect(merged).toContain('name: iCode')
  })

  it('merges a directory target and copies seed files', () => {
    const root = tempRoot()
    const seedDir = join(root.dir, '.pi', 'agent')
    mkdirSync(seedDir, { recursive: true })
    writeFileSync(
      join(seedDir, 'models.json'),
      JSON.stringify({ providers: { existing: { baseUrl: 'https://old' } } })
    )
    writeFileSync(join(seedDir, 'auth.json'), '{"token":"keep"}')

    const plan: ProviderLaunchPlan = {
      args: [],
      env: {},
      delivery: {
        kind: 'dir',
        pathEnv: 'PI_CODING_AGENT_DIR',
        files: [
          {
            relativePath: 'models.json',
            contents: JSON.stringify({
              providers: { icode: { baseUrl: 'https://new' } }
            })
          }
        ]
      }
    }
    const seed: ProviderSeedSpec = {
      homePaths: [['.pi', 'agent', 'models.json']],
      target: 'models.json',
      copy: [
        {
          homePaths: [['.pi', 'agent', 'auth.json']],
          target: 'auth.json'
        }
      ]
    }
    const result = materializePlan({
      userDataDir: root.dir,
      homeDir: root.dir,
      env: {},
      providerId: 'prv_dir_seed',
      plan,
      seed,
      target: LOCAL_EXECUTION_TARGET
    })
    const home = result.env.PI_CODING_AGENT_DIR!
    const models = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8')) as {
      providers: Record<string, unknown>
    }
    expect(Object.keys(models.providers)).toEqual(['existing', 'icode'])
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{"token":"keep"}')
  })

  it.runIf(process.platform === 'win32')(
    'maps generated paths into /mnt for a WSL target',
    () => {
      const root = tempRoot()
      const target: ExecutionTarget = {
        kind: 'wsl',
        distro: 'Ubuntu',
        distroId: null
      }
      const result = materializePlan({
        userDataDir: root.dir,
        providerId: 'prv_wsl',
        plan: dirPlan(),
        target
      })
      const mapped = result.env.ICODE_TEST_HOME!
      expect(mapped.startsWith('/mnt/')).toBe(true)
      expect(existsSync(join(root.dir, 'provider-runtime', 'prv_wsl', 'home'))).toBe(
        true
      )
    }
  )

  it('refuses a WSL delivery under a non-drive userData path', () => {
    const target: ExecutionTarget = { kind: 'wsl', distro: 'Ubuntu', distroId: null }
    expect(() =>
      materializePlan({
        userDataDir: '\\\\server\\share\\icode',
        providerId: 'prv_unc',
        plan: filePlan(),
        target
      })
    ).toThrow(ProviderDeliveryPathError)
  })

  it('prunes stale file deliveries but never a stable home', () => {
    const root = tempRoot()
    const result = materializePlan({
      userDataDir: root.dir,
      providerId: 'prv_prune',
      plan: filePlan(),
      target: LOCAL_EXECUTION_TARGET
    })
    const filePath = result.env.ICODE_TEST_FILE!
    const fileDir = join(filePath, '..', '..')
    const old = new Date(Date.now() - 100 * 60 * 60 * 1000)
    utimesSync(fileDir, old, old)

    const homeResult = materializePlan({
      userDataDir: root.dir,
      providerId: 'prv_prune',
      plan: dirPlan(),
      target: LOCAL_EXECUTION_TARGET
    })
    const home = homeResult.env.ICODE_TEST_HOME!

    pruneProviderRuntime(root.dir, Date.now())
    expect(existsSync(filePath)).toBe(false)
    expect(existsSync(join(home, 'models.json'))).toBe(true)
  })

  it('removes generated file deliveries and a marked home', () => {
    const root = tempRoot()
    const file = materializePlan({
      userDataDir: root.dir,
      providerId: 'prv_remove',
      plan: filePlan(),
      target: LOCAL_EXECUTION_TARGET
    })
    const home = materializePlan({
      userDataDir: root.dir,
      providerId: 'prv_remove',
      plan: dirPlan(),
      target: LOCAL_EXECUTION_TARGET
    })
    expect(existsSync(file.env.ICODE_TEST_FILE!)).toBe(true)
    expect(existsSync(home.env.ICODE_TEST_HOME!)).toBe(true)

    removeProviderRuntime(root.dir, 'prv_remove')
    expect(existsSync(file.env.ICODE_TEST_FILE!)).toBe(false)
    expect(existsSync(home.env.ICODE_TEST_HOME!)).toBe(false)
    expect(readdirSync(join(root.dir, 'provider-runtime'))).not.toContain('prv_remove')
  })

  it('leaves an unmarked home alone', () => {
    const root = tempRoot()
    const home = join(root.dir, 'provider-runtime', 'prv_user', 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'keep.txt'), 'user data')

    removeProviderRuntime(root.dir, 'prv_user')
    expect(existsSync(join(home, 'keep.txt'))).toBe(true)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  materializeClaudeProviderOverlay,
  pruneClaudeProviderOverlays
} from './claude-provider-overlay'
import { makeTempRoot } from '../persistence/persistence-test-fixtures'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('Claude provider overlay fallback', () => {
  it('merges provider env into the hook overlay and is content-addressed', () => {
    const root = makeTempRoot('icode-provider-overlay-')
    cleanups.push(root.cleanup)
    const base = join(root.dir, 'hooks.json')
    writeFileSync(
      base,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node hook.cjs' }] }] },
        env: { KEEP_ME: '1' }
      })
    )
    const directory = join(root.dir, 'providers')
    const options = { baseSettingsPath: base, directory, env: { ANTHROPIC_MODEL: 'model' } }

    const first = materializeClaudeProviderOverlay(options)
    const second = materializeClaudeProviderOverlay(options)
    expect(second).toBe(first)

    const document = JSON.parse(readFileSync(first, 'utf8')) as {
      hooks?: unknown
      env?: Record<string, string>
    }
    expect(document.hooks).toBeDefined()
    expect(document.env).toEqual({ KEEP_ME: '1', ANTHROPIC_MODEL: 'model' })
    if (process.platform !== 'win32') {
      expect(statSync(first).mode & 0o777).toBe(0o600)
    }
  })

  it('prunes key-bearing overlays older than the retention window', () => {
    const root = makeTempRoot('icode-provider-prune-')
    cleanups.push(root.cleanup)
    const base = join(root.dir, 'hooks.json')
    writeFileSync(base, JSON.stringify({}))
    const directory = join(root.dir, 'providers')
    const path = materializeClaudeProviderOverlay({
      baseSettingsPath: base,
      directory,
      env: { ANTHROPIC_MODEL: 'model' }
    })

    utimesSync(path, new Date(0), new Date(0))
    pruneClaudeProviderOverlays(directory, Date.now())
    expect(existsSync(path)).toBe(false)
  })
})

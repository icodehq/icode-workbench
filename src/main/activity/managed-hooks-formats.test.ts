import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MANAGED_HOOK_FORMATS } from '../../shared/domain/managed-hook-providers'
import { MANAGED_HOOK_SCRIPT_NAME } from './managed-hooks'
import {
  GUEST_HOOK_ADAPTERS,
  LOCAL_HOOK_ADAPTERS
} from './managed-hooks-formats'
import { ManagedHooksService } from './managed-hooks-service'

const roots: string[] = []

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

describe('managed hook format adapters', () => {
  it('covers every format on both targets', () => {
    expect(Object.keys(LOCAL_HOOK_ADAPTERS).sort()).toEqual([...MANAGED_HOOK_FORMATS].sort())
    expect(Object.keys(GUEST_HOOK_ADAPTERS).sort()).toEqual([...MANAGED_HOOK_FORMATS].sort())
  })

  it('does not create the shared hook script for script-free local formats', () => {
    const base = mkdtempSync(join(tmpdir(), 'icode-managed-formats-'))
    roots.push(base)
    const directory = join(base, 'agent-hooks')
    const service = new ManagedHooksService({
      directory,
      home: join(base, 'home'),
      execPath: process.execPath,
      electronRunAsNode: false,
      platform: 'linux',
      env: {},
      loadEnabled: () => true,
      saveEnabled: () => true,
      isAvailable: (provider) => provider === 'amp' || provider === 'hermes'
    })

    service.refresh()

    expect(existsSync(join(directory, MANAGED_HOOK_SCRIPT_NAME))).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  HARNESS_CAPABILITIES,
  HARNESS_IDS,
  harnessLabel,
  isAgentHarness
} from './harness'
import {
  MANAGED_HOOK_FORMATS,
  MANAGED_HOOK_PROVIDER_IDS,
  MANAGED_HOOK_PROVIDER_METADATA,
  isManagedHookProvider,
  managedHookGuestConfigPath
} from './managed-hook-providers'
import {
  MANAGED_HOOK_PROVIDER_IDS as SCHEMA_PROVIDER_IDS,
  managedHookProviderSchema
} from '../schemas/managed-hooks'

describe('managed hook provider registry', () => {
  it('owns one unique provider list that the schema re-exports', () => {
    expect(MANAGED_HOOK_PROVIDER_IDS).toHaveLength(21)
    expect(new Set(MANAGED_HOOK_PROVIDER_IDS).size).toBe(21)
    expect(SCHEMA_PROVIDER_IDS).toBe(MANAGED_HOOK_PROVIDER_IDS)
    expect(managedHookProviderSchema.options).toEqual([...MANAGED_HOOK_PROVIDER_IDS])
  })

  it('keeps every provider a launchable agent harness with an explicit format', () => {
    for (const id of MANAGED_HOOK_PROVIDER_IDS) {
      expect(HARNESS_IDS).toContain(id)
      expect(isAgentHarness(id)).toBe(true)
      expect(isManagedHookProvider(id)).toBe(true)
      expect(MANAGED_HOOK_FORMATS).toContain(MANAGED_HOOK_PROVIDER_METADATA[id].format)
      expect(MANAGED_HOOK_PROVIDER_METADATA[id].homePath.length).toBeGreaterThan(0)
    }
    expect(isManagedHookProvider('claude')).toBe(false)
    expect(isManagedHookProvider('not-a-harness')).toBe(false)
  })

  it('uses every declared format and has no duplicate provider metadata', () => {
    const formats = new Set(
      MANAGED_HOOK_PROVIDER_IDS.map(
        (id) => MANAGED_HOOK_PROVIDER_METADATA[id].format
      )
    )
    expect([...formats].sort()).toEqual([...MANAGED_HOOK_FORMATS].sort())
    expect(Object.keys(MANAGED_HOOK_PROVIDER_METADATA)).toEqual([
      ...MANAGED_HOOK_PROVIDER_IDS
    ])
  })

  it('derives hook capability from the registry, plus Claude native hooks', () => {
    for (const id of MANAGED_HOOK_PROVIDER_IDS) {
      expect(HARNESS_CAPABILITIES[id].activity.hook).toBe(true)
      expect(harnessLabel(id).length).toBeGreaterThan(0)
    }
    const hookHarnesses = HARNESS_IDS.filter(
      (id) => HARNESS_CAPABILITIES[id].activity.hook
    )
    expect(hookHarnesses.filter((id) => !isManagedHookProvider(id))).toEqual(['claude'])
  })

  it('builds guest defaults from the shared home-relative path', () => {
    expect(managedHookGuestConfigPath('gemini', '/home/u')).toBe(
      '/home/u/.gemini/settings.json'
    )
    expect(managedHookGuestConfigPath('dsh', '/home/u/')).toBe(
      '/home/u/.dsh/cordis.patch.yml'
    )
    expect(managedHookGuestConfigPath('hermes', '/home/u')).toBe(
      '/home/u/.hermes/config.yaml'
    )
  })
})

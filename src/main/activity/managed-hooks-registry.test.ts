import { describe, expect, it } from 'vitest'
import {
  HARNESS_IDS,
  harnessDetectNames,
  harnessLabel
} from '../../shared/domain/harness'
import {
  MANAGED_HOOK_PROVIDER_IDS,
  MANAGED_HOOK_PROVIDER_METADATA
} from '../../shared/domain/managed-hook-providers'
import {
  MANAGED_HOOK_PROVIDER_SPECS,
  managedHookDetectCommands,
  providerForHarness
} from './managed-hooks'

describe('managed hook provider specs derive from the shared registry', () => {
  it('has exactly one spec per registered provider', () => {
    expect(Object.keys(MANAGED_HOOK_PROVIDER_SPECS)).toEqual([
      ...MANAGED_HOOK_PROVIDER_IDS
    ])
  })

  it('derives labels and formats instead of storing duplicates', () => {
    for (const id of MANAGED_HOOK_PROVIDER_IDS) {
      expect(MANAGED_HOOK_PROVIDER_SPECS[id].label).toBe(harnessLabel(id))
      expect(MANAGED_HOOK_PROVIDER_SPECS[id].format).toBe(
        MANAGED_HOOK_PROVIDER_METADATA[id].format
      )
    }
  })

  it('uses harness detection names with only the DSH override', () => {
    for (const id of MANAGED_HOOK_PROVIDER_IDS) {
      const expected =
        id === 'dsh' ? ['dsh-tui'] : harnessDetectNames(id)
      expect([...managedHookDetectCommands(id)]).toEqual(expected)
    }
  })

  it('maps provider harnesses without an if-chain and rejects other harnesses', () => {
    for (const id of MANAGED_HOOK_PROVIDER_IDS) {
      expect(providerForHarness(id)).toBe(id)
    }
    for (const id of HARNESS_IDS) {
      if ((MANAGED_HOOK_PROVIDER_IDS as readonly string[]).includes(id)) continue
      expect(providerForHarness(id)).toBeNull()
    }
  })
})

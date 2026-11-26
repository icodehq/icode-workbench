import { describe, expect, it } from 'vitest'
import type { HarnessDetection, HarnessId } from '../../../shared/domain/harness'
import type {
  ManagedHookProviderStatusPayload,
  ManagedHooksStatePayload
} from '../../../shared/schemas/managed-hooks'
import type { OpenCodeIntegrationStatePayload } from '../../../shared/schemas/opencode-integration'
import {
  agentMasterState,
  buildAgentRows,
  visibleAgentRows,
  type AgentRowsInput
} from './agents-and-harnesses-view'

function available(harness: HarnessId, version = '1.2.3'): HarnessDetection {
  return {
    state: 'available',
    harness,
    version,
    resolvedPath: `/usr/bin/${harness}`,
    diagnostics: {
      resolvedPath: `/usr/bin/${harness}`,
      outcome: 'exited',
      exitCode: 0,
      signal: null,
      stdoutTail: version,
      stderrTail: '',
      durationMs: 10,
      observedAt: 1,
      attempts: 1
    }
  }
}

function managedProvider(
  provider: ManagedHookProviderStatusPayload['provider'],
  state: ManagedHookProviderStatusPayload['state'],
  detail: string | null = null
): ManagedHookProviderStatusPayload {
  return {
    provider,
    label: provider,
    state,
    configPath: `/home/u/${provider}.json`,
    detail
  }
}

function managed(
  providers: ManagedHookProviderStatusPayload[] = [managedProvider('gemini', 'cli-not-found')],
  enabled = true
): ManagedHooksStatePayload {
  return { enabled, providers }
}

function opencode(
  install: OpenCodeIntegrationStatePayload['install'] = {
    state: 'not-installed',
    configDir: '/home/u/.config/opencode'
  },
  enabled = true
): OpenCodeIntegrationStatePayload {
  return { enabled, api: 'v1', install }
}

function input(overrides: Partial<AgentRowsInput> = {}): AgentRowsInput {
  return {
    harnesses: [],
    harnessLoading: false,
    managedHooks: managed(),
    managedError: null,
    opencode: opencode(),
    opencodeError: null,
    ...overrides
  }
}

describe('agents and harnesses view model', () => {
  it('builds the 44 agent harnesses and excludes the terminal', () => {
    const rows = buildAgentRows(input({ managedHooks: managed([]) }))
    expect(rows).toHaveLength(44)
    expect(rows.some((row) => row.id === 'shell')).toBe(false)
    expect(rows.find((row) => row.id === 'claude')?.status).toBe('missing')
    expect(rows.find((row) => row.id === 'claude')?.label).toBe('Claude Code')
  })

  it('keeps a detected non-integrated agent visible as launch-only', () => {
    const rows = buildAgentRows(input({ harnesses: [available('claude')] }))
    const claude = rows.find((row) => row.id === 'claude')
    expect(claude).toMatchObject({
      status: 'launch-only',
      version: '1.2.3',
      executablePath: '/usr/bin/claude',
      defaultVisible: true
    })
    expect(visibleAgentRows(rows, false).some((row) => row.id === 'claude')).toBe(true)
  })

  it('surfaces installed integrations even when the CLI is missing', () => {
    const rows = buildAgentRows(
      input({
        managedHooks: managed([managedProvider('gemini', 'installed')])
      })
    )
    const gemini = rows.find((row) => row.id === 'gemini')
    expect(gemini).toMatchObject({
      status: 'installed',
      integrated: true,
      defaultVisible: true,
      configPath: '/home/u/gemini.json'
    })
  })

  it('orders failures and attention before healthy rows', () => {
    const rows = buildAgentRows(
      input({
        harnesses: [available('claude'), available('gemini')],
        managedHooks: managed([
          managedProvider('gemini', 'partial', 'needs attention'),
          managedProvider('cursor', 'failed', 'bad config')
        ])
      })
    )
    expect(rows[0]?.id).toBe('cursor')
    expect(rows[1]?.id).toBe('gemini')
    expect(rows[1]?.status).toBe('partial')
  })

  it('shows the OpenCode plugin as its own installed status', () => {
    const rows = buildAgentRows(
      input({
        opencode: opencode({
          state: 'installed',
          configDir: '/home/u/.config/opencode',
          api: 'v2',
          tuiRegistered: true
        })
      })
    )
    expect(rows.find((row) => row.id === 'opencode')).toMatchObject({
      status: 'plugin',
      defaultVisible: true
    })
  })

  it('shows status-off when the master switch disabled a detected integration', () => {
    const rows = buildAgentRows(
      input({
        harnesses: [available('gemini')],
        managedHooks: managed([managedProvider('gemini', 'disabled')], false),
        opencode: opencode(undefined, false)
      })
    )
    expect(rows.find((row) => row.id === 'gemini')?.status).toBe('status-off')
    expect(visibleAgentRows(rows, false).some((row) => row.id === 'gemini')).toBe(true)
  })

  it('hides cli-not-found providers until show-all', () => {
    const rows = buildAgentRows(input())
    expect(visibleAgentRows(rows, false)).toHaveLength(0)
    expect(visibleAgentRows(rows, true)).toHaveLength(44)
  })

  it('reports a mixed master switch', () => {
    expect(
      agentMasterState(managed([], true), opencode(undefined, false), null, null)
    ).toEqual({ checked: false, indeterminate: true, disabled: false })
    expect(agentMasterState(null, null, 'managed failed', null)).toEqual({
      checked: false,
      indeterminate: false,
      disabled: true
    })
  })
})

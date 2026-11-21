import { describe, expect, it } from 'vitest'
import {
  newMenuEntries,
  projectMenuEntries,
  worktreeMenuEntries,
  type SidebarMenuEntry
} from './sidebar-menu'

function ids<Id extends string>(entries: SidebarMenuEntry<Id>[]): Id[] {
  return entries.map((entry) => entry.id)
}

function separators<Id extends string>(entries: SidebarMenuEntry<Id>[]): Id[] {
  return entries.filter((entry) => entry.separatorBefore).map((entry) => entry.id)
}

function byId<Id extends string>(
  entries: SidebarMenuEntry<Id>[],
  id: Id
): SidebarMenuEntry<Id> {
  const entry = entries.find((candidate) => candidate.id === id)
  if (entry === undefined) throw new Error(`Missing ${id}`)
  return entry
}

describe('project menu plan', () => {
  it('offers the management actions in order with the destructive action last', () => {
    const entries = projectMenuEntries({
      preparation: null,
      hostUnreachable: false,
      hostUnreachableReason: 'host down'
    })
    expect(ids(entries)).toEqual([
      'new-session',
      'new-default-session',
      'queue-task',
      'pin',
      'copy-path',
      'repository-settings',
      'maintenance',
      'remove'
    ])
    expect(separators(entries)).toEqual(['pin', 'remove'])
    expect(entries.every((entry) => !entry.disabled)).toBe(true)
  })

  it('leads with retry and blocks creation while a failed preparation is visible', () => {
    const entries = projectMenuEntries({
      preparation: { kind: 'failed', label: 'Preparation failed' },
      hostUnreachable: false,
      hostUnreachableReason: 'host down'
    })
    expect(ids(entries)[0]).toBe('retry')
    expect(byId(entries, 'new-session')).toMatchObject({
      disabled: true,
      reason: 'Preparation failed'
    })
    expect(byId(entries, 'queue-task')).toMatchObject({
      disabled: true,
      reason: 'Preparation failed'
    })
  })

  it('shows the preparing state as disabled without a retry entry', () => {
    const entries = projectMenuEntries({
      preparation: { kind: 'preparing', label: 'Preparing' },
      hostUnreachable: false,
      hostUnreachableReason: 'host down'
    })
    expect(ids(entries)).not.toContain('retry')
    expect(byId(entries, 'new-session').reason).toBe('Preparing')
  })

  it('prefers the host reason when the host is unreachable', () => {
    const entries = projectMenuEntries({
      preparation: { kind: 'preparing', label: 'Preparing' },
      hostUnreachable: true,
      hostUnreachableReason: 'Host unreachable'
    })
    expect(byId(entries, 'new-session')).toMatchObject({
      disabled: true,
      reason: 'Host unreachable'
    })
  })
})

describe('worktree menu plan', () => {
  it('offers a session in a checkout that can host one', () => {
    const entries = worktreeMenuEntries({
      status: 'ready-to-start',
      hasSession: false,
      unavailableReason: 'Checkout unavailable'
    })
    expect(ids(entries)).toEqual(['new-session', 'copy-path', 'toggle'])
    expect(separators(entries)).toEqual(['toggle'])
    expect(byId(entries, 'new-session').disabled).toBe(false)
  })

  it('disables a session for a status Git cannot hand to a PTY', () => {
    for (const status of ['missing', 'inconsistent', 'creating'] as const) {
      const entries = worktreeMenuEntries({
        status,
        hasSession: false,
        unavailableReason: 'Checkout unavailable'
      })
      expect(byId(entries, 'new-session')).toMatchObject({
        disabled: true,
        reason: 'Checkout unavailable'
      })
    }
  })

  it('offers recovery only for a missing checkout that has a session', () => {
    const withSession = worktreeMenuEntries({
      status: 'missing',
      hasSession: true,
      unavailableReason: 'Checkout unavailable'
    })
    expect(ids(withSession)).toEqual(['new-session', 'copy-path', 'toggle', 'recover'])
    expect(byId(withSession, 'recover').separatorBefore).toBe(true)

    const withoutSession = worktreeMenuEntries({
      status: 'missing',
      hasSession: false,
      unavailableReason: 'Checkout unavailable'
    })
    expect(ids(withoutSession)).not.toContain('recover')
  })
})

describe('new-work menu plan', () => {
  it('orders creation, project, and schedules with one separator', () => {
    const entries = newMenuEntries({
      hostUnreachable: false,
      hostUnreachableReason: 'Host unreachable'
    })
    expect(ids(entries)).toEqual(['new-session', 'queue-task', 'add-project', 'schedules'])
    expect(separators(entries)).toEqual(['add-project'])
    expect(entries.every((entry) => !entry.disabled)).toBe(true)
  })

  it('disables a new session while the host is unreachable', () => {
    const entries = newMenuEntries({
      hostUnreachable: true,
      hostUnreachableReason: 'Host unreachable'
    })
    expect(byId(entries, 'new-session')).toMatchObject({
      disabled: true,
      reason: 'Host unreachable'
    })
  })
})

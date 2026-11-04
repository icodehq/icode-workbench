import { describe, expect, it } from 'vitest'
import { hostStatus } from './host-status'
import type { WorkspaceState } from './workspace'

function stateWith(
  sessions: Array<Partial<WorkspaceState['sessions'][number]>>
): WorkspaceState {
  return {
    sessions: sessions as WorkspaceState['sessions']
  } as WorkspaceState
}

describe('hostStatus', () => {
  it('is unknown when no session has answered', () => {
    expect(hostStatus(stateWith([]))).toBe('unknown')
  })

  it('is reachable when the host answered a session', () => {
    expect(hostStatus(stateWith([{ authority: 'host' }]))).toBe('reachable')
  })

  it('lets an unreachable answer win over a cached reachable one', () => {
    expect(
      hostStatus(
        stateWith([
          { authority: 'host' },
          { authority: 'unreachable', reason: 'host_unreachable' }
        ])
      )
    ).toBe('unreachable')
  })

  it('treats persisted host-unreachable history as unreachable', () => {
    expect(
      hostStatus(stateWith([{ authority: 'persisted', reason: 'host_unreachable_history' }]))
    ).toBe('unreachable')
  })
})

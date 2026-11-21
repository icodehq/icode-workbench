import { describe, expect, it, vi } from 'vitest'
import {
  createSessionActions,
  type SessionActionSource
} from './session-actions'

function source(): SessionActionSource {
  return {
    restartSession: vi.fn(async () => undefined),
    sleepSession: vi.fn(async () => undefined),
    wakeSession: vi.fn(async () => undefined),
    recheckSession: vi.fn(async () => undefined),
    requestRemoveSession: vi.fn(async () => undefined),
    recoverWorktree: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined)
  }
}

describe('session actions', () => {
  it('forwards every action to its source and returns undefined', () => {
    const raw = source()
    const actions = createSessionActions(raw)

    expect(actions.restart('a')).toBeUndefined()
    expect(actions.sleep('b')).toBeUndefined()
    expect(actions.wake('c')).toBeUndefined()
    expect(actions.recheck('d')).toBeUndefined()
    expect(actions.remove('e')).toBeUndefined()
    expect(actions.recoverWorktree('f')).toBeUndefined()
    expect(actions.stop('g')).toBeUndefined()

    expect(raw.restartSession).toHaveBeenCalledWith('a')
    expect(raw.sleepSession).toHaveBeenCalledWith('b')
    expect(raw.wakeSession).toHaveBeenCalledWith('c')
    expect(raw.recheckSession).toHaveBeenCalledWith('d')
    expect(raw.requestRemoveSession).toHaveBeenCalledWith('e')
    expect(raw.recoverWorktree).toHaveBeenCalledWith('f')
    expect(raw.stopSession).toHaveBeenCalledWith('g')
  })

  it('forwards the branch-deletion intent to removal', () => {
    const raw = source()
    const actions = createSessionActions(raw)

    expect(actions.remove('h', { deleteBranch: true })).toBeUndefined()

    expect(raw.requestRemoveSession).toHaveBeenCalledWith('h', { deleteBranch: true })
  })
})

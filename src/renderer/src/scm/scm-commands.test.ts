import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getScmCommandSnapshot,
  registerScmCommand,
  runScmCommand,
  subscribeScmCommands
} from './scm-commands'

const offs: Array<() => void> = []

afterEach(() => {
  for (const off of offs.splice(0)) off()
})

describe('scm command registry', () => {
  it('publishes metadata without leaking the run function', () => {
    const run = vi.fn()
    offs.push(
      registerScmCommand('git.commit', {
        sessionId: 's1',
        enabled: true,
        run
      })
    )
    const snapshot = getScmCommandSnapshot()
    expect(snapshot['git.commit']).toEqual({ sessionId: 's1', enabled: true })
    expect('run' in (snapshot['git.commit'] ?? {})).toBe(false)
  })

  it('runs only enabled commands for the expected session', () => {
    const run = vi.fn()
    offs.push(
      registerScmCommand('git.push', {
        sessionId: 's1',
        enabled: true,
        run
      })
    )
    expect(runScmCommand('git.push', 's2')).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(runScmCommand('git.push', 's1')).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)

    offs.push(
      registerScmCommand('git.pull', {
        sessionId: 's1',
        enabled: false,
        disabledReason: 'No upstream branch to pull from',
        run
      })
    )
    expect(runScmCommand('git.pull', 's1')).toBe(false)
    expect(getScmCommandSnapshot()['git.pull']?.disabledReason).toBe(
      'No upstream branch to pull from'
    )
  })

  it('notifies subscribers and ignores stale unregister calls', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeScmCommands(listener)
    offs.push(unsubscribe)
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = registerScmCommand('git.refresh', {
      sessionId: 's1',
      enabled: true,
      run: first
    })
    offs.push(offFirst)
    expect(listener).toHaveBeenCalledTimes(1)

    const offSecond = registerScmCommand('git.refresh', {
      sessionId: 's1',
      enabled: true,
      run: second
    })
    offs.push(offSecond)
    offFirst()
    expect(getScmCommandSnapshot()['git.refresh']).toBeDefined()
    expect(runScmCommand('git.refresh', 's1')).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()

    offSecond()
    expect(getScmCommandSnapshot()['git.refresh']).toBeUndefined()
    expect(runScmCommand('git.refresh', 's1')).toBe(false)
  })
})

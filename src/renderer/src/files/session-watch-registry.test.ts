import { describe, expect, it } from 'vitest'
import {
  getSessionLiveState,
  getSessionTreeWatch,
  setSessionLiveState,
  setSessionTreeWatch
} from './session-watch-registry'

describe('session files watch registry', () => {
  it('registers and clears what the tree can display', () => {
    const reloadExpanded = async (): Promise<void> => undefined
    setSessionTreeWatch('ses_a', {
      visible: true,
      expanded: { src: true },
      reloadExpanded,
      rootState: 'ready'
    })
    expect(getSessionTreeWatch('ses_a')).toMatchObject({
      visible: true,
      rootState: 'ready',
      expanded: { src: true }
    })
    setSessionTreeWatch('ses_a', null)
    expect(getSessionTreeWatch('ses_a')).toBeNull()
  })

  it('publishes the watcher mode per session', () => {
    expect(getSessionLiveState('ses_a')).toBe('off')
    setSessionLiveState('ses_a', 'watch')
    expect(getSessionLiveState('ses_a')).toBe('watch')
    setSessionLiveState('ses_a', 'poll')
    expect(getSessionLiveState('ses_a')).toBe('poll')
  })
})

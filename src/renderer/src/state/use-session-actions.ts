import { useMemo } from 'react'
import {
  createSessionActions,
  type SessionActions,
  type SessionActionSource
} from './session-actions'

export function useSessionActions(source: SessionActionSource): SessionActions {
  const {
    restartSession,
    sleepSession,
    wakeSession,
    recheckSession,
    requestRemoveSession,
    recoverWorktree,
    stopSession
  } = source
  return useMemo(
    () =>
      createSessionActions({
        restartSession,
        sleepSession,
        wakeSession,
        recheckSession,
        requestRemoveSession,
        recoverWorktree,
        stopSession
      }),
    [
      recoverWorktree,
      recheckSession,
      requestRemoveSession,
      restartSession,
      sleepSession,
      stopSession,
      wakeSession
    ]
  )
}

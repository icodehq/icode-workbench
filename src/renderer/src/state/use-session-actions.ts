import { useMemo } from 'react'
import {
  createSessionActions,
  type SessionActions,
  type SessionActionSource
} from './session-actions'

export function useSessionActions(source: SessionActionSource): SessionActions {
  const {
    restartSession,
    resumeSession,
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
        resumeSession,
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
      resumeSession,
      sleepSession,
      stopSession,
      wakeSession
    ]
  )
}

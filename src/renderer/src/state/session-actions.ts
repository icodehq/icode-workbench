export type SessionRemovalOptions = {
  /** Delete the session's owned branch along with its checkout. */
  deleteBranch?: boolean
}

export type SessionAction = (sessionId: string, options?: SessionRemovalOptions) => void

export type SessionActions = {
  restart: SessionAction
  sleep: SessionAction
  wake: SessionAction
  recheck: SessionAction
  remove: SessionAction
  recoverWorktree: SessionAction
  stop: SessionAction
}

export type SessionActionSource = {
  restartSession: (sessionId: string) => Promise<void>
  sleepSession: (sessionId: string) => Promise<void>
  wakeSession: (sessionId: string) => Promise<void>
  recheckSession: (sessionId: string) => Promise<void>
  requestRemoveSession: (sessionId: string, options?: SessionRemovalOptions) => Promise<void>
  recoverWorktree: (sessionId: string) => Promise<void>
  stopSession: (sessionId: string) => Promise<void>
}

export type DirectSessionActions = Pick<
  SessionActions,
  'restart' | 'sleep' | 'wake' | 'recheck' | 'remove' | 'recoverWorktree'
>
export type TaskSessionActions = Pick<SessionActions, 'stop' | 'restart' | 'recheck'>
export type SidebarSessionActions = Pick<
  SessionActions,
  'sleep' | 'wake' | 'restart' | 'remove' | 'recoverWorktree'
>

/**
 * The one place that adapts the workspace's async session methods to the
 * fire-and-forget callbacks the surfaces render. `remove` forwards to
 * `requestRemoveSession` because the confirmation/cleanup flow owns the name.
 */
export function createSessionActions(source: SessionActionSource): SessionActions {
  return {
    restart: (sessionId) => void source.restartSession(sessionId),
    sleep: (sessionId) => void source.sleepSession(sessionId),
    wake: (sessionId) => void source.wakeSession(sessionId),
    recheck: (sessionId) => void source.recheckSession(sessionId),
    remove: (sessionId, options) =>
      void (options === undefined
        ? source.requestRemoveSession(sessionId)
        : source.requestRemoveSession(sessionId, options)),
    recoverWorktree: (sessionId) => void source.recoverWorktree(sessionId),
    stop: (sessionId) => void source.stopSession(sessionId)
  }
}

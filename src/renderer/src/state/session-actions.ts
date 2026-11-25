export type SessionRemovalOptions = {
  /** Delete the session's owned branch along with its checkout. */
  deleteBranch?: boolean
}

export type WorktreeRemovalOptions = {
  /** Delete the worktree's owned branch along with its checkout. */
  deleteBranch?: boolean
}

export type WorktreeRecoveryOptions = {
  /** The user confirmed that an unrecoverable checkout may be moved aside. */
  keepExistingAsAside?: boolean
}

export type SessionAction = (sessionId: string, options?: SessionRemovalOptions) => void
export type WorktreeRecoverAction = (
  sessionId: string,
  options?: WorktreeRecoveryOptions
) => void

export type SessionActions = {
  restart: SessionAction
  resume: SessionAction
  sleep: SessionAction
  wake: SessionAction
  recheck: SessionAction
  remove: SessionAction
  recoverWorktree: WorktreeRecoverAction
  stop: SessionAction
}

export type SessionActionSource = {
  restartSession: (sessionId: string) => Promise<void>
  resumeSession: (sessionId: string) => Promise<void>
  sleepSession: (sessionId: string) => Promise<void>
  wakeSession: (sessionId: string) => Promise<void>
  recheckSession: (sessionId: string) => Promise<void>
  requestRemoveSession: (sessionId: string, options?: SessionRemovalOptions) => Promise<void>
  recoverWorktree: (
    sessionId: string,
    options?: WorktreeRecoveryOptions
  ) => Promise<void>
  stopSession: (sessionId: string) => Promise<void>
}

export type DirectSessionActions = Pick<
  SessionActions,
  'restart' | 'resume' | 'sleep' | 'wake' | 'recheck' | 'remove' | 'recoverWorktree' | 'stop'
>
export type TaskSessionActions = Pick<SessionActions, 'stop' | 'restart' | 'recheck'>
export type SidebarSessionActions = Pick<
  SessionActions,
  'sleep' | 'wake' | 'restart' | 'resume' | 'remove' | 'recoverWorktree'
>

/**
 * The one place that adapts the workspace's async session methods to the
 * fire-and-forget callbacks the surfaces render. `remove` forwards to
 * `requestRemoveSession` because the confirmation/cleanup flow owns the name.
 */
export function createSessionActions(source: SessionActionSource): SessionActions {
  return {
    restart: (sessionId) => void source.restartSession(sessionId),
    resume: (sessionId) => void source.resumeSession(sessionId),
    sleep: (sessionId) => void source.sleepSession(sessionId),
    wake: (sessionId) => void source.wakeSession(sessionId),
    recheck: (sessionId) => void source.recheckSession(sessionId),
    remove: (sessionId, options) =>
      void (options === undefined
        ? source.requestRemoveSession(sessionId)
        : source.requestRemoveSession(sessionId, options)),
    recoverWorktree: (sessionId, options) =>
      void (options === undefined
        ? source.recoverWorktree(sessionId)
        : source.recoverWorktree(sessionId, options)),
    stop: (sessionId) => void source.stopSession(sessionId)
  }
}

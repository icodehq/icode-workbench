import { app } from 'electron'
import { getAppPersistence, closeAppPersistence } from '../persistence'
import { HostSupervisor } from '../host/host-supervisor'
import { SupervisorHostGateway } from '../sessions/host-gateway'
import { SessionService } from '../sessions/session-service'
import { createHarnessDetector, type HarnessDetector } from '../harness/harness-detector'
import { RepositoryRemovalService } from '../repositories/repository-removal-service'
import { SessionRemovalService } from '../sessions/session-removal-service'
import { ReviewService } from '../review/review-service'
import { ActivityService } from '../activity/activity-service'
import { ActivityHookServer } from '../activity/hook-server'
import { installClaudeHooks } from '../activity/claude-hooks'
import { ActivityBroadcaster } from '../activity/activity-broadcaster'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { join } from 'node:path'
import type { AppError } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { SessionListView } from '../../shared/schemas/ipc'

export type AppRuntime = {
  sessions: SessionService
  activity: ActivityService
  activityServer: ActivityHookServer
  removals: RepositoryRemovalService
  sessionRemovals: SessionRemovalService
  review: ReviewService
  harness: HarnessDetector
  /** Set when persistence could not be opened; operations surface this error. */
  startupError: AppError | null
  ready: Promise<void>
  shutdown: () => Promise<void>
  hostLogPath: () => string
}

let runtime: AppRuntime | null = null

export function getAppRuntime(): AppRuntime | null {
  return runtime
}

/**
 * Main-process composition root. Persistence opens first, then the host is
 * contacted and reconciled. A host failure is reported, not fatal: the app can
 * still list repositories and retry.
 */
export async function startAppRuntime(): Promise<AppRuntime> {
  if (runtime) return runtime

  const persistence = getAppPersistence()

  // Activity hooks live beside the app's own data, never in the user's Claude
  // config. `--settings` is additive, so the user's hooks keep running.
  const activityDirectory = join(app.getPath('userData'), 'agent-hooks')
  const hooks = installClaudeHooks({
    directory: activityDirectory,
    execPath: process.execPath,
    electronRunAsNode: !process.execPath.endsWith('node')
  })
  const activitySocketPath = join(app.getPath('userData'), 'run', 'activity.sock')

  const activityBroadcaster = new ActivityBroadcaster()
  const activity = new ActivityService({
    isKnownSession: (sessionId) => persistence.sessions.findById(sessionId as never) !== null,
    onTransition: (transition) => {
      const row = persistence.sessions.findById(transition.sessionId as never)
      activityBroadcaster.handle(transition, row?.title ?? 'ADE session')
    },
    currentIncarnation: (sessionId) => {
      const row = persistence.sessions.findById(sessionId as never)
      return row?.observation.lastObservedIncarnationId ?? null
    },
    onRejected: (reason, event) => {
      process.stderr.write(
        `[ade] activity event rejected (${reason}) session=${String(event.sessionId ?? '?')}\n`
      )
    }
  })
  const activityServer = new ActivityHookServer({
    socketPath: activitySocketPath,
    ingest: (event) => activity.ingest(event),
    onRejected: (reason, detail) => {
      process.stderr.write(`[ade] activity payload dropped (${reason}) ${detail ?? ''}\n`)
    }
  })

  const supervisor = new HostSupervisor(undefined, {
    ADE_ACTIVITY_SOCKET: activitySocketPath
  })
  const host = new SupervisorHostGateway(supervisor)
  const harness = createHarnessDetector()
  const worktrees = new WorktreeStore(persistence.database)
  const gitWorktrees = new GitWorktreeService({
    // Why: session checkouts live on the Linux filesystem, never beside a
    // DrvFs repository where Git operations are an order of magnitude slower.
    worktreeRoot: join(app.getPath('userData'), 'worktrees')
  })
  const sessions = new SessionService({
    database: persistence.database,
    repositories: persistence.repositories,
    sessions: persistence.sessions,
    worktrees,
    gitWorktrees,
    host,
    detectHarness: (id) => harness.detectOne(id),
    // Only Claude understands the hook overlay; every other harness is untouched.
    launchArgs: (id) => (id === 'claude' ? hooks.launchArgs : []),
    onIncarnation: (sessionId, incarnationId) => activity.bindIncarnation(sessionId, incarnationId),
    activityFor: (sessionId) => activity.get(sessionId)
  })

  let startupError: AppError | null = null
  let reconcile: SessionListView | null = null
  try {
    await activityServer.start()
  } catch (error) {
    // Activity is advisory: a failed listener must not block the workspace.
    process.stderr.write(`[ade] activity listener failed: ${String(error)}\n`)
  }

  try {
    sessions.start()
    reconcile = await sessions.reconcile()
    if (sessions.getLastHostError()) {
      process.stderr.write(
        `[ade] host reconciliation incomplete: ${sessions.getLastHostError()?.message}\n`
      )
    }
  } catch (error) {
    startupError = makeAppError('INTERNAL', 'ADE could not complete startup reconciliation.', {
      detail: error instanceof Error ? error.message : String(error),
      context: { log: supervisor.logPath }
    })
    process.stderr.write(`[ade] startup reconciliation failed: ${String(error)}\n`)
  }
  void reconcile

  const removals = new RepositoryRemovalService({
    repositories: persistence.repositories,
    sessions: persistence.sessions,
    repositoryService: persistence.repositoryService,
    host,
    worktrees,
    gitWorktrees,
    summarise: async (repoId) => {
      const view = await sessions.list(repoId)
      return view.sessions
    }
  })

  const sessionRemovals = new SessionRemovalService({
    database: persistence.database,
    sessions: persistence.sessions,
    repositories: persistence.repositories,
    worktrees,
    gitWorktrees,
    host,
    summarise: (sessionId) => sessions.get(sessionId)
  })

  const review = new ReviewService({
    sessions,
    repositories: persistence.repositories,
    worktrees,
    gitWorktrees
  })

  let shutdownPromise: Promise<void> | null = null
  const api: AppRuntime = {
    sessions,
    activity,
    activityServer,
    removals,
    sessionRemovals,
    review,
    harness,
    startupError,
    ready: Promise.resolve(),
    hostLogPath: () => supervisor.logPath,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        await activityServer.stop().catch(() => undefined)
        sessions.dispose()
        // Do not stop the detached host: live sessions must survive app exit.
        host.disconnect()
        closeAppPersistence()
      })()
      return shutdownPromise
    }
  }

  runtime = api
  app.on('before-quit', () => {
    void api.shutdown()
  })
  return api
}

/** Compatibility modes and tests must not touch the user's database. */
export function resetAppRuntimeForTests(): void {
  runtime = null
}

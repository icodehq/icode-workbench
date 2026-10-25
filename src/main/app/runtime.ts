import { app } from 'electron'
import { getAppPersistence, closeAppPersistence } from '../persistence'
import { HostSupervisor } from '../host/host-supervisor'
import { SupervisorHostGateway } from '../sessions/host-gateway'
import { SessionService } from '../sessions/session-service'
import {
  createHarnessDetector,
  type HarnessDetector,
  type HarnessDetectionResult
} from '../harness/harness-detector'
import { HARNESS_IDS, type HarnessId } from '../../shared/domain/harness'
import type { WslDistroListPayload } from '../../shared/schemas/ipc'
import { discoverWslDistros } from '../wsl/distros'
import { parseRepoId } from '../../shared/domain/ids'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { toWslDistroListPayload } from '../wsl/distro-list'
import { RepositoryRemovalService } from '../repositories/repository-removal-service'
import { SessionRemovalService } from '../sessions/session-removal-service'
import { ReviewService } from '../review/review-service'
import { WorkspaceFilesService } from '../files/workspace-files-service'
import { GitWorkspaceService } from '../git/git-workspace-service'
import { ActivityService } from '../activity/activity-service'
import { ActivityHookServer } from '../activity/hook-server'
import { activitySocketPath as activityEndpoint } from '../activity/endpoint'
import { installClaudeHooks } from '../activity/claude-hooks'
import { ActivityBroadcaster } from '../activity/activity-broadcaster'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { createGitExecutorRouter } from '../git/executor'
import { WslCommandRunner, resolveWslExecutablePath, resolveWslInteropCwd } from '../wsl/exec'
import { profileSocketScope } from '../../host/paths'
import { GitReviewReader } from '../review/git-review-reader'
import { createGuestReviewReader } from '../wsl/git/guest-review-reader'
import { WslHostLifecycle, readGuestHome } from '../wsl/host/lifecycle'
import { createWslHolder, createHolderRecordStore } from '../wsl/host/holder'
import { createWindowsProcessQuery } from '../wsl/host/windows-process'
import { createGuestHostStore } from '../wsl/host/guest-store'
import { WslHostRelay } from '../wsl/relay/endpoint'
import { createTargetValidator } from '../wsl/repository-target'
import { loadWslArtifacts } from '../wsl/host/artifact-locating'
import type { HostArtifactManifest } from '../wsl/host/deploy'
import { createGuestHarnessDetector, withGuestLaunchCommand } from '../wsl/harness/guest-harness-detector'
import { resolvePathATerminal } from '../wsl/terminal/path-a'
import { toGuestVisiblePath } from '../wsl/guest-visible-path'
import { resolveGuestHarnessContext } from '../wsl/harness/guest-harness'
import { createWslHostClientPool } from '../sessions/wsl-host-client-pool'
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
  /** Worktree-scoped file browsing, editing and search for the tools panel. */
  files: WorkspaceFilesService
  /** Worktree-scoped Git state and stage/commit operations. */
  gitWorkspace: GitWorkspaceService
  harness: HarnessDetector
  /**
   * Harnesses for a repository's own execution target.
   *
   * Omit `repoId` for this machine, which is what every pre-W9 caller meant.
   */
  listHarnesses: (input?: { repoId?: string }) => Promise<HarnessDetectionResult[]>
  /** Registered WSL distros, or why they could not be read. */
  listWslDistros: () => Promise<WslDistroListPayload>
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
  // The endpoint is needed by the guest overlay, so it is resolved first.
  const activitySocketPath = activityEndpoint({ userDataDir: app.getPath('userData') })
  const hooks = installClaudeHooks({
    directory: activityDirectory,
    execPath: process.execPath,
    electronRunAsNode: !process.execPath.endsWith('node'),
    // A WSL Agent's hook runs inside Linux but must reach this Windows process,
    // so the guest overlay starts the same executable through WSL interop.
    guest:
      process.platform === 'win32'
        ? {
            guestExecutablePath: toGuestVisiblePath(process.execPath),
            activitySocket: activitySocketPath
          }
        : undefined
  })

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

  /**
   * One guest command runner for the process. It holds no per-distro state, so a
   * distro restart needs no invalidation.
   */
  const wslRunner = new WslCommandRunner()
  /**
   * Worktree scope for WSL: derived from the profile directory, exactly as the
   * Host relay scope is, so two ADE profiles on one distro never share checkouts.
   */
  const wslProfileScope = (): string => profileSocketScope(app.getPath('userData'))
  /**
   * The W3 tree, read once.
   *
   * Its absence must not block a local-only user, so nothing here throws at
   * startup: the relay is built on first use and reports a typed failure if the
   * tree is missing.
   */
  const wslArtifacts = loadWslArtifacts()

  const supervisor = new HostSupervisor(undefined, {
    ADE_ACTIVITY_SOCKET: activitySocketPath
  })

  /**
   * Built on first WSL use, not at startup.
   *
   * `WslHostRelay` is W5's endpoint (which itself revalidates the target and calls
   * W4's `ensure`), so this composition adds no lifecycle of its own.
   */
  let wslRelayInstance: WslHostRelay | null = null
  const buildWslRelay = (manifest: HostArtifactManifest, artifactRoot: string): WslHostRelay =>
    new WslHostRelay({
      runner: wslRunner,
      // W57's validator: the persisted target is re-proved before any Host is used.
      validateTarget: createTargetValidator({ runner: wslRunner }),
      openLifecycle: (hostRoot) =>
        new WslHostLifecycle({
          runner: wslRunner,
          validateTarget: createTargetValidator({ runner: wslRunner }),
          // The Windows holder is W4's; this process may not be able to spawn one
          // (a Linux controller cannot), which W4 reports honestly.
          holder: createWslHolder({
            store: createHolderRecordStore(join(app.getPath('userData'), 'wsl-host-holders')),
            queryProcess: createWindowsProcessQuery()
          }),
          store: createGuestHostStore(join(app.getPath('userData'), 'wsl-guest-hosts')),
          artifactRoot,
          manifest,
          hostRoot
        }),
      store: createGuestHostStore(join(app.getPath('userData'), 'wsl-guest-hosts')),
      artifactRoot,
      manifest,
      profileDir: app.getPath('userData'),
      // The one process the relay needs to know how to start: `wsl.exe`, from an
      // explicit Windows cwd, so an inherited deleted cwd cannot break every bridge.
      bridgeChildDeps: {
        program: resolveWslExecutablePath(),
        cwd: resolveWslInteropCwd(process.env),
        env: process.env
      }
    })

  const wslRelay = {
    start: async (
      target: Parameters<WslHostRelay['start']>[0],
      options?: { signal?: AbortSignal }
    ) => {
      if (!wslArtifacts.ok) {
        return {
          status: 'unavailable' as const,
          error: wslArtifacts.error,
          detail: 'artifacts_missing'
        }
      }
      wslRelayInstance ??= buildWslRelay(wslArtifacts.manifest, wslArtifacts.root)
      return wslRelayInstance.start(target, options)
    }
  }

  const wslHosts = createWslHostClientPool({ relay: wslRelay })
  const host = new SupervisorHostGateway(supervisor, wslHosts)
  const harness = createHarnessDetector()
  const worktrees = new WorktreeStore(persistence.database)
  const gitWorktrees = new GitWorktreeService({
    // Why: session checkouts live on the Linux filesystem, never beside a
    // DrvFs repository where Git operations are an order of magnitude slower.
    worktreeRoot: join(app.getPath('userData'), 'worktrees'),
    // W6: a WSL repository's Git and worktrees run in its distro. The local root
    // above stays exactly what it was.
    router: createGitExecutorRouter({
      localWorktreeRoot: join(app.getPath('userData'), 'worktrees'),
      runner: wslRunner,
      guestWorktreeRoot: async (distro) => {
        const home = await readGuestHome(wslRunner, distro)
        return home === null ? null : `${home}/.ade/worktrees/${wslProfileScope()}`
      }
    })
  })
  /**
   * Detects one Harness **for a specific execution target**.
   *
   * This is the only place the distinction lives, because both the session
   * service and the Harness list in the UI must agree. A WSL target is probed
   * inside its own distro: a local `claude` on PATH says nothing about the guest.
   */
  async function detectHarnessForTarget(
    id: HarnessId,
    target: ExecutionTarget
  ): Promise<HarnessDetectionResult> {
    if (target.kind === 'local') return harness.detectOne(id)
    /**
     * A WSL **terminal** is Path A and needs no probe.
     *
     * W63 removed the guest shell spec precisely because the terminal's shell is
     * resolved inside the distro by `wsl.exe` itself. Reporting `shell` as
     * unavailable here would hide a working terminal; reporting it as available
     * with `wsl.exe` as its command states what will actually run.
     */
    if (id === 'shell') return guestTerminalDetection()
    const guestDetector = await createGuestHarnessDetector({
      runner: wslRunner,
      distro: target.distro
    })
    const detection = await guestDetector.detectOne(id)
    const shell = await resolveGuestHarnessContext({
      runner: wslRunner,
      distro: target.distro
    })
    return withGuestLaunchCommand(detection, { shell: shell.shell })
  }

  /**
   * The WSL terminal entry shown in the New session dialog.
   *
   * `resolvedPath` is `wsl.exe` because that is the program the desktop Host
   * spawns for Path A; the guest shell behind it is the distro's own login shell.
   */
  function guestTerminalDetection(): HarnessDetectionResult {
    return {
      state: 'available',
      harness: 'shell',
      version: null,
      resolvedPath: resolveWslExecutablePath(process.env, process.platform),
      command: { command: resolveWslExecutablePath(process.env, process.platform), args: [] },
      diagnostics: {
        resolvedPath: resolveWslExecutablePath(process.env, process.platform),
        outcome: 'exited',
        exitCode: 0,
        signal: null,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 0,
        observedAt: Date.now(),
        attempts: 1
        // Deliberately no probe evidence: Path A needs none, and inventing a
        // duration would make the diagnostics panel claim work that never ran.
      }
    }
  }

  const sessions = new SessionService({
    database: persistence.database,
    repositories: persistence.repositories,
    sessions: persistence.sessions,
    worktrees,
    gitWorktrees,
    host,
    /**
     * Path A: a terminal on the desktop Host whose child is `wsl.exe`.
     *
     * The PTY cwd is the app's userData directory — machine-local, because a
     * ConPTY cannot start in a Linux path (Orca's `effectiveCwd: defaultCwd`).
     * The guest directory is entered by the child script.
     */
    resolveWslTerminal: (target, guestCwd) =>
      resolvePathATerminal(target, guestCwd, {
        runner: wslRunner,
        validateTarget: createTargetValidator({ runner: wslRunner }),
        ptyCwd: app.getPath('userData')
      }),
    // Local discovery is the existing detector, unchanged. A WSL repository is
    // discovered inside its own distro, and its launch command is rewritten to run
    // under that distro's login shell.
    detectHarness: (id, target) => detectHarnessForTarget(id, target),
    /**
     * Only Claude understands the hook overlay; every other harness is untouched.
     *
     * A WSL Agent gets its own overlay, because its hook commands must cross into
     * Windows; the file is read through `/mnt/<drive>/…`, since a Windows path is
     * not a path inside the distro.
     */
    launchArgs: (id, target) => {
      if (id !== 'claude') return []
      if (target.kind !== 'wsl') return hooks.launchArgs
      if (hooks.guestSettingsPath === null) return []
      return ['--settings', toGuestVisiblePath(hooks.guestSettingsPath)]
    },
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

  /**
   * Guest review readers, one per distro.
   *
   * `createGuestReviewReader` is the W6 implementation; this only supplies it to
   * the reader. A WSL target therefore always reads through the distro's Git, and
   * if a distro cannot be reached the read fails instead of falling back to local.
   */
  const guestReviewReaders = new Map<string, ReturnType<typeof createGuestReviewReader>>()
  const reviewReader = new GitReviewReader({
    readForTarget: (target) => {
      if (target.kind !== 'wsl') return null
      const key = `${target.distro.trim().toLowerCase()}\u0000${target.distroId ?? ''}`
      let reader = guestReviewReaders.get(key)
      if (!reader) {
        reader = createGuestReviewReader(wslRunner, target.distro)
        guestReviewReaders.set(key, reader)
      }
      return reader
    }
  })

  // The repository list asks a distro about its own checkout; without this the
  // only available answer would be a local stat, which is the wrong machine.
  persistence.repositoryService.useHostFs((target) => gitWorktrees.hostFsFor(target))

  const review = new ReviewService({
    sessions,
    repositories: persistence.repositories,
    worktrees,
    gitWorktrees,
    reader: reviewReader
  })

  const files = new WorkspaceFilesService({
    sessions,
    repositories: persistence.repositories,
    worktrees,
    gitWorktrees,
    runner: wslRunner
  })

  const gitWorkspace = new GitWorkspaceService({
    repositories: persistence.repositories,
    worktrees,
    gitWorktrees
  })

  /**
   * The Harness list for one execution target.
   *
   * Detection is per target, not per app: a WSL repository's Agents live inside
   * the distro, so showing this machine's probes would be a confident wrong
   * answer — and would offer an Agent that the guest cannot run.
   */
  async function listHarnesses(
    input: { repoId?: string } = {}
  ): Promise<HarnessDetectionResult[]> {
    let target: ExecutionTarget = { kind: 'local' }
    if (input.repoId !== undefined) {
      const repoId = parseRepoId(input.repoId)
      const repository = repoId === null ? null : persistence.repositories.findById(repoId)
      if (!repository) {
        throw makeAppError('INVALID_ARGUMENT', 'That repository is not registered.', {
          context: { repoId: input.repoId }
        })
      }
      target = repository.executionTarget
    }
    return Promise.all(HARNESS_IDS.map((id) => detectHarnessForTarget(id, target)))
  }

  let shutdownPromise: Promise<void> | null = null
  const api: AppRuntime = {
    sessions,
    activity,
    activityServer,
    removals,
    sessionRemovals,
    review,
    files,
    gitWorkspace,
    harness,
    listHarnesses,
    listWslDistros: async () => toWslDistroListPayload(await discoverWslDistros({ runner: wslRunner })),
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

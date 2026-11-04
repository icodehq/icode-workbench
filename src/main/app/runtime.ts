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
import { parseRepoId, type SessionId } from '../../shared/domain/ids'
import type { ExecutionTarget } from '../../shared/domain/repository'
import { toWslDistroListPayload } from '../wsl/distro-list'
import { RepositoryRemovalService } from '../repositories/repository-removal-service'
import { ProjectFolderService } from '../repositories/project-folder-service'
import { RepositoryPreparationService } from '../repositories/repository-preparation-service'
import { prepareFirstCommit } from '../repositories/first-commit'
import { SessionRemovalService } from '../sessions/session-removal-service'
import { ReviewService } from '../review/review-service'
import { WorkspaceFilesService } from '../files/workspace-files-service'
import { GitWorkspaceService } from '../git/git-workspace-service'
import { GitStatusWatcherService } from '../git/status-watcher'
import { TaskStore } from '../tasks/task-store'
import { TaskService } from '../tasks/task-service'
import { TaskDispatcher } from '../tasks/task-dispatcher'
import { TaskScheduler } from '../tasks/task-scheduler'
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
import { createGuestReviewReader, createGuestSymlinkProbe } from '../wsl/git/guest-review-reader'
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
import { createWorkspaceTrust } from '../harness/trust/workspace-trust'
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
  /** Watches visible local worktrees and emits coalesced status changes. */
  gitStatusWatcher: GitStatusWatcherService
  /** Add-project inspection and explicit first-commit initialization. */
  projectFolders: ProjectFolderService
  /** Background first-commit work, exposed for retry and startup wiring. */
  repositoryPreparations: RepositoryPreparationService
  /** Subscribe to repository/preparation changes so a window can re-read. */
  onRepoChange: (listener: () => void) => () => void
  /** Durable tasks: creation, cancellation, retry, and the retry history. */
  tasks: TaskService
  /** Due-schedule evaluation. Every occurrence becomes an ordinary task. */
  schedules: TaskScheduler
  /** The queue pump, exposed for the boot sequence and for tests. */
  taskDispatcher: TaskDispatcher
  /** Subscribe to task changes so a window can re-read the queue. */
  onTaskChange: (listener: () => void) => () => void
  harness: HarnessDetector
  /**
   * Harnesses for a repository's own execution target.
   *
   * Omit `repoId` for this machine, which is what every pre-W9 caller meant.
   */
  listHarnesses: (input?: { repoId?: string }) => Promise<HarnessDetectionResult[]>
  /** Registered WSL distros, or why they could not be read. */
  listWslDistros: () => Promise<WslDistroListPayload>
  /**
   * A distro's `$HOME`, read inside the distro.
   *
   * The folder picker needs it to start a Windows dialog inside that distro's
   * filesystem; `null` means the distro did not answer, which the picker reports
   * rather than guessing a home directory.
   */
  readGuestHome: (distro: string) => Promise<string | null>
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
  /**
   * Set once the task layer exists. Activity is constructed before tasks (it is
   * a session concern), so the link is a callback rather than a constructor
   * argument — but it is the *only* signal that distinguishes a finished turn
   * from a live process, so it must not be forgotten.
   */
  let onTaskActivity: ((sessionId: string, activity: { state: string; outcome: string | null }) => void) | null = null
  const activity = new ActivityService({
    isKnownSession: (sessionId) => persistence.sessions.findById(sessionId as never) !== null,
    onTransition: (transition) => {
      const row = persistence.sessions.findById(transition.sessionId as never)
      activityBroadcaster.handle(transition, row?.title ?? 'ADE session')
      if (transition.harnessSessionId !== null) {
        persistence.sessions.setResumeToken(
          transition.sessionId as SessionId,
          transition.harnessSessionId
        )
      }
      // A task's completion comes from the harness's own turn-end signal, never
      // from the fact that a terminal was spawned.
      onTaskActivity?.(transition.sessionId, {
        state: transition.next.state,
        outcome: transition.next.outcome
      })
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
   * Harness workspace trust is prepared for every session, not only Claude.
   * The service owns the per-harness adapters and writes only the record a user
   * would create by accepting a harness's own trust dialog.
   */
  const workspaceTrust = createWorkspaceTrust({
    runner: wslRunner,
    localHome: app.getPath('home'),
    readGuestHome: (distro) => readGuestHome(wslRunner, distro)
  })
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
            queryProcess: createWindowsProcessQuery(),
            execPath: process.execPath,
            holderEntryPath: supervisor.hostEntryPath,
            readyDirectory: join(app.getPath('userData'), 'wsl-host-holders', 'spawn')
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
   * Repository changes are rare and coalesced by the renderer's refresh. An
   * event says only "re-read"; the database remains the source of truth.
   */
  const repoChangeListeners = new Set<() => void>()
  const emitRepoChange = (): void => {
    for (const listener of repoChangeListeners) {
      try {
        listener()
      } catch {
        // A dead window must not stop preparation.
      }
    }
  }
  const repositoryPreparations = new RepositoryPreparationService({
    repositories: persistence.repositories,
    prepare: (repository, isCancelled) =>
      prepareFirstCommit(repository, {
        runner: wslRunner,
        gitWorktrees,
        isCancelled
      }),
    now: Date.now,
    onChange: emitRepoChange
  })
  const projectFolders = new ProjectFolderService({
    runner: wslRunner,
    gitWorktrees,
    repositoryService: persistence.repositoryService,
    preparations: repositoryPreparations,
    validateTarget: createTargetValidator({ runner: wslRunner }),
    localHome: app.getPath('home'),
    readGuestHome: (distro) => readGuestHome(wslRunner, distro)
  })
  // Resume preparation that was interrupted by the previous application exit.
  // Starting is non-blocking; the project rows already exist and the renderer
  // will read their persisted state on first load.
  repositoryPreparations.resume()
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
    workspaceTrust,
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
    preparations: repositoryPreparations,
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
    workspaceTrust,
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
  const guestSymlinkProbes = new Map<string, ReturnType<typeof createGuestSymlinkProbe>>()
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
    },
    // The same distro key, so one probe per distro answers symlink questions
    // about that distro's filesystem rather than this machine's.
    symlinkProbeForTarget: (target) => {
      if (target.kind !== 'wsl') return null
      const key = `${target.distro.trim().toLowerCase()}\u0000${target.distroId ?? ''}`
      let probe = guestSymlinkProbes.get(key)
      if (!probe) {
        probe = createGuestSymlinkProbe(wslRunner, target.distro)
        guestSymlinkProbes.set(key, probe)
      }
      return probe
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
  const translateGuestWatchPath = async (distro: string, guestPath: string): Promise<string | null> => {
    const result = await wslRunner.run({
      scope: 'guest',
      distro,
      argv: ['wslpath', '-w', guestPath],
      timeoutMs: 10_000
    })
    if (result.status !== 'ok') return null
    const windowsPath = result.stdout.trim().replace(/\//gu, '\\')
    // DrvFs paths translate to a drive and can be watched from Windows. A
    // `\\wsl.localhost\...` path is not reliably watchable (Phase 0/1c); leave
    // it to polling or the future Host watcher.
    return /^[A-Za-z]:\\/u.test(windowsPath) ? windowsPath : null
  }

  /**
   * Watch where notifications actually work. A local path is watched directly;
   * a WSL worktree on a Windows drive is watched through its translated Windows
   * path (Phase 0 measured that Linux inotify on DrvFs sees nothing), and an
   * ext4 guest worktree falls back to polling until Phase 1c.
   */
  const resolveGitWatchTarget = async (sessionId: string) => {
    const details = await gitWorkspace.watchTargetDetails(sessionId)
    if (details === null) return null
    if (details.target.kind === 'local') {
      return { worktreePath: details.worktreePath, gitDir: details.gitDir }
    }
    const [worktreePath, gitDir] = await Promise.all([
      translateGuestWatchPath(details.target.distro, details.worktreePath),
      translateGuestWatchPath(details.target.distro, details.gitDir)
    ])
    if (worktreePath === null || gitDir === null) return null
    return { worktreePath, gitDir }
  }

  const gitStatusWatcher = new GitStatusWatcherService({
    resolveTarget: resolveGitWatchTarget
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

  /**
   * Task composition.
   *
   * The store is the durable half; the service owns lifecycle rules; the
   * dispatcher owns the queue. They are separate objects because they fail
   * independently: a dispatch failure must not corrupt a task record, and a
   * schedule tick must be able to create a task without being able to start it.
   */
  const taskStore = new TaskStore(persistence.database)

  /**
   * Host-confirmed session facts for task display.
   *
   * Updated from the same reconciled list the renderer sees, so a task never
   * claims "live" on the strength of a persisted row.
   */
  const sessionFacts = new Map<string, { state: string; exitCode: number | null }>()
  const refreshSessionFacts = async (): Promise<void> => {
    const view = await sessions.list().catch(() => null)
    if (!view) return
    sessionFacts.clear()
    for (const entry of view.sessions) {
      sessionFacts.set(entry.id, { state: entry.state, exitCode: entry.exitCode })
    }
  }

  const sessionWorktreePath = (sessionId: string): string | null => {
    const row = persistence.sessions.findById(sessionId as never)
    const worktree = row ? worktrees.findBySession(row.id) : null
    return worktree?.path ?? null
  }

  const taskDispatcher = new TaskDispatcher({
    tasks: taskStore,
    sessions,
    now: () => Date.now(),
    onChange: () => emitTaskChange(),
    isSessionLive: (sessionId) => {
      const facts = sessionFacts.get(sessionId)
      return facts?.state === 'live' || facts?.state === 'starting'
    },
    sessionState: (sessionId) => sessionFacts.get(sessionId) ?? null,
    sessionWorktree: sessionWorktreePath
  })

  const taskService = new TaskService({
    tasks: taskStore,
    repositories: persistence.repositories,
    sessions,
    now: () => Date.now(),
    newId: () => `task_${globalThis.crypto.randomUUID()}`,
    isSessionLive: (sessionId) => {
      const facts = sessionFacts.get(sessionId)
      return facts?.state === 'live' || facts?.state === 'starting'
    },
    // The existing session-scoped listing, reached through the task's own
    // session. No second diff implementation exists.
    listChanges: async (sessionId) => {
      const result = await review.list(sessionId)
      return result.status === 'available'
        ? {
            status: 'available',
            files: result.files.map((file) => ({
              path: file.path,
              oldPath: file.oldPath,
              status: file.status,
              origin: file.origin,
              additions: file.additions,
              deletions: file.deletions,
              binary: file.binary,
              symlink: file.symlink
            })),
            baselineOid: result.baselineOid,
            listTruncated: result.listTruncated
          }
        : { status: 'unavailable', reason: result.reason, detail: result.detail }
    },
    onQueueChanged: () => {
      taskDispatcher.kick()
      emitTaskChange()
    }
  })

  onTaskActivity = (sessionId, activityState) => {
    taskDispatcher.onActivity(sessionId, activityState)
  }

  const taskScheduler = new TaskScheduler({
    tasks: taskStore,
    taskService,
    now: () => Date.now(),
    newOccurrenceId: () => `occ_${globalThis.crypto.randomUUID()}`,
    newScheduleId: () => `sch_${globalThis.crypto.randomUUID()}`,
    onChange: () => emitTaskChange()
  })

  /**
   * Task-change notification.
   *
   * The renderer re-reads the list on this rather than polling: a task changes
   * because main observed something, so main is the one that knows.
   */
  /**
   * Keeps the task layer's view of session liveness current.
   *
   * Facts come from the same events the renderer sees, and are applied BEFORE
   * the dispatcher looks at them, so a task never acts on a stale state.
   */
  const trackSessionFacts = (payload: {
    type?: string
    sessionId?: string
    exitCode?: number
    session?: { id: string; state: string; exitCode: number | null }
  }): void => {
    if (payload.type === 'state' && payload.session) {
      sessionFacts.set(payload.session.id, {
        state: payload.session.state,
        exitCode: payload.session.exitCode
      })
      return
    }
    if (payload.type === 'exit' && payload.sessionId) {
      // The event carries the code the process actually exited with. Defaulting
      // it to 0 here would turn every crash into a clean finish — the exact
      // false completion the task layer must never record.
      const code = (payload as { exitCode?: unknown }).exitCode
      sessionFacts.set(payload.sessionId, {
        state: 'exited',
        exitCode: typeof code === 'number' && Number.isInteger(code) ? code : null
      })
    }
  }

  const taskListeners = new Set<() => void>()
  const emitTaskChange = (): void => {
    for (const listener of taskListeners) {
      try {
        listener()
      } catch {
        // A dead window must not stop the queue.
      }
    }
  }

  let shutdownPromise: Promise<void> | null = null
  const api: AppRuntime = {
    onTaskChange: (listener: () => void) => {
      taskListeners.add(listener)
      return () => taskListeners.delete(listener)
    },
    sessions,
    activity,
    activityServer,
    removals,
    sessionRemovals,
    review,
    files,
    gitWorkspace,
    gitStatusWatcher,
    projectFolders,
    repositoryPreparations,
    onRepoChange: (listener) => {
      repoChangeListeners.add(listener)
      return () => repoChangeListeners.delete(listener)
    },
    tasks: taskService,
    schedules: taskScheduler,
    taskDispatcher,
    harness,
    listHarnesses,
    listWslDistros: async () => toWslDistroListPayload(await discoverWslDistros({ runner: wslRunner })),
    readGuestHome: async (distro) => {
      const outcome = await wslRunner
        .run({
          scope: 'guest',
          distro,
          // `printf` rather than `echo` so no trailing newline becomes part of
          // the path, and quoted so a home containing spaces survives.
          argv: ['sh', '-c', 'printf %s "$HOME"'],
          timeoutMs: 20_000
        })
        .catch(() => null)
      const home = outcome?.status === 'ok' ? outcome.stdout.trim() : ''
      return home.startsWith('/') ? home : null
    },
    startupError,
    ready: Promise.resolve(),
    hostLogPath: () => supervisor.logPath,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        taskScheduler.stop()
        taskDispatcher.stop()
        await gitStatusWatcher.stopAll().catch(() => undefined)
        await activityServer.stop().catch(() => undefined)
        sessions.dispose()
        // Do not stop the detached host: live sessions must survive app exit.
        host.disconnect()
        closeAppPersistence()
      })()
      return shutdownPromise
    }
  }

  /**
   * Boot order: learn the current session states, recover interrupted tasks,
   * then let the pump and the scheduler take over. Recovery must precede the
   * first pump or a task could be dispatched twice — once by recovery's
   * re-queue and once by a pump that still believed it was running.
   */
  void (async () => {
    await refreshSessionFacts().catch(() => undefined)
    // Facts first, dispatcher second: `subscribe` runs listeners in insertion
    // order, so the dispatcher never reads a state this handler has not applied.
    sessions.subscribe((payload) => {
      trackSessionFacts(payload as never)
    })
    taskDispatcher.start()
    const recovered = await taskDispatcher.recover().catch(() => ({ requeued: 0, interrupted: 0 }))
    if (recovered.interrupted > 0 || recovered.requeued > 0) emitTaskChange()
    taskScheduler.start()
    // A schedule may have come due while the app was closed; the first tick
    // applies the age rule, so a long outage cannot replay every missed run.
    void taskScheduler.tick()
  })()

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

import { app, BrowserWindow, Notification } from 'electron'
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
import { WorkspaceFilesService } from '../files/workspace-files-service'
import { WorkspaceFilesWatcherService } from '../files/workspace-files-watcher'
import { GitWorkspaceService } from '../git/git-workspace-service'
import { BranchService } from '../git/branch-service'
import { RemoteService } from '../git/remote-service'
import { CloneService } from '../git/clone-service'
import { CommitMessageService } from '../ai/commit-message-service'
import { MergeStore } from '../persistence/merge-store'
import { MergeService } from '../integration/merge-service'
import { ChainService } from '../integration/chain-service'
import { GitStatusWatcherService } from '../git/status-watcher'
import { TaskStore } from '../tasks/task-store'
import { TaskService } from '../tasks/task-service'
import { TaskDispatcher } from '../tasks/task-dispatcher'
import { TaskScheduler } from '../tasks/task-scheduler'
import { SupervisorStore } from '../persistence/supervisor-store'
import { SupervisorService } from '../supervisor/supervisor-service'
import { AssistantStore } from '../persistence/assistant-store'
import { AssistantService } from '../assistant/assistant-service'
import { AssistantRunner } from '../assistant/assistant-runner'
import { AssistantActions } from '../assistant/assistant-actions'
import { AssistantPolicy } from '../assistant/assistant-policy'
import { AssistantNotifier } from '../assistant/assistant-notifier'
import { ActivityService } from '../activity/activity-service'
import { ActivityHookServer } from '../activity/hook-server'
import { mainT } from '../i18n/main-i18n'
import { activitySocketPath as activityEndpoint } from '../activity/endpoint'
import { installClaudeHooks } from '../activity/claude-hooks'
import { ActivityBroadcaster } from '../activity/activity-broadcaster'
import { WorktreeStore } from '../persistence/worktree-store'
import { GitWorktreeService } from '../worktrees/git-worktree-service'
import { createGitExecutorRouter } from '../git/executor'
import { WslCommandRunner, resolveWslExecutablePath, resolveWslInteropCwd } from '../wsl/exec'
import { profileSocketScope } from '../../host/paths'
import { WslHostLifecycle } from '../wsl/host/lifecycle'
import { createGuestHomeCache } from '../wsl/host/guest-home-cache'
import { createWslHolder, createHolderRecordStore } from '../wsl/host/holder'
import { createWindowsProcessQuery } from '../wsl/host/windows-process'
import { createGuestHostStore } from '../wsl/host/guest-store'
import { WslHostRelay } from '../wsl/relay/endpoint'
import { createTargetValidator } from '../wsl/repository-target'
import { loadWslArtifacts, type WslArtifactLoad } from '../wsl/host/artifact-locating'
import type { HostArtifactManifest } from '../wsl/host/deploy'
import { createGuestHarnessDetector, withGuestLaunchCommand } from '../wsl/harness/guest-harness-detector'
import { createGuestHarnessProbeCache } from '../wsl/harness/guest-harness-probe-cache'
import { createDetectionResultCache } from '../harness/detection-result-cache'
import { resolvePathATerminal } from '../wsl/terminal/path-a'
import { toGuestVisiblePath } from '../wsl/guest-visible-path'
import { createWslHostClientPool } from '../sessions/wsl-host-client-pool'
import { createWorkspaceTrust } from '../harness/trust/workspace-trust'
import { nativeLaunchSpec, providerLaunchSpec } from '../../shared/provider-launch'
import {
  materializeClaudeProviderOverlay,
  pruneClaudeProviderOverlays
} from '../harness/claude-provider-overlay'
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
  /** Worktree-scoped file browsing, editing and search for the tools panel. */
  files: WorkspaceFilesService
  /** Worktree-scoped Git state and stage/commit operations. */
  gitWorkspace: GitWorkspaceService
  /** Local branch refs, name validation, and chain-branch creation. */
  branchRefs: BranchService
  /** Git remotes for a registered repository: list, add, edit, remove, fetch. */
  remotes: RemoteService
  /** Streaming clone into a new project folder. */
  clone: CloneService
  /** Local merge into a target branch, with durable claims and conflicts. */
  merges: MergeService
  /** One-shot AI commit-message drafts from the staged index. */
  commitMessages: CommitMessageService
  /** Watches visible local worktrees and emits coalesced status changes. */
  gitStatusWatcher: GitStatusWatcherService
  /** Watches the visible Files pane's worktree; polling covers unsupported targets. */
  filesWatcher: WorkspaceFilesWatcherService
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
  /** One project-scoped control session and its local control plane. */
  supervisor: SupervisorService
  /** The global Mira thread. */
  assistant: AssistantService
  /** Subscribe to task changes so a window can re-read the queue. */
  onTaskChange: (listener: () => void) => () => void
  harness: HarnessDetector
  /**
   * Harnesses for a repository's own execution target.
   *
   * Omit `repoId` for this machine, which is what every pre-W9 caller meant.
   */
  listHarnesses: (input?: { repoId?: string; force?: boolean }) => Promise<HarnessDetectionResult[]>
  /** Drops cached Harness detection after a provider mutation. */
  invalidateHarnessDetection: () => void
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

  let taskStoreForActivity: TaskStore | null = null
  const activityBroadcaster = new ActivityBroadcaster({
    isTaskSession: (sessionId) =>
      taskStoreForActivity?.findBySessionId(sessionId as never) != null
  })
  /**
   * Set once the task layer exists. Activity is constructed before tasks (it is
   * a session concern), so the link is a callback rather than a constructor
   * argument — but it is the *only* signal that distinguishes a finished turn
   * from a live process, so it must not be forgotten.
   */
  let onTaskActivity: ((sessionId: string, activity: { state: string; outcome: string | null }) => void) | null = null
  let assistantNotifier: AssistantNotifier | null = null
  const activity = new ActivityService({
    isKnownSession: (sessionId) => persistence.sessions.findById(sessionId as never) !== null,
    onTransition: (transition) => {
      const row = persistence.sessions.findById(transition.sessionId as never)
      activityBroadcaster.handle(transition, row?.title ?? mainT('notifications.sessionTitle'))
      assistantNotifier?.onChange()
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
        `[icode] activity event rejected (${reason}) session=${String(event.sessionId ?? '?')}\n`
      )
    }
  })
  const activityServer = new ActivityHookServer({
    socketPath: activitySocketPath,
    ingest: (event) => activity.ingest(event),
    onRejected: (reason, detail) => {
      process.stderr.write(`[icode] activity payload dropped (${reason}) ${detail ?? ''}\n`)
    }
  })

  /**
   * One guest command runner for the process. It holds no per-distro state, so a
   * distro restart needs no invalidation.
   */
  const isWindowsHost = process.platform === 'win32'
  const wslRunner = new WslCommandRunner()
  /**
   * `$HOME` is stable for a distro registration and is consulted by worktree
   * routing, trust, the relay and the folder picker. One cached probe replaces
   * a fresh `wsl.exe` spawn at each call site.
   */
  const guestHomeCache = createGuestHomeCache(wslRunner)

  /**
   * Harness workspace trust is prepared for every session, not only Claude.
   * The service owns the per-harness adapters and writes only the record a user
   * would create by accepting a harness's own trust dialog.
   */
  const workspaceTrust = createWorkspaceTrust({
    runner: wslRunner,
    localHome: app.getPath('home'),
    readGuestHome: (distro) => guestHomeCache.read(distro)
  })
  /**
   * Worktree scope for WSL: derived from the profile directory, exactly as the
   * Host relay scope is, so two iCode profiles on one distro never share checkouts.
   */
  const wslProfileScope = (): string => profileSocketScope(app.getPath('userData'))
  /**
   * The W3 tree, read once.
   *
   * Its absence must not block a local-only user, so nothing here throws at
   * startup: the relay is built on first use and reports a typed failure if the
   * tree is missing.
   */
  const wslArtifacts: WslArtifactLoad = isWindowsHost
    ? loadWslArtifacts()
    : {
        ok: false,
        root: '',
        error: makeAppError(
          'WSL_HOST_DEPLOY_FAILED',
          'WSL is only available on Windows.'
        )
      }

  const supervisor = new HostSupervisor(undefined, {
    ICODE_ACTIVITY_SOCKET: activitySocketPath
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
      readGuestHome: (distro, options) => guestHomeCache.read(distro, options ?? {}),
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
  /**
   * Discovery is expensive in WSL (shell + login PATH + one lookup + one version
   * probe per harness). The dialog asks for the list and Start asks again; these
   * caches make the second question free for a short while.
   */
  const harnessProbes = createGuestHarnessProbeCache(wslRunner)
  const detectionResults = createDetectionResultCache()
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
        const home = await guestHomeCache.read(distro)
        return home === null ? null : `${home}/.icode/worktrees/${wslProfileScope()}`
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
    readGuestHome: (distro) => guestHomeCache.read(distro)
  })
  // Resume preparation that was interrupted by the previous application exit.
  // Starting is non-blocking; the project rows already exist and the renderer
  // will read their persisted state on first load.
  repositoryPreparations.resume()
  /**
   * A detection answer is about one harness on one distro registration. The
   * registration id is part of the key: a replaced distro with the same name
   * must not inherit the old answer.
   */
  function detectionKey(id: HarnessId, target: Extract<ExecutionTarget, { kind: 'wsl' }>): string {
    return `${target.distro.trim().toLowerCase()}\u0000${target.distroId ?? ''}\u0000${id}`
  }

  function detectionPrefix(target: Extract<ExecutionTarget, { kind: 'wsl' }>): string {
    return `${target.distro.trim().toLowerCase()}\u0000${target.distroId ?? ''}\u0000`
  }

  /**
   * Detects one Harness **for a specific execution target**.
   *
   * This is the only place the distinction lives, because both the session
   * service and the Harness list in the UI must agree. A WSL target is probed
   * inside its own distro: a local `claude` on PATH says nothing about the guest.
   */
  async function detectHarnessForTarget(
    id: HarnessId,
    target: ExecutionTarget,
    options: { force?: boolean } = {}
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

    const key = detectionKey(id, target)
    if (options.force !== true) {
      const cached = detectionResults.get(key)
      if (cached !== null) return cached
    }

    const { snapshot, transient } = await harnessProbes.get(target.distro, {
      ...(options.force === true ? { force: true } : {})
    })
    const { detector, context } = await createGuestHarnessDetector({
      runner: wslRunner,
      distro: target.distro,
      probe: snapshot
    })
    const detection = withGuestLaunchCommand(await detector.detectOne(id), {
      shell: context.shell
    })
    if (!transient && detection.state !== 'detection_failed') {
      detectionResults.set(key, detection)
    }
    return detection
  }

  /** One answer per in-flight provider change; detection is target-independent. */
  function invalidateHarnessDetection(): void {
    detectionResults.invalidate()
    harnessProbes.invalidate()
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

  /**
   * Provider launch inputs for one harness.
   *
   * The selection is read at launch time so changing it affects the next
   * session without restarting iCode. Provider credentials normally travel in
   * the PTY environment; Claude still receives its keyless hook overlay as a
   * second set of arguments.
   */
  const providerOverlayDirectory = join(activityDirectory, 'providers')
  pruneClaudeProviderOverlays(providerOverlayDirectory, Date.now())
  function launchSpecForHarness(
    id: HarnessId,
    target: ExecutionTarget
  ): { args: string[]; env: Record<string, string> } {
    if (id === 'shell') return nativeLaunchSpec()
    const provider = persistence.providers.selected(id)
    if (provider === null) {
      if (id !== 'claude') return nativeLaunchSpec()
      if (target.kind !== 'wsl') return { args: hooks.launchArgs, env: {} }
      if (hooks.guestSettingsPath === null) return nativeLaunchSpec()
      return { args: ['--settings', toGuestVisiblePath(hooks.guestSettingsPath)], env: {} }
    }

    const spec = providerLaunchSpec(provider)
    if (id !== 'claude') return { args: spec.args, env: spec.env }

    const hookArgs =
      target.kind === 'wsl'
        ? hooks.guestSettingsPath === null
          ? []
          : ['--settings', toGuestVisiblePath(hooks.guestSettingsPath)]
        : hooks.launchArgs

    if (Object.keys(spec.claudeEnv).length === 0) {
      return { args: [...spec.args, ...hookArgs], env: spec.env }
    }

    // Fallback only: merge the provider env into the hook overlay, because two
    // `--settings` files replace `env` instead of deep-merging it.
    const basePath =
      target.kind === 'wsl' && hooks.guestSettingsPath !== null
        ? hooks.guestSettingsPath
        : hooks.settingsPath
    const overlayPath = materializeClaudeProviderOverlay({
      baseSettingsPath: basePath,
      directory: providerOverlayDirectory,
      env: spec.claudeEnv
    })
    return {
      args: [
        ...spec.args,
        '--settings',
        target.kind === 'wsl' ? toGuestVisiblePath(overlayPath) : overlayPath
      ],
      env: {}
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
     * Claude always receives the hook overlay; a selected provider adds its
     * environment to the same document. Codex and OpenCode receive args/env.
     *
     * A WSL Agent gets its own overlay, because its hook commands must cross into
     * Windows; the file is read through `/mnt/<drive>/…`, since a Windows path is
     * not a path inside the distro.
     */
    launchSpec: (id, target) => launchSpecForHarness(id, target),
    onIncarnation: (sessionId, incarnationId) => activity.bindIncarnation(sessionId, incarnationId),
    activityFor: (sessionId) => activity.get(sessionId)
  })

  let startupError: AppError | null = null
  let reconcile: SessionListView | null = null
  try {
    await activityServer.start()
  } catch (error) {
    // Activity is advisory: a failed listener must not block the workspace.
    process.stderr.write(`[icode] activity listener failed: ${String(error)}\n`)
  }

  try {
    sessions.start()
    reconcile = await sessions.reconcile()
    if (sessions.getLastHostError()) {
      process.stderr.write(
        `[icode] host reconciliation incomplete: ${sessions.getLastHostError()?.message}\n`
      )
    }
  } catch (error) {
    startupError = makeAppError('INTERNAL', 'iCode could not complete startup reconciliation.', {
      detail: error instanceof Error ? error.message : String(error),
      context: { log: supervisor.logPath }
    })
    process.stderr.write(`[icode] startup reconciliation failed: ${String(error)}\n`)
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

  let taskStoreForRemoval: TaskStore | null = null
  const sessionRemovals = new SessionRemovalService({
    database: persistence.database,
    sessions: persistence.sessions,
    repositories: persistence.repositories,
    worktrees,
    gitWorktrees,
    host,
    workspaceTrust,
    summarise: (sessionId) => sessions.get(sessionId),
    activeTasksOnChain: (repoId, branch) =>
      taskStoreForRemoval?.countActiveTasksOnChain(repoId, branch) ?? 0
  })

  // The repository list asks a distro about its own checkout; without this the
  // only available answer would be a local stat, which is the wrong machine.
  persistence.repositoryService.useHostFs((target) => gitWorktrees.hostFsFor(target))

  const files = new WorkspaceFilesService({
    sessions,
    repositories: persistence.repositories,
    worktrees,
    gitWorktrees,
    runner: wslRunner,
    trashStateFile: join(app.getPath('userData'), 'files-trash.json')
  })
  // Best-effort retention; never blocks startup or a session.
  void files.purgeTrash().catch(() => undefined)

  const gitWorkspace = new GitWorkspaceService({
    repositories: persistence.repositories,
    worktrees,
    gitWorktrees,
    sessions
  })
  const branchRefs = new BranchService({
    repositories: persistence.repositories,
    worktrees,
    gitWorktrees
  })
  const remotes = new RemoteService({
    repositories: persistence.repositories,
    gitWorktrees
  })
  const clone = new CloneService({
    gitWorktrees,
    projectFolders,
    runner: wslRunner
  })
  const commitMessages = new CommitMessageService({
    sessions,
    gitWorkspace,
    detectHarness: detectHarnessForTarget,
    wslRunner
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
   * Files watches the checkout itself (not the Git directory). A local path is
   * watched directly; a WSL worktree on DrvFs uses the same translated Windows
   * path as the Git watcher; an ext4 guest returns null and the renderer polls.
   */
  const resolveFilesWatchTarget = async (sessionId: string) => {
    const record = worktrees.findBySession(sessionId)
    if (!record) return null
    const repository = persistence.repositories.findById(record.repoId)
    if (!repository) return null
    if (repository.executionTarget.kind === 'local') {
      return { worktreePath: record.path }
    }
    const worktreePath = await translateGuestWatchPath(
      repository.executionTarget.distro,
      record.path
    )
    return worktreePath === null ? null : { worktreePath }
  }

  const filesWatcher = new WorkspaceFilesWatcherService({
    resolveTarget: resolveFilesWatchTarget
  })

  /**
   * The Harness list for one execution target.
   *
   * Detection is per target, not per app: a WSL repository's Agents live inside
   * the distro, so showing this machine's probes would be a confident wrong
   * answer — and would offer an Agent that the guest cannot run.
   */
  async function listHarnesses(
    input: { repoId?: string; force?: boolean } = {}
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
    if (input.force === true && target.kind === 'wsl') {
      detectionResults.invalidate(detectionPrefix(target))
      harnessProbes.invalidate(target.distro)
    }
    return Promise.all(
      HARNESS_IDS.map((id) =>
        detectHarnessForTarget(id, target, {
          ...(input.force === true ? { force: true } : {})
        })
      )
    )
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
  taskStoreForRemoval = taskStore
  const mergeStore = new MergeStore(persistence.database)
  const chainService = new ChainService({
    repositories: persistence.repositories,
    tasks: taskStore,
    gitWorktrees,
    branches: branchRefs
  })
  taskStoreForActivity = taskStore
  let supervisorService: SupervisorService | null = null

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
    sessionWorktree: sessionWorktreePath,
    activity,
    resolveTaskBase: (task) => chainService.resolveTaskBase(task)
  })

  const mergeService = new MergeService({
    database: persistence.database,
    repositories: persistence.repositories,
    worktrees,
    merges: mergeStore,
    tasks: taskStore,
    gitWorktrees,
    gitWorkspace,
    now: () => Date.now(),
    newId: () => `merge_${globalThis.crypto.randomUUID()}`,
    onChanged: () => {
      taskDispatcher.kick()
      emitTaskChange()
    }
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
      const result = await gitWorkspace.sessionChanges(sessionId)
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
    },
    merges: mergeStore
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

  const supervisorStore = new SupervisorStore(persistence.database)
  supervisorService = new SupervisorService({
    userDataDir: app.getPath('userData'),
    execPath: process.execPath,
    now: () => Date.now(),
    store: supervisorStore,
    sessions,
    tasks: taskService,
    taskStore,
    repositories: persistence.repositories,
    gitWorkspace,
    workspaceFiles: files,
    listHarnesses,
    activity,
    onError: (error) => {
      process.stderr.write(`[icode] supervisor: ${String(error)}\n`)
    }
  })
  await supervisorService.start().catch((error) => {
    process.stderr.write(`[icode] supervisor control plane failed to start: ${String(error)}\n`)
  })

  const assistantStore = new AssistantStore(persistence.database)
  const assistantPolicy = new AssistantPolicy({ tasks: taskStore, now: () => Date.now() })
  const newAssistantId = (prefix: string): string =>
    `${prefix}_${globalThis.crypto.randomUUID()}`
  const assistantRunner = new AssistantRunner({
    store: assistantStore,
    actionsFor: (threadId, runId) =>
      new AssistantActions({
        store: assistantStore,
        tasks: taskService,
        taskStore,
        sessions,
        supervisors: supervisorService!,
        repositories: persistence.repositories,
        gitWorkspace,
        policy: assistantPolicy,
        listHarnesses,
        threadId,
        runId,
        now: () => Date.now()
      }),
    taskStore,
    tasks: taskService,
    repositories: persistence.repositories,
    sessions,
    settings: () => assistantStore.getSettings(),
    detectHarness: detectHarnessForTarget,
    listWslDistros: async () =>
      toWslDistroListPayload(await discoverWslDistros({ runner: wslRunner })),
    readGuestHome: (distro) => guestHomeCache.read(distro),
    wslRunner,
    workspaceTrust,
    userDataDir: app.getPath('userData'),
    resumeEnabled: true,
    newId: newAssistantId,
    now: () => Date.now(),
    onError: (error) => {
      process.stderr.write(`[icode] assistant runner: ${String(error)}\n`)
    }
  })
  const assistantService = new AssistantService({
    store: assistantStore,
    now: () => Date.now(),
    newId: newAssistantId,
    runner: assistantRunner,
    onError: (error) => {
      process.stderr.write(`[icode] assistant: ${String(error)}\n`)
    }
  })
  assistantService.start()
  assistantNotifier = new AssistantNotifier({
    service: assistantService,
    taskStore,
    repositories: persistence.repositories,
    settings: () => assistantStore.getSettings(),
    now: () => Date.now(),
    isWindowFocused: () => BrowserWindow.getFocusedWindow() !== null,
    onOsNotify: ({ title, body, messageId }) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body })
      notification.on('click', () => {
        const window = BrowserWindow.getAllWindows().find((entry) => !entry.isDestroyed())
        if (window) {
          window.show()
          window.focus()
        }
        assistantService.focus(messageId)
      })
      notification.show()
    }
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
    supervisorService?.notifyTaskChange()
    assistantNotifier?.onChange()
    for (const listener of taskListeners) {
      try {
        listener()
      } catch {
        // A dead window must not stop the queue.
      }
    }
  }

  let shutdownPromise: Promise<void> | null = null
  let taskArchiveTimer: NodeJS.Timeout | null = null
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
    files,
    gitWorkspace,
    branchRefs,
    remotes,
    clone,
    merges: mergeService,
    commitMessages,
    gitStatusWatcher,
    filesWatcher,
    projectFolders,
    repositoryPreparations,
    onRepoChange: (listener) => {
      repoChangeListeners.add(listener)
      return () => repoChangeListeners.delete(listener)
    },
    tasks: taskService,
    schedules: taskScheduler,
    taskDispatcher,
    supervisor: supervisorService!,
    assistant: assistantService,
    harness,
    listHarnesses,
    invalidateHarnessDetection,
    listWslDistros: async () => toWslDistroListPayload(await discoverWslDistros({ runner: wslRunner })),
    readGuestHome: (distro) => guestHomeCache.read(distro),
    startupError,
    ready: Promise.resolve(),
    hostLogPath: () => supervisor.logPath,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        if (taskArchiveTimer !== null) clearInterval(taskArchiveTimer)
        taskArchiveTimer = null
        // Stop in-flight clones and remove their partial destinations.
        clone.cancelAll()
        assistantNotifier?.stop()
        assistantService.stop()
        taskScheduler.stop()
        taskDispatcher.stop()
        await supervisorService?.stop().catch(() => undefined)
        await gitStatusWatcher.stopAll().catch(() => undefined)
        await filesWatcher.stopAll().catch(() => undefined)
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
      assistantNotifier?.onChange()
    })
    await mergeService.reconcileInterrupted().catch(() => undefined)
    taskDispatcher.start()
    const recovered = await taskDispatcher.recover().catch(() => ({ requeued: 0, interrupted: 0 }))
    if (recovered.interrupted > 0 || recovered.requeued > 0) emitTaskChange()
    taskScheduler.start()
    // Reversible retention: reviewed completions and cancellations leave the
    // working list after a week; review-pending and failed work stay put.
    taskService.archiveStale(7)
    taskArchiveTimer = setInterval(() => {
      taskService.archiveStale(7)
    }, 6 * 60 * 60 * 1000)
    taskArchiveTimer.unref?.()
    void assistantNotifier?.start()
    // A schedule may have come due while the app was closed; the first tick
    // applies the age rule, so a long outage cannot replay every missed run.
    void taskScheduler.tick()
  })()

  runtime = api
  // `will-quit` runs after every window has closed. A cancelled window-close
  // (the unsaved Files prompt) must not tear down persistence while the window
  // is still on screen, which `before-quit` would do on macOS Cmd+Q.
  app.on('will-quit', () => {
    void api.shutdown()
  })
  return api
}

/** Compatibility modes and tests must not touch the user's database. */
export function resetAppRuntimeForTests(): void {
  runtime = null
}

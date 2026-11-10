import { mainT } from '../i18n/main-i18n'
import type { Database } from '../persistence/database'
import type { RepositoryStore } from '../persistence/repository-store'
import type { SessionStore } from '../persistence/session-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import { describeWorktree, samePath } from '../worktrees/worktree-status'
import { branchNameForSession } from '../../shared/domain/worktree'
import { isValidBranchName } from '../../shared/domain/branch'
import type { SessionWorktreeRecord, WorktreeSummary } from '../../shared/domain/worktree'
import type { StoredSession } from '../persistence/rows'
import type { HostGateway } from './host-gateway'
import type { ListSessionsPayload } from '../../shared/host-protocol'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import { makeAppError } from '../../shared/domain/errors'
import type { AppError } from '../../shared/domain/errors'
import type { ExecutionTarget } from '../../shared/domain/repository'
import {
  buildWslTerminalArgs,
  hostTargetFor as pathAHostTargetFor,
  isPathATerminal,
  LOCAL_TARGET,
  type PathATerminalOutcome
} from '../wsl/terminal/path-a'
import { resolvedShellCommand } from '../harness/default-shell'
import { SessionServiceError, errorFromHost } from './session-errors'
import { harnessLabel, type HarnessId } from '../../shared/domain/harness'
import { wakePlan } from '../../shared/domain/session-sleep'
import {
  newSessionId,
  parseRepoId,
  parseSessionId,
  toPtyIncarnationId,
  type PtyIncarnationId,
  type SessionId
} from '../../shared/domain/ids'
import {
  isActiveSessionState,
  normalizeSessionTitle,
  reconcileSessionState,
  type HostObservation,
  type PersistedSessionObservation,
  type ReconciledSessionState,
  type SessionRole
} from '../../shared/domain/session'
import type { HostSessionStatus } from '../../shared/domain/session'
import type {
  CreateOrAttachPayload,
  HostEvent,
  SessionInfo
} from '../../shared/host-protocol'
import type {
  CreateSessionInput,
  OrphanedHostSession,
  RendererSessionEvent,
  SessionListView,
  SessionSummary,
  TerminalAttachPayload
} from '../../shared/schemas/ipc'
import { HostRequestError } from '../host/host-client'
import { withLaunchArgs } from '../harness/launch-command'
import type { WorkspaceTrustService } from '../harness/trust/workspace-trust'


export type SessionServiceDeps = {
  database: Database
  repositories: RepositoryStore
  sessions: SessionStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  host: HostGateway
  /**
   * Seeds the harness's per-folder trust record for a new session worktree.
   *
   * Best-effort: a config that cannot be written must not prevent a session from
   * starting; the harness may then show its normal trust prompt.
   */
  workspaceTrust?: WorkspaceTrustService
  /**
   * Discovery for one harness **on the host that owns the repository**.
   *
   * The target is required rather than optional: a guest repository discovered
   * with Windows PATH evidence would report a Windows shim as an available
   * harness, which is the exact failure W7 exists to prevent.
   */
  detectHarness: (
    harness: HarnessId,
    target: ExecutionTarget
  ) => Promise<HarnessDetectionResult>
  /**
   * Path A: the local WSL terminal.
   *
   * Supplied by the composition root so the service stays free of `wsl.exe`
   * details. Absent means "no Path A", and a WSL terminal is refused rather than
   * served by a local shell.
   */
  resolveWslTerminal?: (
    target: ExecutionTarget,
    guestCwd: string
  ) => Promise<PathATerminalOutcome>
  /**
   * Provider and overlay inputs for a harness launch.
   *
   * Target-aware because `--settings` must name a path the *process that reads
   * it* can open: the same file is a Windows path for a local session and a
   * `/mnt/…` path for a guest one. `env` is handed to the terminal host and
   * merged into the PTY environment.
   */
  launchSpec?: (
    harness: HarnessId,
    target: ExecutionTarget
  ) => { args: string[]; env: Record<string, string> }
  /**
   * Reports the incarnation a session is now bound to, or null when the process
   * is gone. Activity uses this to reject events from a previous process.
   */
  onIncarnation?: (sessionId: string, incarnationId: string | null) => void
  /** Advisory activity snapshot for a session; `null` when nothing is known. */
  activityFor?: (sessionId: string) => SessionSummary['activity']
  now?: () => number
  newSessionId?: () => SessionId
}

type Listener = (event: RendererSessionEvent) => void

/** One host identity: local, or a distro registration. Mirrors the pool's key. */
function targetKey(target: ExecutionTarget): string {
  return target.kind === 'wsl'
    ? `wsl:${target.distro.trim().toLowerCase()}\u0000${target.distroId ?? ''}`
    : 'local'
}

const TERMINAL_STATES = new Set<HostSessionStatus>(['exited', 'failed'])

function hostObservation(entry: SessionInfo | undefined): HostObservation {
  if (!entry) return { reachable: true, session: null }
  return {
    reachable: true,
    session: {
      status: entry.status,
      incarnationId: entry.incarnationId as PtyIncarnationId,
      ptyPid: entry.ptyPid,
      exitCode: entry.exitCode,
      stopRequested: entry.stopRequested
    }
  }
}

/**
 * Coordinates durable session metadata with the PTY-owning host. The database
 * records observations; the host is the only source of process truth.
 */
export class SessionService {
  private readonly listeners = new Set<Listener>()
  private readonly currentIncarnations = new Map<string, string>()
  private readonly now: () => number
  private readonly makeSessionId: () => SessionId
  private disposeHostEvents: (() => void) | null = null

  constructor(private readonly deps: SessionServiceDeps) {
    this.now = deps.now ?? Date.now
    this.makeSessionId = deps.newSessionId ?? newSessionId
  }

  start(): void {
    if (this.disposeHostEvents) return
    this.disposeHostEvents = this.deps.host.onEvent((event) => this.onHostEvent(event))
  }

  dispose(): void {
    this.disposeHostEvents?.()
    this.disposeHostEvents = null
    this.listeners.clear()
    this.currentIncarnations.clear()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Whether this session is a **Path A** local WSL terminal.
   *
   * Path A is the *shell* harness on a WSL repository: a terminal whose PTY is the
   * desktop Host's, whose child is `wsl.exe`, and whose guest shell starts in the
   * repository's guest directory. A coding Agent on the same repository is Path B
   * and keeps the managed Host.
   *
   * Derived from persisted rows only — the session's harness and its repository's
   * target — so a reopened session lands on the same path it was created with.
   */
  private isPathATerminal(harness: HarnessId, target: ExecutionTarget): boolean {
    return isPathATerminal(harness, target)
  }

  /**
   * The host that owns a session's PTY.
   *
   * Every terminal operation must use this rather than the repository target: a
   * Path A terminal lives on the **desktop** Host even though its repository is a
   * WSL repository. Using the WSL target for `write`, `resize` or `kill` would
   * send the call to the managed Guest Host, which does not own that PTY.
   */
  private hostTargetFor(harness: HarnessId, target: ExecutionTarget): ExecutionTarget {
    return pathAHostTargetFor(harness, target)
  }

  /**
   * Resolves the Path A launch, or throws a typed error.
   *
   * Every failure here means **no terminal**: there is no fallback to a local
   * shell, because a local shell would be the wrong machine's filesystem.
   */
  private async requirePathATerminal(
    target: ExecutionTarget,
    guestCwd: string
  ): Promise<{ command: string; args: string[]; ptyCwd: string; distro: string }> {
    if (!this.deps.resolveWslTerminal) {
      throw new SessionServiceError(
        makeAppError('WSL_UNAVAILABLE', 'This build cannot open a local WSL terminal.')
      )
    }
    const outcome = await this.deps.resolveWslTerminal(target, guestCwd)
    if (outcome.status === 'ready') {
      return {
        command: outcome.launch.command,
        args: outcome.launch.args,
        ptyCwd: outcome.launch.ptyCwd,
        distro: outcome.launch.distro
      }
    }
    if (outcome.status === 'failed') {
      throw new SessionServiceError(outcome.failure.error)
    }
    throw new SessionServiceError(
      makeAppError('WSL_UNAVAILABLE', 'That repository is not a WSL repository.')
    )
  }

  // ─── Reconciliation ───────────────────────────────────────────────

  /** The owning target for a row, without throwing on a damaged record. */
  /**
   * The host that owns a stored session's PTY.
   *
   * A Path A terminal belongs to the **desktop** host even though its repository
   * targets a distro. Judging it by the distro's host reported a live terminal as
   * `unavailable` as soon as it exited, because the managed Guest Host had never
   * heard of it.
   */
  private targetForKey(row: StoredSession): ExecutionTarget {
    try {
      return this.hostTargetFor(row.harness, this.targetForSession(row))
    } catch {
      return LOCAL_TARGET
    }
  }

  /**
   * One target per host that can own a session: local first, then each distinct
   * WSL registration among registered repositories.
   */
  private distinctTargets(): ExecutionTarget[] {
    const targets: ExecutionTarget[] = [LOCAL_TARGET]
    const seen = new Set<string>()
    for (const repository of this.deps.repositories.list()) {
      const target = repository.executionTarget
      if (target.kind !== 'wsl') continue
      const key = `${target.distro.trim().toLowerCase()}\u0000${target.distroId ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push(target)
    }
    return targets
  }

  async reconcile(): Promise<SessionListView> {
    const rows = this.deps.sessions.listAll()
    let hostSessions: SessionInfo[] | null = null
    let hostError: AppError | null = null
    /** One result per host, so each session is judged by its own host. */
    const byHostKey = new Map<string, { ok: true; list: ListSessionsPayload } | { ok: false }>()
    let allHostsAnswered = true
    try {
      // Every host that can own a session is asked: the local one, plus each
      // distinct distro a registered repository points at. Asking only the local
      // host would report every WSL session as `unavailable`.
      const targets = this.distinctTargets()
      const results = await Promise.all(
        targets.map((target) =>
          this.deps.host
            .listSessions(target)
            .then((list) => ({ ok: true as const, list }))
            .catch((error: unknown) => ({ ok: false as const, error }))
        )
      )
      // Per host, not all-or-nothing: a session is only "unknown" when *its own*
      // host could not answer. With one host this is exactly the previous
      // behaviour; with several it stops an unreachable local Host from blanking
      // every WSL session's state.
      results.forEach((result, index) => {
        const target = targets[index]!
        byHostKey.set(targetKey(target), result)
        if (!result.ok && hostError === null) {
          hostError = errorFromHost(result.error, 'Could not query the terminal host.')
        }
      })
      hostSessions = results.flatMap((result) => (result.ok ? result.list.sessions : []))
      allHostsAnswered = results.every((result) => result.ok)
    } catch (error) {
      hostError = errorFromHost(error, 'Could not query the terminal host.')
      hostSessions = null
      allHostsAnswered = false
    }

    const bySessionId = new Map<string, SessionInfo>()
    for (const entry of hostSessions ?? []) bySessionId.set(entry.sessionId, entry)

    // Repair the two safe directions of worktree lifecycle drift. Nothing here
    // deletes: an incomplete worktree is reported, never auto-removed.
    await this.repairWorktreeStates(bySessionId)

    const summaries: SessionSummary[] = []
    const changed: Array<{ id: SessionId; observation: PersistedSessionObservation }> = []

    /**
     * Worktree existence, asked of the host that owns the checkout.
     *
     * `describeWorktree` answers "is it there?" with the local filesystem when it
     * is not told otherwise. For a distro checkout that question is about the
     * wrong machine, and a healthy guest worktree came back as `missing` — which
     * the UI renders as a warning and which disables Restart. Non-local targets
     * are therefore resolved here, once per reconcile, through the same router
     * the worktree service uses everywhere else.
     */
    const worktreeExists = await this.resolveWorktreeExistence(rows)

    for (const row of rows) {
      const entry = bySessionId.get(row.id)
      // A row whose own host failed is unknown; a row whose host answered keeps
      // its state even if another host is down.
      const ownHost = byHostKey.get(targetKey(this.targetForKey(row)))
      // Only this row's own host decides. `allHostsAnswered` is the fallback for a
      // row whose host was not queried at all (e.g. an unregistered repository).
      const reachable = ownHost === undefined ? allHostsAnswered : ownHost.ok
      const observation: HostObservation = reachable
        ? hostObservation(entry)
        : { reachable: false }
      const reconciled = reconcileSessionState(row.observation, observation)
      const summary = this.toSummary(row, reconciled, entry?.cwd ?? null, worktreeExists.get(row.id))
      summaries.push(summary)
      if (entry && (entry.status === 'live' || entry.status === 'starting')) {
        this.currentIncarnations.set(row.id, entry.incarnationId)
      }
      const next = this.observationFor(row, reconciled)
      if (this.observationChanged(row.observation, next)) {
        changed.push({ id: row.id, observation: next })
      }
    }

    if (changed.length > 0) {
      this.deps.database.transaction(() => {
        for (const item of changed) this.deps.sessions.recordObservation(item.id, item.observation)
      })
    }

    const known = new Set(rows.map((row) => String(row.id)))
    const orphans: OrphanedHostSession[] = (hostSessions ?? [])
      .filter((entry) => !known.has(entry.sessionId) && !TERMINAL_STATES.has(entry.status))
      .map((entry) => ({
        sessionId: entry.sessionId,
        incarnationId: entry.incarnationId,
        ptyPid: entry.ptyPid,
        cwd: entry.cwd,
        command: entry.command,
        status: entry.status,
        cols: entry.cols,
        rows: entry.rows
      }))

    if (hostError) {
      // Keep the error observable to callers without pretending it is a verdict
      // on any individual process; summaries already say `unavailable`.
      this.lastHostError = hostError
    } else {
      this.lastHostError = null
    }

    return { sessions: summaries, orphans }
  }

  /** Idempotent across launches: repeated reconciliation converges. */
  private async repairWorktreeStates(bySessionId: Map<string, SessionInfo>): Promise<void> {
    const records = this.deps.worktrees.listAll()
    for (const record of records) {
      const host = bySessionId.get(record.sessionId)
      const hostActive = host !== undefined && (host.status === 'live' || host.status === 'starting')
      if (record.state === 'created' && hostActive) {
        this.deps.worktrees.updateState(record.sessionId, 'ready', null, this.now())
        continue
      }
      if (record.state !== 'creating') continue
      const repository = this.deps.repositories.findById(record.repoId)
      if (!repository) continue
      const inspection = await this.deps.gitWorktrees
        .inspect({
          primaryRoot: repository.path,
          path: record.path,
          branch: record.branch,
          target: repository.executionTarget
        })
        .catch(() => null)
      if (inspection?.pathExists === true && inspection.registered) {
        // Creation completed before the crash; the PTY was never started.
        this.deps.worktrees.updateState(record.sessionId, 'created', null, this.now())
      }
    }
  }

  private lastHostError: AppError | null = null

  getLastHostError(): AppError | null {
    return this.lastHostError
  }

  async list(repoId?: string): Promise<SessionListView> {
    const view = await this.reconcile()
    if (!repoId) return view
    return {
      sessions: view.sessions.filter((session) => session.repoId === repoId),
      orphans: view.orphans
    }
  }

  async get(sessionId: string): Promise<SessionSummary> {
    const row = this.requireRow(sessionId)
    const view = await this.reconcile()
    const summary = view.sessions.find((session) => session.id === row.id)
    if (!summary) {
      throw new SessionServiceError(
        makeAppError('SESSION_NOT_FOUND', 'Session metadata is missing.', {
          context: { sessionId }
        })
      )
    }
    return summary
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  async create(
    input: CreateSessionInput,
    options: {
      role?: SessionRole
      /**
       * Main-process only. Task dispatch pins the exact commit (chain tip or a
       * resolved start-from tip); the renderer can never supply an OID.
       */
      base?: { ref: string | null; oid: string }
    } = {}
  ): Promise<SessionSummary> {
    const repoId = parseRepoId(input.repoId)
    if (!repoId) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Invalid repository ID.', {
          context: { repoId: input.repoId }
        })
      )
    }
    const repository = this.deps.repositories.findById(repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Repository is not registered.', {
          context: { repoId: input.repoId }
        })
      )
    }
    const workspace = this.deps.repositories.workspaceForRepo(repository.id)
    if (!workspace) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Repository is missing its primary checkout.', {
          context: { repoId: repository.id }
        })
      )
    }

    // The routing authority is the persisted repository record — never the path
    // string. A guest path and a Windows path are both "just strings".
    const target = repository.executionTarget
    // Path A owns its own shell resolution: the distro's login shell is what a
    // terminal must run, and Orca probes nothing for it (`wsl.exe` is the shell).
    const pathA = this.isPathATerminal(input.harness, target)
    const detection = pathA ? null : await this.requireHarness(input.harness, target)
    // Resolve the provider before any worktree or session row exists: a broken
    // key or an unreadable selection must not leave a half-created checkout.
    const launchSpec = this.launchSpecFor(input.harness, target)
    await this.requireDirectory(workspace.path, target)

    // Path A is validated **before** any worktree work, so an unavailable distro
    // or a missing guest directory cannot leave a half-created checkout behind.
    // The pre-flight uses the repository root, which must already exist in the
    // guest; the terminal itself will enter the worktree once it is created.
    const pathAPreflight = pathA
      ? await this.requirePathATerminal(target, repository.path)
      : null

    // Every new session in a Git repository gets its own checkout. Refuse
    // repositories where a worktree cannot be based on a known commit.
    const gitState = await this.deps.gitWorktrees.inspectRepository(repository.path, target)
    if (gitState.unborn) {
      throw new SessionServiceError(
        makeAppError('UNBORN_REPOSITORY', 'This repository has no commit yet.', {
          detail: 'Create an initial commit before starting an isolated session.',
          context: { repoId: repository.id }
        })
      )
    }
    if (gitState.inProgressOperation !== null) {
      throw new SessionServiceError(
        makeAppError('GIT_OPERATION_IN_PROGRESS', 'A Git operation is in progress in this repository.', {
          detail: gitState.inProgressOperation,
          context: { repoId: repository.id }
        })
      )
    }
    if (gitState.headOid === null) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_CREATE_FAILED', 'The repository baseline commit could not be read.', {
          context: { repoId: repository.id }
        })
      )
    }

    const sessionId = this.makeSessionId()
    const createdAt = this.now()
    const title = normalizeSessionTitle(
      input.title ?? `${harnessLabel(input.harness)} · ${repository.displayName}`,
      mainT('session.untitled')
    )

    let baseRef = gitState.headRef
    let baseOid = gitState.headOid
    if (options.base) {
      const oid = options.base.oid.trim()
      if (oid.length === 0 || !(await this.commitExists(repository.path, oid, target))) {
        throw new SessionServiceError(
          makeAppError('INVALID_ARGUMENT', 'The requested base commit does not exist.', {
            context: { repoId: repository.id }
          })
        )
      }
      baseRef = options.base.ref
      baseOid = oid
    } else if (input.startFrom !== undefined) {
      if (!isValidBranchName(input.startFrom)) {
        throw new SessionServiceError(
          makeAppError('INVALID_ARGUMENT', 'The start-from branch name is not valid.', {
            context: { branch: input.startFrom }
          })
        )
      }
      const oid = await this.deps.gitWorktrees.resolveBranchOid(
        repository.path,
        input.startFrom,
        target
      )
      if (oid === null) {
        throw new SessionServiceError(
          makeAppError('START_REF_NOT_FOUND', 'The start-from branch does not exist.', {
            context: { branch: input.startFrom }
          })
        )
      }
      baseRef = input.startFrom
      baseOid = oid
    }

    let branch = branchNameForSession(sessionId)
    if (input.branchName !== undefined) {
      if (!isValidBranchName(input.branchName)) {
        throw new SessionServiceError(
          makeAppError('INVALID_ARGUMENT', 'The branch name is not valid.', {
            context: { branch: input.branchName }
          })
        )
      }
      const checked = await this.deps.gitWorktrees.checkBranchName(
        repository.path,
        input.branchName,
        target
      )
      if (!checked.ok) {
        throw new SessionServiceError(
          makeAppError('INVALID_ARGUMENT', 'Git rejected the branch name.', {
            detail: checked.detail,
            context: { branch: input.branchName }
          })
        )
      }
      if (
        (await this.deps.gitWorktrees.branchExists(repository.path, input.branchName, target)) ||
        this.deps.worktrees.findBranch(input.branchName) !== null
      ) {
        throw new SessionServiceError(
          makeAppError('BRANCH_EXISTS', 'That branch already exists.', {
            context: { branch: input.branchName }
          })
        )
      }
      branch = input.branchName
    }
    // The managed root belongs to the repository's host: a WSL repository's
    // sessions live on the guest filesystem, under the guest worktree root.
    const worktreeRoot = await this.deps.gitWorktrees.worktreeRootFor(target)
    const worktreePath = this.deps.gitWorktrees.worktreePathFor(repository.id, sessionId, worktreeRoot)
    const initial: PersistedSessionObservation = {
      lastObservedState: 'starting',
      lastObservedExitCode: null,
      lastObservedError: null,
      lastObservedIncarnationId: null,
      lastObservedAt: createdAt
    }
    const worktree: SessionWorktreeRecord = {
      sessionId,
      repoId: repository.id,
      path: worktreePath,
      branch,
      baseRef,
      baseOid,
      state: 'creating',
      error: null,
      createdAt,
      updatedAt: createdAt
    }

    // Persist intent before touching Git: a crash may leave an unstarted
    // worktree, but never a running PTY whose checkout is unrecorded.
    this.deps.database.transaction(() => {
      this.deps.sessions.insert({
        id: sessionId,
        workspaceId: workspace.id,
        harness: input.harness,
        title,
        role: options.role ?? 'interactive',
        createdAt,
        lastActiveAt: createdAt,
        observation: initial
      })
      this.deps.worktrees.insert(worktree)
      this.deps.worktrees.insertBranch({
        branch,
        repoId: repository.id,
        sessionId,
        taskId: null,
        kind: 'session',
        baseOid: worktree.baseOid,
        createdAt
      })
    })

    const cwd = worktreePath
    // The worktree is now registered in the guest, so the terminal's guest
    // directory is known; only the argv changes, not the validated distro.
    const pathALaunch = pathAPreflight
      ? {
          ...pathAPreflight,
          args: buildWslTerminalArgs(pathAPreflight.distro, worktreePath)
        }
      : null
    try {
      await this.deps.gitWorktrees.create({
        primaryRoot: repository.path,
        path: worktreePath,
        branch,
        baseOid: worktree.baseOid,
        target
      })
      this.deps.worktrees.updateState(sessionId, 'created', null, this.now())
      await this.prepareWorkspaceTrust(input.harness, target, worktreePath)

      /**
       * Two routes, chosen by persisted intent:
       *
       *   Path A — a local WSL terminal: the **desktop** Host spawns `wsl.exe`,
       *            the PTY cwd is machine-local, and the guest shell starts in the
       *            worktree. No relay, no managed Guest Host.
       *   Path B — a coding Agent: the managed Guest Host reached by the W5 relay,
       *            exactly as W7 wired it.
       */
      const created = pathA
        ? await this.deps.host.createOrAttach(
            {
              sessionId,
              // A ConPTY cannot start in a Linux path; the guest directory is
              // entered by the child script instead.
              cwd: pathALaunch!.ptyCwd,
              command: pathALaunch!.command,
              args: pathALaunch!.args,
              cols: input.cols,
              rows: input.rows
            },
            // The desktop Host: Path A is deliberately not routed through W5.
            LOCAL_TARGET
          )
        : await this.deps.host.createOrAttach(
            {
              sessionId,
              cwd,
              command: detection!.command!.command,
              args: withLaunchArgs(detection!.command!, launchSpec.args).args,
              env: launchSpec.env,
              cols: input.cols,
              rows: input.rows
            },
            target
          )
      this.currentIncarnations.set(sessionId, created.incarnationId)
      this.deps.onIncarnation?.(sessionId, created.incarnationId)
      const observation: PersistedSessionObservation = {
        lastObservedState: 'live',
        lastObservedExitCode: null,
        lastObservedError: null,
        lastObservedIncarnationId: toPtyIncarnationId(created.incarnationId),
        lastObservedAt: this.now()
      }
      this.deps.sessions.recordObservation(sessionId, observation)
      this.deps.worktrees.updateState(sessionId, 'ready', null, this.now())
      const row = this.deps.sessions.findById(sessionIdParse(sessionId))!
      const summary = this.toSummary(
        row,
        {
          state: 'live',
          authority: 'host',
          reason: 'host_live',
          incarnationId: toPtyIncarnationId(created.incarnationId),
          exitCode: null,
          error: null
        },
        null,
        true
      )
      this.emit({ type: 'state', session: summary })
      return summary
    } catch (error) {
      // A worktree failure keeps its specific code; only a Host failure is a
      // spawn failure. Nothing is deleted: the failed session stays inspectable.
      const appError =
        error instanceof SessionServiceError
          ? error.appError
          : error instanceof HostRequestError
            ? errorFromHost(error, 'The session could not be started.')
            : makeAppError('SPAWN_FAILED', 'The session process could not be started.', {
                detail: error instanceof Error ? error.message : String(error)
              })
      this.deps.worktrees.updateState(sessionId, 'failed', appError, this.now())
      const failed: PersistedSessionObservation = {
        lastObservedState: 'failed',
        lastObservedExitCode: null,
        lastObservedError: appError,
        lastObservedIncarnationId: null,
        lastObservedAt: this.now()
      }
      this.deps.sessions.recordObservation(sessionId, failed)
      this.emit({
        type: 'state',
        session: this.toSummary(this.deps.sessions.findById(sessionId)!, {
          state: 'failed',
          authority: 'persisted',
          reason: 'host_failed',
          incarnationId: null,
          exitCode: null,
          error: appError
        })
      })
      throw new SessionServiceError(appError)
    }
  }

  async attach(sessionId: string): Promise<TerminalAttachPayload> {
    const row = this.requireRow(sessionId)
    const checkout = await this.resolveCheckout(row)
    const target = this.targetForSession(row)
    // A Path A terminal lives on the desktop Host with a machine-local cwd; a
    // Linux path here would make the attach fail its own cwd check.
    const pathA = this.isPathATerminal(row.harness, target)
      ? await this.requirePathATerminal(target, checkout.path)
      : null

    let attached: CreateOrAttachPayload
    try {
      attached = await this.deps.host.createOrAttach(
        {
          sessionId,
          cwd: pathA?.ptyCwd ?? checkout.path,
          // attachOnly never spawns, so the command is required by the protocol
          // but not executed. Restart resolves the harness command again.
          command: resolvedShellCommand(),
          cols: attachedDimensions(row).cols,
          rows: attachedDimensions(row).rows,
          attachOnly: true
        },
        pathA ? LOCAL_TARGET : target
      )
    } catch (error) {
      const appError = errorFromHost(error, 'Could not attach to the session.')
      if (appError.code === 'SESSION_NOT_FOUND') {
        this.markUnavailable(row, appError)
        throw new SessionServiceError(
          makeAppError('SESSION_NOT_FOUND', 'The terminal host no longer owns this session.', {
            detail: appError.detail,
            context: { sessionId }
          })
        )
      }
      if (appError.code === 'HOST_UNREACHABLE') {
        this.markUnavailable(row, appError)
      }
      throw new SessionServiceError(appError)
    }

    /**
     * The Host is authoritative for the process, so a disagreement about the
     * working directory must not be presented as consistent.
     *
     * Which directory to expect depends on the route: a Path A terminal's PTY
     * starts in a machine-local directory (a ConPTY cannot chdir to a Linux path)
     * and enters the guest worktree from inside; a Path B PTY *is* the guest
     * process, so its cwd is the worktree itself.
     */
    const expectedCwd = pathA?.ptyCwd ?? checkout.path
    if (pathA === null && checkout.record !== null && !samePath(attached.cwd, expectedCwd)) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'The Host process is not running in the recorded worktree.', {
          detail: `${attached.cwd} != ${expectedCwd}`,
          context: { sessionId }
        })
      )
    }
    if (pathA !== null && !samePath(attached.cwd, expectedCwd)) {
      // Path A: the PTY must be the one this route starts, or the terminal is not
      // the WSL terminal iCode claims it is.
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'The WSL terminal is not running in its expected directory.', {
          detail: `${attached.cwd} != ${expectedCwd}`,
          context: { sessionId }
        })
      )
    }

    this.currentIncarnations.set(sessionId, attached.incarnationId)
    this.deps.onIncarnation?.(sessionId, attached.incarnationId)
    const observation: PersistedSessionObservation = {
      lastObservedState: attached.status === 'starting' ? 'starting' : attached.status === 'live' ? 'live' : attached.status === 'failed' ? 'failed' : 'exited',
      lastObservedExitCode: attached.exitCode,
      lastObservedError: attached.status === 'failed' ? row.observation.lastObservedError : null,
      lastObservedIncarnationId: toPtyIncarnationId(attached.incarnationId),
      lastObservedAt: this.now()
    }
    this.deps.sessions.recordObservation(sessionIdParse(sessionId), observation)

    return {
      sessionId: attached.sessionId,
      incarnationId: attached.incarnationId,
      cols: attached.snapshot.cols,
      rows: attached.snapshot.rows,
      snapshot: attached.snapshot.data,
      seq: attached.snapshot.seq,
      alternateScreen: attached.snapshot.alternateScreen,
      cursor: attached.snapshot.cursor,
      scrollbackLines: attached.snapshot.scrollbackLines,
      truncated: attached.snapshot.truncated
    }
  }

  async write(sessionId: string, incarnationId: string, data: string): Promise<void> {
    const row = this.requireRow(sessionId)
    this.assertIncarnation(row, incarnationId)
    try {
      await this.deps.host.write(
        sessionId,
        incarnationId,
        data,
        this.hostTargetFor(row.harness, this.targetForSession(row))
      )
    } catch (error) {
      const appError = errorFromHost(error, 'The terminal did not accept input.')
      if (appError.code === 'SESSION_NOT_FOUND') {
        // Could be a stale incarnation or a host that forgot the session.
        if (row.observation.lastObservedIncarnationId !== null &&
            row.observation.lastObservedIncarnationId !== incarnationId) {
          throw new SessionServiceError(
            makeAppError('SESSION_NOT_FOUND', 'This terminal belongs to a previous process.', {
              detail: 'Re-attach to the current incarnation.',
              context: { sessionId }
            })
          )
        }
        this.markUnavailable(row, appError)
      }
      throw new SessionServiceError(appError)
    }
  }

  async resize(
    sessionId: string,
    incarnationId: string,
    cols: number,
    rows: number
  ): Promise<void> {
    const row = this.requireRow(sessionId)
    this.assertIncarnation(row, incarnationId)
    try {
      await this.deps.host.resize(
        sessionId,
        incarnationId,
        cols,
        rows,
        this.hostTargetFor(row.harness, this.targetForSession(row))
      )
    } catch (error) {
      const appError = errorFromHost(error, 'The terminal could not be resized.')
      if (appError.code === 'SESSION_NOT_FOUND') this.markUnavailable(row, appError)
      throw new SessionServiceError(appError)
    }
  }

  async stop(sessionId: string): Promise<void> {
    const row = this.requireRow(sessionId)
    try {
      await this.deps.host.kill(
        sessionId,
        this.hostTargetFor(row.harness, this.targetForSession(row))
      )
    } catch (error) {
      const appError = errorFromHost(error, 'The session could not be stopped.')
      if (appError.code === 'SESSION_NOT_FOUND') {
        // Already gone: idempotent stop, but record the truth.
        this.markUnavailable(row, appError)
        return
      }
      throw new SessionServiceError(appError)
    }
    // Exit truth arrives as a host event; do not invent an exit code here.
  }

  async restart(
    sessionId: string,
    options: { resume?: boolean } = {}
  ): Promise<SessionSummary> {
    const row = this.requireRow(sessionId)
    // Validate the recorded checkout before killing anything: restart must
    // never stop a healthy PTY and then discover there is nowhere to start.
    const checkout = await this.resolveCheckout(row)
    const target = this.targetForSession(row)
    const pathA = this.isPathATerminal(row.harness, target)
      ? await this.requirePathATerminal(target, checkout.path)
      : null
    // Path A re-runs the distro shell, so it resolves no harness: the terminal's
    // shell is decided inside the guest.
    const detection = pathA === null ? await this.requireHarness(row.harness, target) : null
    const hostTarget = pathA === null ? target : LOCAL_TARGET
    const launchSpec = this.launchSpecFor(row.harness, target)
    const launchArgs = [
      ...launchSpec.args,
      ...(options.resume === true ? wakePlan(row.harness, row.resumeToken).args : [])
    ]
    const repository = checkout.record === null
      ? null
      : this.deps.repositories.findById(checkout.record.repoId)
    if (checkout.record !== null && repository === null) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session repository is missing.', { context: { sessionId } })
      )
    }

    let previous: SessionInfo | undefined
    try {
      const list = await this.deps.host.listSessions(hostTarget)
      previous = list.sessions.find((entry) => entry.sessionId === sessionId)
    } catch (error) {
      throw new SessionServiceError(errorFromHost(error, 'Could not query the terminal host.'))
    }

    if (previous && (previous.status === 'live' || previous.status === 'starting')) {
      try {
        await this.deps.host.kill(sessionId, hostTarget)
      } catch (error) {
        throw new SessionServiceError(errorFromHost(error, 'The running session could not be stopped.'))
      }
      await this.waitForStop(sessionId, hostTarget)
    }

    await this.prepareWorkspaceTrust(row.harness, target, checkout.path)

    let created: CreateOrAttachPayload
    try {
      created = await this.deps.host.createOrAttach(
        {
          sessionId,
          cwd: pathA?.ptyCwd ?? checkout.path,
          command: pathA?.command ?? detection!.command!.command,
          args:
            pathA?.args ??
            withLaunchArgs(detection!.command!, launchArgs).args,
          env: pathA === null ? launchSpec.env : undefined,
          cols: previous?.cols ?? 100,
          rows: previous?.rows ?? 30
        },
        hostTarget
      )
    } catch (error) {
      throw new SessionServiceError(
        error instanceof HostRequestError
          ? errorFromHost(error, 'The session could not be restarted.')
          : makeAppError('SPAWN_FAILED', 'The session process could not be restarted.', {
              detail: error instanceof Error ? error.message : String(error)
            })
      )
    }

    if (created.created === false) {
      // The host still considers the old PTY live.
      throw new SessionServiceError(
        makeAppError('INTERNAL', 'The previous terminal is still running; restart was refused.', {
          context: { sessionId, incarnationId: created.incarnationId }
        })
      )
    }

    this.currentIncarnations.set(sessionId, created.incarnationId)
    this.deps.onIncarnation?.(sessionId, created.incarnationId)
    this.deps.sessions.setSleeping(row.id, null)
    const awakeRow = { ...row, sleepingAt: null }
    const observation: PersistedSessionObservation = {
      lastObservedState: 'live',
      lastObservedExitCode: null,
      lastObservedError: null,
      lastObservedIncarnationId: toPtyIncarnationId(created.incarnationId),
      lastObservedAt: this.now()
    }
    this.deps.sessions.recordObservation(row.id, observation)
    if (checkout.record !== null) {
      this.deps.worktrees.updateState(sessionId, 'ready', null, this.now())
    }
    const summary = this.toSummary(
      { ...awakeRow, observation },
      {
        state: 'live',
        authority: 'host',
        reason: 'host_live',
        incarnationId: toPtyIncarnationId(created.incarnationId),
        exitCode: null,
        error: null
      },
      null,
      true
    )
    this.emit({ type: 'state', session: summary })
    return summary
  }

  /**
   * Hibernate a live session: stop the PTY (freeing CPU/memory) and persist the
   * sleep intent. The worktree, branch, title and resume token stay. Wake uses
   * the harness-specific resume command; nothing here pretends the process was
   * suspended.
   */
  async sleep(sessionId: string): Promise<SessionSummary> {
    const row = this.requireRow(sessionId)
    const target = this.targetForSession(row)
    const hostTarget = this.hostTargetFor(row.harness, target)

    let previous: SessionInfo | undefined
    try {
      const list = await this.deps.host.listSessions(hostTarget)
      previous = list.sessions.find((entry) => entry.sessionId === sessionId)
    } catch (error) {
      throw new SessionServiceError(errorFromHost(error, 'Could not query the terminal host.'))
    }
    if (!previous || (previous.status !== 'live' && previous.status !== 'starting')) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Only a live session can be slept.', {
          context: { sessionId }
        })
      )
    }

    try {
      await this.deps.host.kill(sessionId, hostTarget)
    } catch (error) {
      throw new SessionServiceError(
        errorFromHost(error, 'The running session could not be stopped for sleep.')
      )
    }
    await this.waitForStop(sessionId, hostTarget, 10_000)

    const sleepingAt = this.now()
    this.deps.sessions.setSleeping(row.id, sleepingAt)
    this.deps.onIncarnation?.(sessionId, null)
    const observation: PersistedSessionObservation = {
      lastObservedState: 'exited',
      lastObservedExitCode: previous.exitCode ?? null,
      lastObservedError: null,
      lastObservedIncarnationId:
        (previous.incarnationId as PtyIncarnationId | undefined) ??
        row.observation.lastObservedIncarnationId,
      lastObservedAt: sleepingAt
    }
    this.deps.sessions.recordObservation(row.id, observation)
    const summary = this.toSummary({ ...row, sleepingAt, observation }, {
      state: 'exited',
      authority: 'host',
      reason: 'host_exited',
      incarnationId: observation.lastObservedIncarnationId,
      exitCode: observation.lastObservedExitCode,
      error: null
    })
    this.emit({ type: 'state', session: summary })
    return summary
  }

  /** Wake a slept session with the harness resume command for its worktree. */
  async wake(sessionId: string): Promise<SessionSummary> {
    const row = this.requireRow(sessionId)
    if (row.sleepingAt === null) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'This session is not sleeping.', {
          context: { sessionId }
        })
      )
    }
    return this.restart(sessionId, { resume: true })
  }

  /**
   * Explicit recovery: re-create the worktree directory from the retained
   * branch at the recorded path. Only valid when the directory is gone.
   */
  async recoverWorktree(sessionId: string): Promise<SessionSummary> {
    this.requireRow(sessionId)
    const record = this.deps.worktrees.findBySession(sessionId)
    if (!record) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'This session runs in the primary checkout and has no worktree.', {
          context: { sessionId }
        })
      )
    }
    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session repository is missing.', { context: { sessionId } })
      )
    }
    // Why: only branches iCode recorded for this session may be used to rebuild a
    // checkout; otherwise recovery could resurrect unrelated user work.
    const owned = this.deps.worktrees.findBranch(record.branch)
    if (!owned || owned.sessionId !== String(sessionId)) {
      throw new SessionServiceError(
        makeAppError('BRANCH_NOT_OWNED', 'That branch is not owned by this session.', {
          context: { sessionId, branch: record.branch }
        })
      )
    }
    await this.deps.gitWorktrees.recover({
      primaryRoot: repository.path,
      path: record.path,
      branch: record.branch,
      target: repository.executionTarget
    })
    this.deps.worktrees.updateState(sessionId, 'created', null, this.now())
    const summary = await this.get(sessionId)
    this.emit({ type: 'state', session: summary })
    return summary
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async waitForStop(
    sessionId: string,
    target: ExecutionTarget,
    timeoutMs = 3000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const list = await this.deps.host.listSessions(target)
        const entry = list.sessions.find((item) => item.sessionId === sessionId)
        if (!entry || TERMINAL_STATES.has(entry.status)) return
      } catch (error) {
        throw new SessionServiceError(errorFromHost(error, 'Could not confirm the session stopped.'))
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new SessionServiceError(
      makeAppError('INTERNAL', 'The previous terminal did not stop in time.', {
        detail: 'The action was refused to avoid two PTYs for one session.',
        context: { sessionId }
      })
    )
  }

  private launchSpecFor(
    harness: HarnessId,
    target: ExecutionTarget
  ): { args: string[]; env: Record<string, string> } {
    return this.deps.launchSpec?.(harness, target) ?? { args: [], env: {} }
  }

  /**
   * Best-effort harness workspace trust for a checkout that is about to run.
   *
   * A failure is deliberately not fatal: some users have read-only or malformed
   * harness configs, and starting the session with the harness's own prompt is
   * safer than blocking work. The trust service never throws to the session.
   */
  private async prepareWorkspaceTrust(
    harness: HarnessId,
    target: ExecutionTarget,
    worktreePath: string
  ): Promise<void> {
    try {
      await this.deps.workspaceTrust?.prepare({ harness, target, worktreePath })
    } catch {
      // The harness remains usable; its own trust dialog is the fallback.
    }
  }

  private async requireHarness(
    harness: HarnessId,
    target: ExecutionTarget
  ): Promise<HarnessDetectionResult> {
    const detection = await this.deps.detectHarness(harness, target)
    if (detection.state === 'unavailable') {
      throw new SessionServiceError(
        makeAppError('HARNESS_UNAVAILABLE', `${harnessLabel(harness)} cannot run here.`, {
          detail: detection.message,
          context: {
            harness,
            reason: detection.reason,
            stderr: detection.diagnostics.stderrTail.slice(0, 500)
          }
        })
      )
    }
    if (detection.state === 'detection_failed') {
      throw new SessionServiceError(
        makeAppError(
          'HARNESS_DETECTION_FAILED',
          `${harnessLabel(harness)} could not be verified.`,
          {
            detail: detection.message,
            context: {
              harness,
              reason: detection.reason,
              stderr: detection.diagnostics.stderrTail.slice(0, 500)
            }
          }
        )
      )
    }
    if (!detection.command) {
      throw new SessionServiceError(
        makeAppError('HARNESS_DETECTION_FAILED', `${harnessLabel(harness)} has no launch command.`, {
          context: { harness }
        })
      )
    }
    return detection
  }

  /** Confirms an object exists and peels to a commit in the owning checkout. */
  private async commitExists(
    primaryRoot: string,
    oid: string,
    target: ExecutionTarget
  ): Promise<boolean> {
    const git = await this.deps.gitWorktrees.gitFor(target)
    try {
      await git(primaryRoot, ['cat-file', '-e', `${oid}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  /**
   * Confirms the workspace directory exists **on the host that owns it**.
   *
   * A guest path checked with `statSync` would answer about the controller's
   * filesystem and report a healthy WSL repository as missing.
   */
  private async requireDirectory(path: string, target: ExecutionTarget): Promise<void> {
    const fs = await this.deps.gitWorktrees.hostFsFor(target)
    if (await fs.isDirectory(path)) return
    throw new SessionServiceError(
      makeAppError('CWD_MISSING', 'The session working directory is missing.', {
        detail: path,
        context: { path }
      })
    )
  }

  private requireRow(sessionId: string): StoredSession {
    const parsed = parseSessionId(sessionId)
    if (!parsed) {
      throw new SessionServiceError(
        makeAppError('INVALID_ARGUMENT', 'Invalid session ID.', { context: { sessionId } })
      )
    }
    const row = parsed ? this.deps.sessions.findById(parsed) : null
    if (!row) {
      throw new SessionServiceError(
        makeAppError('SESSION_NOT_FOUND', 'Session is not registered.', { context: { sessionId } })
      )
    }
    return row
  }

  private assertIncarnation(row: StoredSession, incarnationId: string): void {
    if (row.observation.lastObservedIncarnationId !== incarnationId) {
      throw new SessionServiceError(
        makeAppError('SESSION_NOT_FOUND', 'This terminal belongs to a previous process.', {
          detail: 'Re-attach to the current incarnation.',
          context: { sessionId: row.id, incarnationId }
        })
      )
    }
  }

  private markUnavailable(row: StoredSession, error: AppError | null): void {
    const observation: PersistedSessionObservation = {
      lastObservedState: 'unavailable',
      lastObservedExitCode: row.observation.lastObservedExitCode,
      lastObservedError: error,
      // Keep the last known incarnation as history; it is not proof of liveness.
      lastObservedIncarnationId: row.observation.lastObservedIncarnationId,
      lastObservedAt: this.now()
    }
    this.deps.sessions.recordObservation(row.id, observation)
    this.currentIncarnations.delete(row.id)
    this.deps.onIncarnation?.(row.id, null)
    this.emit({
      type: 'state',
      session: this.toSummary({ ...row, observation }, {
        state: 'unavailable',
        authority: error?.code === 'HOST_UNREACHABLE' ? 'unreachable' : 'host',
        reason: error?.code === 'HOST_UNREACHABLE' ? 'host_unreachable' : 'session_not_known',
        incarnationId: null,
        exitCode: null,
        error
      })
    })
  }

  private observationFor(
    row: StoredSession,
    reconciled: ReconciledSessionState
  ): PersistedSessionObservation {
    return {
      lastObservedState: reconciled.state,
      lastObservedExitCode: reconciled.exitCode ?? row.observation.lastObservedExitCode,
      lastObservedError: reconciled.error,
      lastObservedIncarnationId:
        reconciled.incarnationId ?? row.observation.lastObservedIncarnationId,
      lastObservedAt: reconciled.authority === 'host' ? this.now() : row.observation.lastObservedAt
    }
  }

  private observationChanged(
    previous: PersistedSessionObservation,
    next: PersistedSessionObservation
  ): boolean {
    return (
      previous.lastObservedState !== next.lastObservedState ||
      previous.lastObservedExitCode !== next.lastObservedExitCode ||
      previous.lastObservedIncarnationId !== next.lastObservedIncarnationId ||
      previous.lastObservedError?.code !== next.lastObservedError?.code
    )
  }

  private toSummary(
    row: StoredSession,
    reconciled: ReconciledSessionState,
    hostCwd: string | null = null,
    worktreeExists?: boolean | null
  ): SessionSummary {
    const workspace = this.deps.repositories.findWorkspaceById(row.workspaceId)
    if (!workspace) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session workspace is missing.', {
          context: { sessionId: row.id }
        })
      )
    }
    const repository = this.deps.repositories.findById(workspace.repoId)
    /**
     * A synchronous summary has not asked a remote host whether the checkout
     * exists. Falling back to a local `stat` is correct only for a local
     * repository: for a WSL target it would ask Windows about a Linux path and
     * label a healthy worktree `missing`. `null` means "not checked", which
     * `worktreeSummaryFor` deliberately treats as present; reconciliation and
     * explicit refreshes still supply a real true/false answer.
     */
    const effectiveWorktreeExists =
      worktreeExists !== undefined
        ? worktreeExists
        : repository !== null && repository.executionTarget.kind !== 'local'
          ? null
          : undefined
    /**
     * A WSL shell session is a desktop-Host ConPTY running `wsl.exe`: its cwd is
     * a Windows directory chosen because a ConPTY cannot start in a Linux path.
     * Comparing that cwd with the guest worktree would call every healthy WSL
     * shell "inconsistent" and block its terminal. Guest checkouts are checked
     * by Git against the distro instead; the cwd comparison is local-only.
     */
    const effectiveHostCwd =
      repository !== null && repository.executionTarget.kind !== 'local' ? null : hostCwd
    return {
      id: row.id,
      repoId: workspace.repoId,
      title: row.title,
      harness: row.harness,
      role: row.role,
      state: reconciled.state,
      authority: reconciled.authority,
      reason: reconciled.reason,
      incarnationId: reconciled.incarnationId,
      exitCode: reconciled.exitCode,
      error: reconciled.error ?? this.impliedError(reconciled.reason),
      updatedAt: this.now(),
      sleeping: row.sleepingAt !== null,
      worktree: this.worktreeSummaryFor(
        row,
        reconciled.state,
        effectiveHostCwd,
        effectiveWorktreeExists
      ),
      activity: this.activityFor(row, reconciled.state)
    }
  }

  /**
   * Activity is suppressed for terminal or unreachable lifecycle states: an
   * exited process must not keep showing `working` from its last hook.
   */
  private activityFor(
    row: StoredSession,
    state: ReconciledSessionState['state']
  ): SessionSummary['activity'] {
    if (state === 'exited' || state === 'failed' || state === 'unavailable') return null
    return this.deps.activityFor?.(row.id) ?? null
  }

  private worktreeSummaryFor(
    row: StoredSession,
    sessionState: ReconciledSessionState['state'],
    hostCwd: string | null,
    worktreeExists?: boolean | null
  ): WorktreeSummary | null {
    const record = this.deps.worktrees.findBySession(row.id)
    if (!record) return null
    // `undefined` = local, let describeWorktree stat it. `null` = a remote host
    // could not answer, or this synchronous summary did not ask; neither may
    // become a `missing` claim.
    const directoryExists = worktreeExists === null ? true : (worktreeExists ?? undefined)
    return describeWorktree(record, sessionState, hostCwd, directoryExists)
  }

  /**
   * Existence of each worktree that lives on another host.
   *
   * Values: `true`/`false` is the distro's own answer; `null` means the host
   * could not answer (unreachable, or the router refused). Local sessions are
   * absent from the map, so their check stays a plain `statSync` exactly as
   * before.
   *
   * `null` is not "missing": an unreachable distro says nothing about the
   * checkout, and claiming the worktree is gone would disable Restart on a
   * session that is merely offline.
   */
  private async resolveWorktreeExistence(
    rows: StoredSession[]
  ): Promise<Map<string, boolean | null>> {
    const resolved = new Map<string, boolean | null>()
    const pending: Array<Promise<void>> = []
    const fileSystems = new Map<string, Awaited<ReturnType<SessionServiceDeps['gitWorktrees']['hostFsFor']>>>()

    for (const row of rows) {
      const record = this.deps.worktrees.findBySession(row.id)
      if (!record) continue
      const repository = this.deps.repositories.findById(record.repoId)
      if (!repository || repository.executionTarget.kind === 'local') continue

      const key = `${repository.executionTarget.distro}\u0000${repository.executionTarget.distroId ?? ''}`
      resolved.set(row.id, null)
      pending.push(
        (async () => {
          try {
            let fs = fileSystems.get(key)
            if (!fs) {
              fs = await this.deps.gitWorktrees.hostFsFor(repository.executionTarget)
              fileSystems.set(key, fs)
            }
            resolved.set(row.id, await fs.isDirectory(record.path))
          } catch {
            // No answer is not "missing": the null set above stands.
          }
        })()
      )
    }

    await Promise.all(pending)
    return resolved
  }

  /**
   * Sessions with a worktree record run in that checkout. Legacy sessions keep
   * the primary checkout exactly as before; a missing worktree never falls
   * back to it.
   */
  /**
   * The validated checkout for a session: the Work 12 worktree when one exists
   * (directory present and registered with Git) or the primary checkout for a
   * legacy session. Never falls back for a missing worktree.
   */
  async resolveSessionCheckout(
    sessionId: string
  ): Promise<{ path: string; record: SessionWorktreeRecord | null }> {
    return this.resolveCheckout(this.requireRow(sessionId))
  }

  /**
   * The execution target a session belongs to, from its repository.
   *
   * Legacy sessions with no worktree row still have a workspace, and the workspace
   * names its repository — so the answer is always persisted data, never a guess
   * about the path.
   */
  private targetForSession(row: StoredSession): ExecutionTarget {
    const workspace = this.deps.repositories.findWorkspaceById(row.workspaceId)
    if (!workspace) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session workspace is missing.', {
          context: { sessionId: row.id }
        })
      )
    }
    const repository = this.deps.repositories.findById(workspace.repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session repository is missing.', {
          context: { sessionId: row.id }
        })
      )
    }
    return repository.executionTarget
  }

  private async resolveCheckout(
    row: StoredSession
  ): Promise<{ path: string; record: SessionWorktreeRecord | null }> {
    const workspace = this.deps.repositories.findWorkspaceById(row.workspaceId)
    if (!workspace) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session workspace is missing.', {
          context: { sessionId: row.id }
        })
      )
    }
    const record = this.deps.worktrees.findBySession(row.id)
    if (!record) return { path: workspace.path, record: null }
    const repository = this.deps.repositories.findById(record.repoId)
    if (!repository) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session repository is missing.', {
          context: { sessionId: row.id }
        })
      )
    }
    const inspection = await this.deps.gitWorktrees.inspect({
      primaryRoot: repository.path,
      path: record.path,
      branch: record.branch,
      target: repository.executionTarget
    })
    if (!inspection.pathExists) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_MISSING', 'The isolated worktree is missing.', {
          detail: 'Restore the worktree from its retained branch before using this session.',
          context: { sessionId: row.id, path: record.path, branch: record.branch }
        })
      )
    }
    if (!inspection.registered) {
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'The worktree directory is not registered with Git.', {
          detail: record.path,
          context: { sessionId: row.id, branch: record.branch }
        })
      )
    }
    return { path: record.path, record }
  }

  private impliedError(reason: ReconciledSessionState['reason']): AppError | null {
    if (reason === 'host_unreachable') {
      return makeAppError('HOST_UNREACHABLE', 'The terminal host is not reachable.', {
        detail: 'The session state cannot be verified while the host is down.'
      })
    }
    if (reason === 'session_not_known') {
      return makeAppError('SESSION_NOT_FOUND', 'The terminal host no longer owns this session.', {
        detail: 'The process ended while iCode was not connected.'
      })
    }
    return null
  }

  private emit(event: RendererSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // a broken listener must not break session handling
      }
    }
  }

  private onHostEvent(event: HostEvent): void {
    if (event.event === 'data') {
      if (!this.matchesIncarnation(event.sessionId, event.incarnationId)) return
      this.emit({
        type: 'data',
        sessionId: event.sessionId,
        incarnationId: event.incarnationId,
        seq: event.seq,
        data: event.data
      })
      return
    }

    if (event.event === 'spawned') {
      // Events on one connection are ordered, so the newest spawn is current.
      this.currentIncarnations.set(event.sessionId, event.incarnationId)
      return
    }

    if (event.event === 'exit') {
      if (!this.matchesIncarnation(event.sessionId, event.incarnationId)) return
      const parsed = parseSessionId(event.sessionId)
      const row = parsed ? this.deps.sessions.findById(parsed) : null
      if (row) {
        const state = event.exitCode === 0 || event.requested === true ? 'exited' : 'failed'
        const observation: PersistedSessionObservation = {
          lastObservedState: state,
          lastObservedExitCode: event.exitCode,
          lastObservedError:
            state === 'exited' ? null : row.observation.lastObservedError,
          lastObservedIncarnationId: toPtyIncarnationId(event.incarnationId),
          lastObservedAt: this.now()
        }
        this.deps.sessions.recordObservation(row.id, observation)
        this.currentIncarnations.delete(event.sessionId)
        this.deps.onIncarnation?.(event.sessionId, null)
        this.emit({
          type: 'exit',
          sessionId: event.sessionId,
          incarnationId: event.incarnationId,
          exitCode: event.exitCode
        })
        this.emit({
          type: 'state',
          session: this.toSummary({ ...row, observation }, {
            state,
            authority: 'host',
            reason: state === 'exited' ? 'host_exited' : 'host_failed',
            incarnationId: toPtyIncarnationId(event.incarnationId),
            exitCode: event.exitCode,
            error: state === 'exited' ? null : row.observation.lastObservedError
          })
        })
      }
      return
    }

    if (event.event === 'lagged') {
      if (!this.matchesIncarnation(event.sessionId, event.incarnationId)) return
      // The renderer must re-attach for a snapshot. Emit a state event so it can.
      const parsed = parseSessionId(event.sessionId)
      const row = parsed ? this.deps.sessions.findById(parsed) : null
      if (row) {
        const summary = this.toSummary(row, {
          state: isActiveSessionState(row.observation.lastObservedState)
            ? 'live'
            : row.observation.lastObservedState,
          authority: 'host',
          reason: 'host_live',
          incarnationId: toPtyIncarnationId(event.incarnationId),
          exitCode: row.observation.lastObservedExitCode,
          error: null
        })
        this.emit({ type: 'state', session: summary })
      }
    }
  }

  private matchesIncarnation(sessionId: string, incarnationId: string): boolean {
    return this.currentIncarnations.get(sessionId) === incarnationId
  }
}

function sessionIdParse(value: SessionId | string): SessionId {
  const parsed = parseSessionId(String(value))
  if (!parsed) throw new Error(`Invalid session ID: ${String(value)}`)
  return parsed
}

function attachedDimensions(row: StoredSession): { cols: number; rows: number } {
  // Dimensions are not persisted; the host keeps the live size and ignores
  // these values when attachOnly attaches.
  void row
  return { cols: 100, rows: 30 }
}

export { errorFromHost }
export { SessionServiceError }

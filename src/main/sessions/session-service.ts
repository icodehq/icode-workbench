import type { Database } from '../persistence/database'
import type { RepositoryStore } from '../persistence/repository-store'
import type { SessionStore } from '../persistence/session-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import { describeWorktree, samePath } from '../worktrees/worktree-status'
import { branchNameForSession } from '../../shared/domain/worktree'
import type { SessionWorktreeRecord, WorktreeSummary } from '../../shared/domain/worktree'
import type { StoredSession } from '../persistence/rows'
import type { HostGateway } from './host-gateway'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import { statSync } from 'node:fs'
import { makeAppError } from '../../shared/domain/errors'
import type { AppError } from '../../shared/domain/errors'
import { resolvedShellCommand } from '../harness/default-shell'
import { SessionServiceError, errorFromHost } from './session-errors'
import { harnessLabel, type HarnessId } from '../../shared/domain/harness'
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
  type ReconciledSessionState
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


export type SessionServiceDeps = {
  database: Database
  repositories: RepositoryStore
  sessions: SessionStore
  worktrees: WorktreeStore
  gitWorktrees: GitWorktreeService
  host: HostGateway
  detectHarness: (harness: HarnessId) => Promise<HarnessDetectionResult>
  /** Extra CLI arguments for a harness (Claude receives ADE's hook overlay). */
  launchArgs?: (harness: HarnessId) => string[]
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

  // ─── Reconciliation ───────────────────────────────────────────────

  async reconcile(): Promise<SessionListView> {
    const rows = this.deps.sessions.listAll()
    let hostSessions: SessionInfo[] | null = null
    let hostError: AppError | null = null
    try {
      const list = await this.deps.host.listSessions()
      hostSessions = list.sessions
    } catch (error) {
      hostError = errorFromHost(error, 'Could not query the terminal host.')
      hostSessions = null
    }

    const bySessionId = new Map<string, SessionInfo>()
    for (const entry of hostSessions ?? []) bySessionId.set(entry.sessionId, entry)

    // Repair the two safe directions of worktree lifecycle drift. Nothing here
    // deletes: an incomplete worktree is reported, never auto-removed.
    await this.repairWorktreeStates(bySessionId)

    const summaries: SessionSummary[] = []
    const changed: Array<{ id: SessionId; observation: PersistedSessionObservation }> = []

    for (const row of rows) {
      const entry = bySessionId.get(row.id)
      const observation: HostObservation = hostSessions === null
        ? { reachable: false }
        : hostObservation(entry)
      const reconciled = reconcileSessionState(row.observation, observation)
      const summary = this.toSummary(row, reconciled, entry?.cwd ?? null)
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
        .inspect({ primaryRoot: repository.path, path: record.path, branch: record.branch })
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

  async create(input: CreateSessionInput): Promise<SessionSummary> {
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

    const detection = await this.requireHarness(input.harness)
    this.requireDirectory(workspace.path)

    // Every new session in a Git repository gets its own checkout. Refuse
    // repositories where a worktree cannot be based on a known commit.
    const gitState = await this.deps.gitWorktrees.inspectRepository(repository.path)
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
      'Untitled session'
    )
    const branch = branchNameForSession(sessionId)
    const worktreePath = this.deps.gitWorktrees.worktreePathFor(repository.id, sessionId)
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
      baseRef: gitState.headRef,
      baseOid: gitState.headOid,
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
        createdAt,
        lastActiveAt: createdAt,
        observation: initial
      })
      this.deps.worktrees.insert(worktree)
      this.deps.worktrees.insertBranch({
        branch,
        repoId: repository.id,
        sessionId,
        baseOid: worktree.baseOid,
        createdAt
      })
    })

    const cwd = worktreePath
    try {
      await this.deps.gitWorktrees.create({
        primaryRoot: repository.path,
        path: worktreePath,
        branch,
        baseOid: worktree.baseOid
      })
      this.deps.worktrees.updateState(sessionId, 'created', null, this.now())

      const created = await this.deps.host.createOrAttach({
        sessionId,
        cwd,
        command: detection.command!.command,
        args: [...detection.command!.args, ...this.launchArgsFor(input.harness)],
        cols: input.cols,
        rows: input.rows
      })
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
      const summary = this.toSummary(row, {
        state: 'live',
        authority: 'host',
        reason: 'host_live',
        incarnationId: toPtyIncarnationId(created.incarnationId),
        exitCode: null,
        error: null
      })
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

    let attached: CreateOrAttachPayload
    try {
      attached = await this.deps.host.createOrAttach({
        sessionId,
        cwd: checkout.path,
        // attachOnly never spawns, so the command is required by the protocol
        // but not executed. Restart resolves the harness command again.
        command: resolvedShellCommand(),
        cols: attachedDimensions(row).cols,
        rows: attachedDimensions(row).rows,
        attachOnly: true
      })
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

    if (checkout.record !== null && !samePath(attached.cwd, checkout.path)) {
      // The Host is authoritative for the process; if it reports a different
      // working directory, ADE must not present this terminal as consistent.
      throw new SessionServiceError(
        makeAppError('WORKTREE_INCONSISTENT', 'The Host process is not running in the recorded worktree.', {
          detail: `${attached.cwd} != ${checkout.path}`,
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
      await this.deps.host.write(sessionId, incarnationId, data)
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
      await this.deps.host.resize(sessionId, incarnationId, cols, rows)
    } catch (error) {
      const appError = errorFromHost(error, 'The terminal could not be resized.')
      if (appError.code === 'SESSION_NOT_FOUND') this.markUnavailable(row, appError)
      throw new SessionServiceError(appError)
    }
  }

  async stop(sessionId: string): Promise<void> {
    const row = this.requireRow(sessionId)
    try {
      await this.deps.host.kill(sessionId)
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

  async restart(sessionId: string): Promise<SessionSummary> {
    const row = this.requireRow(sessionId)
    // Validate the recorded checkout before killing anything: restart must
    // never stop a healthy PTY and then discover there is nowhere to start.
    const checkout = await this.resolveCheckout(row)
    const detection = await this.requireHarness(row.harness)
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
      const list = await this.deps.host.listSessions()
      previous = list.sessions.find((entry) => entry.sessionId === sessionId)
    } catch (error) {
      throw new SessionServiceError(errorFromHost(error, 'Could not query the terminal host.'))
    }

    if (previous && (previous.status === 'live' || previous.status === 'starting')) {
      try {
        await this.deps.host.kill(sessionId)
      } catch (error) {
        throw new SessionServiceError(errorFromHost(error, 'The running session could not be stopped.'))
      }
      await this.waitForStop(sessionId)
    }

    let created: CreateOrAttachPayload
    try {
      created = await this.deps.host.createOrAttach({
        sessionId,
        cwd: checkout.path,
        command: detection.command!.command,
        args: [...detection.command!.args, ...this.launchArgsFor(row.harness)],
        cols: previous?.cols ?? 100,
        rows: previous?.rows ?? 30
      })
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
    const summary = this.toSummary({ ...row, observation }, {
      state: 'live',
      authority: 'host',
      reason: 'host_live',
      incarnationId: toPtyIncarnationId(created.incarnationId),
      exitCode: null,
      error: null
    })
    this.emit({ type: 'state', session: summary })
    return summary
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
    // Why: only branches ADE recorded for this session may be used to rebuild a
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
      branch: record.branch
    })
    this.deps.worktrees.updateState(sessionId, 'created', null, this.now())
    const summary = await this.get(sessionId)
    this.emit({ type: 'state', session: summary })
    return summary
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async waitForStop(sessionId: string): Promise<void> {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try {
        const list = await this.deps.host.listSessions()
        const entry = list.sessions.find((item) => item.sessionId === sessionId)
        if (!entry || TERMINAL_STATES.has(entry.status)) return
      } catch (error) {
        throw new SessionServiceError(errorFromHost(error, 'Could not confirm the session stopped.'))
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new SessionServiceError(
      makeAppError('INTERNAL', 'The previous terminal did not stop in time.', {
        detail: 'Restart was refused to avoid two PTYs for one session.',
        context: { sessionId }
      })
    )
  }

  private launchArgsFor(harness: HarnessId): string[] {
    return this.deps.launchArgs?.(harness) ?? []
  }

  private async requireHarness(harness: HarnessId): Promise<HarnessDetectionResult> {
    const detection = await this.deps.detectHarness(harness)
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

  private requireDirectory(path: string): void {
    try {
      if (!statSync(path).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new SessionServiceError(
        makeAppError('CWD_MISSING', 'The session working directory is missing.', {
          detail: path,
          context: { path }
        })
      )
    }
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
    hostCwd: string | null = null
  ): SessionSummary {
    const workspace = this.deps.repositories.findWorkspaceById(row.workspaceId)
    if (!workspace) {
      throw new SessionServiceError(
        makeAppError('DB_CORRUPT', 'Session workspace is missing.', {
          context: { sessionId: row.id }
        })
      )
    }
    return {
      id: row.id,
      repoId: workspace.repoId,
      title: row.title,
      harness: row.harness,
      state: reconciled.state,
      authority: reconciled.authority,
      reason: reconciled.reason,
      incarnationId: reconciled.incarnationId,
      exitCode: reconciled.exitCode,
      error: reconciled.error ?? this.impliedError(reconciled.reason),
      updatedAt: this.now(),
      worktree: this.worktreeSummaryFor(row, reconciled.state, hostCwd),
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
    hostCwd: string | null
  ): WorktreeSummary | null {
    const record = this.deps.worktrees.findBySession(row.id)
    if (!record) return null
    return describeWorktree(record, sessionState, hostCwd)
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
      branch: record.branch
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
        detail: 'The process ended while ADE was not connected.'
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

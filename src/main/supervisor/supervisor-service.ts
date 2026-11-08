import { createHash, randomBytes } from 'node:crypto'
import type { ExecutionTarget } from '../../shared/domain/repository'
import type { AppErrorCode } from '../../shared/domain/errors'
import { makeAppError } from '../../shared/domain/errors'
import type { HarnessId } from '../../shared/domain/harness'
import { HARNESS_IDS } from '../../shared/domain/harness'
import type { RepoId, SessionId } from '../../shared/domain/ids'
import type { SessionSummary } from '../../shared/schemas/ipc'
import type { TaskView } from '../../shared/domain/task'
import type { RepositoryStore } from '../persistence/repository-store'
import type { SupervisorStore } from '../persistence/supervisor-store'
import type { TaskService } from '../tasks/task-service'
import type { TaskStore } from '../tasks/task-store'
import type { SessionService } from '../sessions/session-service'
import type { WorkspaceFilesService } from '../files/workspace-files-service'
import type { GitWorkspaceService } from '../git/git-workspace-service'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { ActivityService } from '../activity/activity-service'
import type { SupervisorControlRequest, SupervisorControlResponse } from './control-server'
import { SupervisorControlServer } from './control-server'
import { SupervisorEventLog } from './events'
import { supervisorSocketPath } from './endpoint'
import {
  AGENT_SUBMIT_DELAY_MS,
  buildAgentPromptPaste
} from '../../shared/agent-prompt'
import {
  buildBootstrapPrompt,
  installSupervisorCli,
  writeSupervisorControlFiles
} from './wrappers'

const SUPERVISOR_HARNESS_PRIORITY: readonly HarnessId[] = ['claude', 'codex', 'opencode']
const MAX_MESSAGE = 4_000
const MAX_DIFF_BYTES = 200_000

export type SupervisorServiceDeps = {
  userDataDir: string
  execPath: string
  platform?: NodeJS.Platform
  now: () => number
  store: SupervisorStore
  sessions: SessionService
  tasks: TaskService
  taskStore: TaskStore
  repositories: RepositoryStore
  gitWorkspace: GitWorkspaceService
  workspaceFiles: WorkspaceFilesService
  listHarnesses: (input: { repoId?: string }) => Promise<HarnessDetectionResult[]>
  /** Claude's advisory activity, used to confirm a bootstrap actually started. */
  activity?: Pick<ActivityService, 'get'>
  /** Let the agent TUI finish drawing before the first paste. */
  bootstrapDelayMs?: number
  onError?: (error: unknown) => void
}

type TaskSummary = {
  id: string
  title: string
  status: string
  approval: string
  origin: string
  attempt: number
  sessionId: string | null
  sessionLive: boolean
  createdAt: number
  updatedAt: number
  error: string | null
  failureReason: string | null
  reviewDecision: string
  reviewRecommendation: string | null
  canApprove: boolean
  canRetry: boolean
}

function taskSummary(task: TaskView): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    approval: task.approval,
    origin: task.origin,
    attempt: task.attempt,
    sessionId: task.sessionId,
    sessionLive: task.sessionLive,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error,
    failureReason: task.failureReason,
    reviewDecision: task.reviewDecision,
    reviewRecommendation: task.reviewRecommendation,
    canApprove: task.canApprove,
    canRetry: task.canRetry
  }
}

function error(
  code: AppErrorCode,
  message: string,
  detail?: string
): SupervisorControlResponse {
  return { ok: false, error: { code, message, ...(detail === undefined ? {} : { detail }) } }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * One supervisor per project.
 *
 * The service owns the binding, the bootstrap, and the control handler. It does
 * not own a task queue, a session process, or a diff engine; every operation
 * ends at TaskService, SessionService, or GitWorkspaceService.
 */
export class SupervisorService {
  private server: SupervisorControlServer | null = null
  private readonly events = new SupervisorEventLog()
  private readonly ensuring = new Map<string, Promise<SessionSummary>>()
  private started = false

  constructor(private readonly deps: SupervisorServiceDeps) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      const cli = installSupervisorCli({
        directory: `${this.deps.userDataDir}/supervisor`,
        platform: this.deps.platform
      })
      void cli
      this.server = new SupervisorControlServer({
        socketPath: this.endpoint(),
        handle: (request) => this.handleControl(request),
        onRejected: (reason, detail) => {
          this.deps.onError?.(new Error(`supervisor control rejected: ${reason}${detail ? `: ${detail}` : ''}`))
        }
      })
      await this.server.start()
      // AppImage mount paths change between launches. Rewriting the wrappers is
      // cheap and prevents a live CLI path from going stale.
      for (const binding of this.deps.store.listAll()) {
        const repository = this.deps.repositories.findById(binding.repoId)
        if (!repository) continue
        try {
          this.writeControlFiles(binding.repoId, binding.sessionId, binding.controlToken, repository.executionTarget)
        } catch (error) {
          this.deps.onError?.(error)
        }
      }
    } catch (error) {
      this.started = false
      await this.server?.stop().catch(() => undefined)
      this.server = null
      throw error
    }
  }

  async stop(): Promise<void> {
    this.events.dispose()
    await this.server?.stop().catch(() => undefined)
    this.server = null
    this.started = false
  }

  notifyTaskChange(): void {
    this.events.record({ kind: 'tasks.changed' })
  }

  async open(repoId: RepoId): Promise<SessionSummary> {
    return this.ensure(repoId)
  }

  async ensure(repoId: RepoId): Promise<SessionSummary> {
    const key = String(repoId)
    const existing = this.ensuring.get(key)
    if (existing) return existing
    const promise = this.ensureInner(repoId).finally(() => this.ensuring.delete(key))
    this.ensuring.set(key, promise)
    return promise
  }

  private async ensureInner(repoId: RepoId): Promise<SessionSummary> {
    if (!this.started) await this.start()
    const repository = this.deps.repositories.findById(repoId)
    if (!repository) {
      throw makeAppError('INVALID_ARGUMENT', 'That repository is not registered.', {
        context: { repoId }
      })
    }

    const binding = this.deps.store.findByRepo(repoId)
    if (binding) {
      try {
        const session = await this.getOrRestart(binding.sessionId)
        this.writeControlFiles(repoId, binding.sessionId, binding.controlToken, repository.executionTarget)
        const current = this.deps.store.findByRepo(repoId)
        if (current?.initializedAt === null) {
          await this.bootstrap(session, repository.displayName, binding.controlToken)
          this.deps.store.setInitialized(repoId, this.deps.now(), this.deps.now())
        }
        return session
      } catch (error) {
        if (!isMissingSession(error)) throw error
        // The binding's session was removed outside iCode; fall through and
        // create a fresh supervisor instead of leaving a dead entry.
      }
    }

    const harness = await this.chooseHarness(repoId)
    const created = await this.deps.sessions.create(
      {
        repoId,
        harness,
        title: `Supervisor · ${repository.displayName}`,
        cols: 120,
        rows: 30
      },
      { role: 'supervisor' }
    )
    const controlToken = randomBytes(32).toString('hex')
    const now = this.deps.now()
    this.deps.store.upsert(
      { repoId, sessionId: created.id as SessionId, controlToken, initializedAt: null },
      now
    )
    this.writeControlFiles(repoId, created.id as SessionId, controlToken, repository.executionTarget)
    await this.bootstrap(created, repository.displayName, controlToken)
    this.deps.store.setInitialized(repoId, now, now)
    return created
  }

  private async getOrRestart(sessionId: SessionId): Promise<SessionSummary> {
    let session: SessionSummary | null = null
    try {
      session = await this.deps.sessions.get(sessionId)
    } catch {
      this.deps.store.deleteBySession(sessionId)
      throw makeAppError('SESSION_NOT_FOUND', 'The Supervisor session no longer exists.')
    }
    if (session === null) {
      this.deps.store.deleteBySession(sessionId)
      throw makeAppError('SESSION_NOT_FOUND', 'The Supervisor session no longer exists.')
    }
    if (session.state === 'live' || session.state === 'starting') return session
    if (session.sleeping === true) {
      return this.deps.sessions.wake(sessionId)
    }
    // A restarted TUI may have lost the conversation that carried the bootstrap
    // prompt (not every harness has a resume token). Re-send it once after the
    // restart; the binding's initialized marker is cleared for that reason.
    const binding = this.deps.store.findBySession(sessionId)
    if (binding) this.deps.store.setInitialized(binding.repoId, null, this.deps.now())
    return this.deps.sessions.restart(sessionId, { resume: true })
  }

  private async chooseHarness(repoId: RepoId): Promise<HarnessId> {
    const detections = await this.deps.listHarnesses({ repoId })
    for (const harness of SUPERVISOR_HARNESS_PRIORITY) {
      const detection = detections.find((entry) => entry.harness === harness)
      if (detection?.state === 'available') return harness
    }
    throw makeAppError(
      'HARNESS_UNAVAILABLE',
      'No agent harness is available for this project.',
      { detail: `Detected: ${detections.map((entry) => `${entry.harness}:${entry.state}`).join(', ')}` }
    )
  }

  private async bootstrap(
    session: SessionSummary,
    repoName: string,
    controlToken: string
  ): Promise<void> {
    const files = this.controlFilesFor(session.repoId as RepoId, session.id as SessionId, controlToken, this.targetFor(session.repoId))
    const prompt = buildBootstrapPrompt({
      repoName,
      command: files.command,
      instructionsPath: files.instructionsPath
    })
    const incarnation = session.incarnationId
    if (!incarnation) return
    // The PTY is live before the TUI has drawn its composer. A paste sent in
    // that window is buffered, but the Enter after it can be lost. Give Claude
    // Code/Codex time to finish starting before the first write.
    await this.delay(this.deps.bootstrapDelayMs ?? 2_500)
    await this.deps.sessions.write(session.id, incarnation, buildAgentPromptPaste(prompt))
    await this.delay(AGENT_SUBMIT_DELAY_MS)
    await this.deps.sessions.write(session.id, incarnation, '\r')
    await this.confirmClaudeSubmission(session)
  }

  /**
   * A startup race can still leave a long prompt sitting in Claude's composer.
   * Claude's activity hook fires only after the turn starts, so `unknown` after
   * the first Enter is the signal to submit again. Extra empty submits are
   * harmless; an unsubmitted bootstrap leaves the product unusable.
   */
  private async confirmClaudeSubmission(session: SessionSummary): Promise<void> {
    if (session.harness !== 'claude' || !this.deps.activity) return
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.delay(1_500)
      const activity = this.deps.activity.get(session.id)
      if (activity.state !== 'unknown') return
      if (!session.incarnationId) return
      await this.deps.sessions.write(session.id, session.incarnationId, '\r')
    }
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }

  private targetFor(repoId: string): ExecutionTarget {
    return this.deps.repositories.findById(repoId as RepoId)?.executionTarget ?? { kind: 'local' }
  }

  private endpoint(): string {
    return supervisorSocketPath({
      userDataDir: this.deps.userDataDir,
      platform: this.deps.platform
    })
  }

  private writeControlFiles(
    repoId: RepoId,
    sessionId: SessionId,
    controlToken: string,
    target: ExecutionTarget
  ): ReturnType<typeof writeSupervisorControlFiles> {
    return this.controlFilesFor(repoId, sessionId, controlToken, target)
  }

  private controlFilesFor(
    repoId: RepoId,
    sessionId: SessionId,
    controlToken: string,
    target: ExecutionTarget
  ): ReturnType<typeof writeSupervisorControlFiles> {
    const repository = this.deps.repositories.findById(repoId)
    if (!repository) {
      throw makeAppError('INVALID_ARGUMENT', 'That repository is not registered.')
    }
    try {
      return writeSupervisorControlFiles({
        userDataDir: this.deps.userDataDir,
        execPath: this.deps.execPath,
        repoId,
        repoName: repository.displayName,
        sessionId,
        endpoint: this.endpoint(),
        token: controlToken,
        target,
        platform: this.deps.platform
      })
    } catch (cause) {
      throw makeAppError('SUPERVISOR_UNAVAILABLE', messageOf(cause))
    }
  }

  private async handleControl(request: SupervisorControlRequest): Promise<SupervisorControlResponse> {
    const binding = this.deps.store.findByToken(request.token)
    if (!binding) {
      return error('HOST_AUTH_FAILED', 'The supervisor token is not valid.')
    }
    const op = request.op
    try {
      switch (op) {
        case 'state':
          return { ok: true, value: await this.state(binding.repoId) }
        case 'tasks.list':
          return { ok: true, value: this.listTasks(binding.repoId, request.input) }
        case 'tasks.get':
          return this.getTask(binding.repoId, request.input)
        case 'tasks.changes':
          return this.taskChanges(binding.repoId, request.input)
        case 'tasks.diff':
          return this.taskDiff(binding.repoId, request.input)
        case 'tasks.propose':
          return this.propose(binding, request.input)
        case 'tasks.cancel':
          return this.cancel(binding, request.input)
        case 'tasks.retry':
          return this.retry(binding, request.input)
        case 'sessions.message':
          return this.message(binding, request.input)
        case 'review.recommend':
          return this.recommendReview(binding, request.input)
        case 'events.wait':
          return this.waitForEvents(binding.repoId, request.input)
        default:
          return error('INVALID_ARGUMENT', `Unknown supervisor operation: ${op}`)
      }
    } catch (cause) {
      return error('INTERNAL', messageOf(cause))
    }
  }

  private async state(repoId: RepoId): Promise<unknown> {
    const repository = this.deps.repositories.findById(repoId)
    if (!repository) throw new Error('That repository is not registered.')
    const tasks = this.deps.tasks.list({ repoId, limit: 200 })
    const counts = {
      pendingApproval: 0,
      queued: 0,
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    }
    for (const task of tasks) {
      if (task.approval === 'pending' && task.status === 'queued') counts.pendingApproval += 1
      if (task.status === 'queued' && task.approval !== 'pending') counts.queued += 1
      if (task.status === 'dispatching' || task.status === 'running') counts.active += 1
      if (task.status === 'waiting') counts.waiting += 1
      if (task.status === 'completed') counts.completed += 1
      if (task.status === 'failed') counts.failed += 1
      if (task.status === 'cancelled') counts.cancelled += 1
    }
    const binding = this.deps.store.findByRepo(repoId)
    const session = binding
      ? await this.deps.sessions.get(binding.sessionId).catch(() => null)
      : null
    return {
      project: { id: repoId, name: repository.displayName },
      supervisor: session
        ? {
            sessionId: session.id,
            harness: session.harness,
            state: session.state,
            activity: session.activity?.state ?? 'unknown'
          }
        : null,
      maxConcurrent: this.deps.tasks.maxConcurrent(),
      cursor: this.events.current(),
      counts,
      tasks: tasks.slice(0, 30).map(taskSummary)
    }
  }

  private listTasks(repoId: RepoId, input: unknown): TaskSummary[] {
    const record = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const statuses = Array.isArray(record.statuses)
      ? record.statuses.filter((value): value is string => typeof value === 'string')
      : undefined
    const approvals = Array.isArray(record.approvals)
      ? record.approvals.filter((value): value is string => typeof value === 'string')
      : undefined
    const limit =
      typeof record.limit === 'number' && Number.isFinite(record.limit)
        ? Math.max(1, Math.min(200, Math.trunc(record.limit)))
        : 100
    return this.deps.tasks
      .list({
        repoId,
        ...(statuses ? { statuses: statuses as never } : {}),
        ...(approvals ? { approvals: approvals as never } : {}),
        limit
      })
      .map(taskSummary)
  }

  private getTask(repoId: RepoId, input: unknown): SupervisorControlResponse {
    const taskId = stringField(input, 'taskId')
    if (!taskId) return error('INVALID_ARGUMENT', 'tasks.get needs a taskId.')
    const task = this.deps.tasks.get(taskId)
    if (!task || task.repoId !== repoId) {
      return error('INVALID_ARGUMENT', 'That task is not in this project.')
    }
    return {
      ok: true,
      value: {
        ...taskSummary(task),
        prompt: task.prompt,
        worktreePath: task.worktreePath,
        resultSummary: task.resultSummary,
        errorDetail: task.errorDetail,
        reviewNote: task.reviewNote,
        reviewRecommendationNote: task.reviewRecommendationNote,
        reviewRecommendedAt: task.reviewRecommendedAt
      }
    }
  }

  private async taskChanges(repoId: RepoId, input: unknown): Promise<SupervisorControlResponse> {
    const taskId = stringField(input, 'taskId')
    if (!taskId) return error('INVALID_ARGUMENT', 'tasks.changes needs a taskId.')
    const task = this.deps.tasks.get(taskId)
    if (!task || task.repoId !== repoId) {
      return error('INVALID_ARGUMENT', 'That task is not in this project.')
    }
    const result = await this.deps.tasks.changes(taskId)
    if (!result.ok) return error(result.error.code, result.error.message, result.error.detail)
    return { ok: true, value: result.value }
  }

  private async taskDiff(repoId: RepoId, input: unknown): Promise<SupervisorControlResponse> {
    const taskId = stringField(input, 'taskId')
    const path = stringField(input, 'path')
    if (!taskId || !path) return error('INVALID_ARGUMENT', 'tasks.diff needs taskId and path.')
    const task = this.deps.tasks.get(taskId)
    if (!task || task.repoId !== repoId) {
      return error('INVALID_ARGUMENT', 'That task is not in this project.')
    }
    if (!task.sessionId) return error('INVALID_ARGUMENT', 'That task has no session yet.')
    const listing = await this.deps.tasks.changes(taskId)
    if (!listing.ok || listing.value.status !== 'available') {
      return error('INVALID_ARGUMENT', 'That task has no available changes.')
    }
    const file = listing.value.files?.find((entry) => entry.path === path)
    if (!file) return error('INVALID_ARGUMENT', 'That file is not part of this task change list.')
    const diff = await this.deps.gitWorkspace.changeDiff({
      sessionId: task.sessionId,
      path: file.path,
      oldPath: file.oldPath,
      scope: file.origin === 'untracked' ? 'untracked' : 'unstaged',
      status: file.status as never,
      binary: file.binary,
      symlink: file.symlink,
      additions: file.additions,
      deletions: file.deletions
    })
    if (diff.status === 'unavailable') return { ok: true, value: diff }
    const patch = diff.patch.length > MAX_DIFF_BYTES ? diff.patch.slice(0, MAX_DIFF_BYTES) : diff.patch
    return {
      ok: true,
      value: {
        path: diff.path,
        fileStatus: diff.fileStatus,
        patch,
        truncated: diff.truncated || patch.length < diff.patch.length,
        binary: diff.binary
      }
    }
  }

  private async propose(
    binding: { repoId: RepoId; sessionId: SessionId },
    input: unknown
  ): Promise<SupervisorControlResponse> {
    const record = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    let drafts: unknown[] = []
    if (typeof record.file === 'string') {
      const read = await this.deps.workspaceFiles.read(binding.sessionId, record.file)
      if (read.status !== 'ok') {
        return error('INVALID_ARGUMENT', `Cannot read the proposal file: ${read.reason}`)
      }
      drafts = parseDrafts(read.text)
    } else if (Array.isArray(record.tasks)) {
      drafts = record.tasks
    } else {
      return error('INVALID_ARGUMENT', 'tasks.propose needs a file or a tasks array.')
    }
    if (drafts.length === 0) return error('INVALID_ARGUMENT', 'The proposal has no tasks.')
    if (drafts.length > 20) return error('INVALID_ARGUMENT', 'A proposal may contain at most 20 tasks.')

    const session = await this.deps.sessions.get(binding.sessionId)
    const fallbackHarness = session.harness
    const created: TaskSummary[] = []
    for (const draft of drafts) {
      if (draft === null || typeof draft !== 'object') {
        return error('INVALID_ARGUMENT', 'Every proposed task must be an object.')
      }
      const task = draft as Record<string, unknown>
      const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : ''
      if (prompt.length === 0) return error('INVALID_ARGUMENT', 'Every proposed task needs a prompt.')
      const title = typeof task.title === 'string' ? task.title : undefined
      const requestedHarness = typeof task.harness === 'string' ? task.harness : fallbackHarness
      if (!HARNESS_IDS.includes(requestedHarness as HarnessId) || requestedHarness === 'shell') {
        return error('INVALID_ARGUMENT', `Unsupported harness: ${requestedHarness}`)
      }
      const key =
        typeof task.idempotencyKey === 'string' && task.idempotencyKey.length > 0
          ? task.idempotencyKey
          : createHash('sha256').update(`${title ?? ''}\n${prompt}`).digest('hex').slice(0, 24)
      const result = this.deps.tasks.create({
        repoId: binding.repoId,
        title,
        prompt,
        harness: requestedHarness as HarnessId,
        origin: 'supervisor',
        createdBySessionId: binding.sessionId,
        dedupeKey: `supervisor:${binding.sessionId}:${key}`
      })
      if (!result.ok) {
        return error(result.error.code, result.error.message, result.error.detail)
      }
      const view = this.deps.tasks.get(result.value.id)
      if (view) created.push(taskSummary(view))
    }
    this.deps.store.recordAction({
      repoId: binding.repoId,
      sessionId: binding.sessionId,
      op: 'tasks.propose',
      taskId: null,
      outcome: 'ok',
      detail: { count: created.length },
      now: this.deps.now()
    })
    return { ok: true, value: { created } }
  }

  private async cancel(
    binding: { repoId: RepoId; sessionId: SessionId },
    input: unknown
  ): Promise<SupervisorControlResponse> {
    const taskId = stringField(input, 'taskId')
    if (!taskId) return error('INVALID_ARGUMENT', 'tasks.cancel needs a taskId.')
    const task = this.deps.tasks.get(taskId)
    if (!task || task.repoId !== binding.repoId || task.createdBySessionId !== binding.sessionId) {
      return error('INVALID_ARGUMENT', 'The Supervisor may cancel only tasks it created.')
    }
    const result = await this.deps.tasks.cancel(taskId)
    if (!result.ok) return error(result.error.code, result.error.message, result.error.detail)
    this.audit(binding, 'tasks.cancel', taskId, 'ok')
    return { ok: true, value: taskSummary(this.deps.tasks.get(taskId)!) }
  }

  private async retry(
    binding: { repoId: RepoId; sessionId: SessionId },
    input: unknown
  ): Promise<SupervisorControlResponse> {
    const taskId = stringField(input, 'taskId')
    if (!taskId) return error('INVALID_ARGUMENT', 'tasks.retry needs a taskId.')
    const task = this.deps.tasks.get(taskId)
    if (!task || task.repoId !== binding.repoId || task.createdBySessionId !== binding.sessionId) {
      return error('INVALID_ARGUMENT', 'The Supervisor may retry only tasks it created.')
    }
    const result = this.deps.tasks.retry(taskId)
    if (!result.ok) return error(result.error.code, result.error.message, result.error.detail)
    this.audit(binding, 'tasks.retry', taskId, 'ok')
    return { ok: true, value: taskSummary(this.deps.tasks.get(result.value.id)!) }
  }

  private async message(
    binding: { repoId: RepoId; sessionId: SessionId },
    input: unknown
  ): Promise<SupervisorControlResponse> {
    const taskId = stringField(input, 'taskId')
    const text = stringField(input, 'text')
    if (!taskId || !text) return error('INVALID_ARGUMENT', 'sessions.message needs taskId and text.')
    if (text.length > MAX_MESSAGE) return error('INVALID_ARGUMENT', 'That message is too long.')
    const task = this.deps.tasks.get(taskId)
    if (!task || task.repoId !== binding.repoId || task.createdBySessionId !== binding.sessionId) {
      return error('INVALID_ARGUMENT', 'The Supervisor may message only tasks it created.')
    }
    if (!task.sessionId) return error('INVALID_ARGUMENT', 'That task has no session to message.')
    const session = await this.deps.sessions.get(task.sessionId)
    if (session.state !== 'live' || !session.incarnationId) {
      return error('SESSION_NOT_LIVE', 'That task session is not live.')
    }
    await this.deps.sessions.write(
      task.sessionId,
      session.incarnationId,
      buildAgentPromptPaste(text)
    )
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, AGENT_SUBMIT_DELAY_MS)
      timer.unref?.()
    })
    await this.deps.sessions.write(task.sessionId, session.incarnationId, '\r')
    this.audit(binding, 'sessions.message', taskId, 'ok')
    return { ok: true, value: { taskId, delivered: true } }
  }

  private recommendReview(
    binding: { repoId: RepoId; sessionId: SessionId },
    input: unknown
  ): SupervisorControlResponse {
    const taskId = stringField(input, 'taskId')
    const decision = stringField(input, 'decision')
    if (!taskId || (decision !== 'accept' && decision !== 'reject')) {
      return error('INVALID_ARGUMENT', 'review.recommend needs taskId and decision accept|reject.')
    }
    const task = this.deps.tasks.get(taskId)
    if (!task || task.repoId !== binding.repoId) {
      return error('INVALID_ARGUMENT', 'That task is not in this project.')
    }
    const note = typeof (input as Record<string, unknown>)?.note === 'string'
      ? String((input as Record<string, unknown>).note)
      : null
    const result = this.deps.tasks.recommendReview(taskId, decision, note, binding.sessionId)
    if (!result.ok) return error(result.error.code, result.error.message, result.error.detail)
    this.audit(binding, 'review.recommend', taskId, decision)
    return { ok: true, value: taskSummary(this.deps.tasks.get(taskId)!) }
  }

  private async waitForEvents(
    repoId: RepoId,
    input: unknown
  ): Promise<SupervisorControlResponse> {
    const record = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const after = typeof record.after === 'number' && Number.isFinite(record.after) ? Math.trunc(record.after) : this.events.current()
    const timeoutMs = typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs) ? record.timeoutMs : 25_000
    const cursor = await this.events.wait(repoId, after, timeoutMs)
    return {
      ok: true,
      value: {
        cursor,
        changed: cursor > after,
        events: this.events.since(after).slice(-10)
      }
    }
  }

  private audit(
    binding: { repoId: RepoId; sessionId: SessionId },
    op: string,
    taskId: string | null,
    outcome: string
  ): void {
    this.deps.store.recordAction({
      repoId: binding.repoId,
      sessionId: binding.sessionId,
      op,
      taskId,
      outcome,
      now: this.deps.now()
    })
  }
}

function stringField(input: unknown, key: string): string | null {
  if (input === null || typeof input !== 'object') return null
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseDrafts(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text)
  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === 'object') {
    const tasks = (parsed as Record<string, unknown>).tasks
    if (Array.isArray(tasks)) return tasks
  }
  throw new Error('The proposal file must contain an array or { "tasks": [...] }.')
}

function isMissingSession(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const record = error as { code?: unknown; appError?: { code?: unknown } }
  return record.code === 'SESSION_NOT_FOUND' || record.appError?.code === 'SESSION_NOT_FOUND'
}

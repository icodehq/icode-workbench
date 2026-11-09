import { createHash } from 'node:crypto'
import type { AssistantActionPayload } from './assistant-envelope'
import type { AssistantPolicy } from './assistant-policy'
import type { AssistantStore } from '../persistence/assistant-store'
import type { RepositoryStore } from '../persistence/repository-store'
import type { TaskService } from '../tasks/task-service'
import type { TaskStore } from '../tasks/task-store'
import type { SessionService } from '../sessions/session-service'
import type { SupervisorService } from '../supervisor/supervisor-service'
import type { GitWorkspaceService } from '../git/git-workspace-service'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { AssistantCard } from '../../shared/domain/assistant'
import {
  MIRA_ACTOR_ID,
  MIRA_POLICY_APPROVER
} from '../../shared/domain/assistant'
import type { TaskStatus } from '../../shared/domain/task'
import type { HarnessId } from '../../shared/domain/harness'
import type { RepoId } from '../../shared/domain/ids'
import { buildAgentPromptPaste, AGENT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt'

const MAX_DIFF_BYTES = 200_000

export type AssistantActionResult = {
  op: string
  ok: boolean
  message: string
  value?: unknown
  card?: AssistantCard
}

export type AssistantActionDeps = {
  store: AssistantStore
  tasks: TaskService
  taskStore: TaskStore
  sessions: SessionService
  supervisors: SupervisorService
  repositories: RepositoryStore
  gitWorkspace: GitWorkspaceService
  policy: AssistantPolicy
  listHarnesses: (input?: { repoId?: string }) => Promise<HarnessDetectionResult[]>
  threadId: string
  runId: string
  now: () => number
}

function compactTask(task: {
  id: string
  repoId: string
  title: string
  status: string
  approval: string
  origin: string
  createdByActor: string | null
  sessionId: string | null
  attempt: number
  attemptMode: string
  canResume?: boolean
  error: string | null
  reviewDecision: string
  updatedAt: number
}): Record<string, unknown> {
  return {
    id: task.id,
    repoId: task.repoId,
    title: task.title,
    status: task.status,
    approval: task.approval,
    origin: task.origin,
    createdByActor: task.createdByActor,
    sessionId: task.sessionId,
    attempt: task.attempt,
    attemptMode: task.attemptMode,
    canResume: task.canResume ?? false,
    error: task.error,
    reviewDecision: task.reviewDecision,
    updatedAt: task.updatedAt
  }
}

function compactSession(session: {
  id: string
  repoId: string
  title: string
  harness: string
  state: string
  role?: string
  activity?: { state: string } | null
}): Record<string, unknown> {
  return {
    id: session.id,
    repoId: session.repoId,
    title: session.title,
    harness: session.harness,
    state: session.state,
    role: session.role ?? 'interactive',
    activity: session.activity?.state ?? null
  }
}

/**
 * The in-process control plane behind Mira's typed actions.
 *
 * Every write is authorized here and audited in `assistant_actions`. The model
 * never receives a task/session handle it can use outside this executor.
 */
export class AssistantActions {
  constructor(private readonly deps: AssistantActionDeps) {}

  async execute(action: AssistantActionPayload): Promise<AssistantActionResult> {
    try {
      switch (action.op) {
        case 'state':
          return this.state()
        case 'projects.list':
          return this.projectsList()
        case 'tasks.listAll':
          return this.tasksListAll(action)
        case 'tasks.get':
          return this.tasksGet(action.taskId)
        case 'tasks.changes':
          return this.tasksChanges(action.taskId)
        case 'tasks.diff':
          return this.tasksDiff(action.taskId, action.path)
        case 'sessions.list':
          return this.sessionsList(action.repoId)
        case 'tasks.create':
          return this.tasksCreate(action)
        case 'tasks.cancel':
          return this.tasksCancel(action.taskId)
        case 'tasks.retry':
          return this.tasksRetry(action.taskId)
        case 'tasks.resume':
          return this.tasksResume(action.taskId)
        case 'tasks.archive':
          return this.tasksArchive(action.taskId)
        case 'sessions.message':
          return this.sessionsMessage(action.taskId, action.text)
        case 'supervisor.message':
          return this.supervisorMessage(action.repoId, action.text)
        case 'review.recommend':
          return this.reviewRecommend(action.taskId, action.decision, action.note)
        case 'notify':
          return this.notify(action.text, action.kind, action.priority)
        case 'memory.set':
          return this.memorySet(action.key, action.value)
        case 'memory.forget':
          return this.memoryForget(action.key)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit(action.op, false, 'error', { message })
      return { op: action.op, ok: false, message, card: { type: 'error', message } }
    }
  }

  private state(): AssistantActionResult {
    const tasks = this.deps.taskStore.list({ limit: 200 })
    const counts = {
      pendingApproval: 0,
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 0
    }
    for (const task of tasks) {
      if (task.approval === 'pending' && task.status === 'queued') counts.pendingApproval += 1
      if (task.status === 'dispatching' || task.status === 'running') counts.active += 1
      if (task.status === 'waiting') counts.waiting += 1
      if (task.status === 'completed') counts.completed += 1
      if (task.status === 'failed') counts.failed += 1
    }
    return {
      op: 'state',
      ok: true,
      message: 'Current project state.',
      value: {
        projects: this.deps.repositories.list().length,
        maxConcurrent: this.deps.tasks.maxConcurrent(),
        counts,
        tasks: tasks.slice(0, 30).map(compactTask)
      }
    }
  }

  private projectsList(): AssistantActionResult {
    const value = this.deps.repositories.list().map((repo) => ({
      id: repo.id,
      name: repo.displayName,
      target: repo.executionTarget,
      branch: repo.currentBranch,
      availability: repo.availability,
      preparation: repo.preparation?.state ?? null
    }))
    return { op: 'projects.list', ok: true, message: `${String(value.length)} projects.`, value }
  }

  private tasksListAll(action: Extract<AssistantActionPayload, { op: 'tasks.listAll' }>): AssistantActionResult {
    const statuses = action.statuses?.filter(Boolean) as TaskStatus[] | undefined
    const records = this.deps.taskStore.list({
      ...(statuses === undefined ? {} : { statuses }),
      ...(action.approvals === undefined ? {} : { approvals: action.approvals }),
      ...(action.includeArchived === true ? { includeArchived: true } : {}),
      limit: action.limit ?? 100
    })
    return {
      op: 'tasks.listAll',
      ok: true,
      message: `${String(records.length)} tasks.`,
      value: records.map(compactTask)
    }
  }

  private tasksGet(taskId: string): AssistantActionResult {
    const task = this.deps.tasks.get(taskId)
    if (!task) return this.error('tasks.get', 'That task does not exist.')
    return {
      op: 'tasks.get',
      ok: true,
      message: 'Task loaded.',
      value: {
        ...compactTask(task),
        prompt: task.prompt.slice(0, 8_000),
        worktreePath: task.worktreePath,
        resultSummary: task.resultSummary,
        errorDetail: task.errorDetail,
        reviewNote: task.reviewNote,
        reviewRecommendation: task.reviewRecommendation
      }
    }
  }

  private async tasksChanges(taskId: string): Promise<AssistantActionResult> {
    const task = this.deps.tasks.get(taskId)
    if (!task) return this.error('tasks.changes', 'That task does not exist.')
    const result = await this.deps.tasks.changes(taskId)
    return result.ok
      ? {
          op: 'tasks.changes',
          ok: true,
          message: 'Changes loaded.',
          value: result.value
        }
      : this.error('tasks.changes', result.error.message)
  }

  private async tasksDiff(taskId: string, path: string): Promise<AssistantActionResult> {
    const task = this.deps.tasks.get(taskId)
    if (!task?.sessionId) return this.error('tasks.diff', 'That task has no session.')
    const listing = await this.deps.tasks.changes(taskId)
    if (!listing.ok || listing.value.status !== 'available') {
      return this.error('tasks.diff', 'That task has no available changes.')
    }
    const file = listing.value.files?.find((entry) => entry.path === path)
    if (!file) return this.error('tasks.diff', 'That file is not in this task change list.')
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
    if (diff.status === 'unavailable') {
      return {
        op: 'tasks.diff',
        ok: true,
        message: 'Diff unavailable.',
        value: diff
      }
    }
    return {
      op: 'tasks.diff',
      ok: true,
      message: 'Diff loaded.',
      value: {
        path: diff.path,
        fileStatus: diff.fileStatus,
        patch: diff.patch.slice(0, MAX_DIFF_BYTES),
        truncated: diff.truncated || diff.patch.length > MAX_DIFF_BYTES,
        binary: diff.binary
      }
    }
  }

  private async sessionsList(repoId: string | undefined): Promise<AssistantActionResult> {
    const view = await this.deps.sessions.list()
    const sessions = view.sessions
      .filter((session) => repoId === undefined || session.repoId === repoId)
      .map(compactSession)
    return { op: 'sessions.list', ok: true, message: `${String(sessions.length)} sessions.`, value: sessions }
  }

  private async tasksCreate(
    action: Extract<AssistantActionPayload, { op: 'tasks.create' }>
  ): Promise<AssistantActionResult> {
    const repo = this.deps.repositories.findById(action.repoId as RepoId)
    if (!repo) return this.error('tasks.create', 'That repository is not registered.')
    const harness = await this.resolveHarness(action.repoId as RepoId, action.harness)
    if (!harness) {
      return this.error('tasks.create', 'No agent harness is available in that project.')
    }
    const settings = this.deps.store.getSettings()
    const decision = this.deps.policy.classify({
      repoId: action.repoId as RepoId,
      title: action.title ?? null,
      prompt: action.prompt,
      settings: settings.autoDispatch
    })
    const key =
      action.idempotencyKey ??
      createHash('sha256').update(`${action.title ?? ''}\n${action.prompt}`).digest('hex').slice(0, 24)
    const result = this.deps.tasks.create({
      repoId: action.repoId as RepoId,
      title: action.title,
      prompt: action.prompt,
      harness,
      origin: 'supervisor',
      createdByActor: MIRA_ACTOR_ID,
      createdBySessionId: null,
      assistantRunId: this.deps.runId,
      approvalPolicy: decision.autoApprove ? 'mira-low-risk' : 'mira-human-approval',
      approval: decision.autoApprove ? 'approved' : 'pending',
      ...(decision.autoApprove ? { approvedBy: MIRA_POLICY_APPROVER } : {}),
      dedupeKey: `mira:${this.deps.runId}:${key}`
    })
    if (!result.ok) {
      return this.error('tasks.create', result.error.message)
    }
    const task = this.deps.tasks.get(result.value.id)
    if (!task) return this.error('tasks.create', 'The task could not be read after creation.')
    const card: AssistantCard = {
      type: 'task',
      taskId: task.id,
      repoId: task.repoId,
      title: task.title,
      status: task.status,
      approval: task.approval,
      autoApproved: decision.autoApprove,
      reasons: decision.reasons
    }
    this.audit('tasks.create', true, decision.autoApprove ? 'auto-dispatched' : 'pending-approval', {
      repoId: task.repoId,
      taskId: task.id,
      risk: decision.risk,
      reasons: decision.reasons
    })
    return {
      op: 'tasks.create',
      ok: true,
      message: decision.autoApprove
        ? `Queued "${task.title}" automatically under the low-risk policy.`
        : `"${task.title}" needs your approval: ${decision.reasons.join('; ') || 'policy requires a human'}.`,
      value: compactTask(task),
      card
    }
  }

  private async tasksCancel(taskId: string): Promise<AssistantActionResult> {
    const task = this.deps.tasks.get(taskId)
    if (!task) return this.error('tasks.cancel', 'That task does not exist.')
    if (!this.canOperate(task)) {
      return this.error(
        'tasks.cancel',
        'That task was created by a person. Mira can suggest a change instead of cancelling it.'
      )
    }
    const result = await this.deps.tasks.cancel(taskId)
    if (!result.ok) return this.error('tasks.cancel', result.error.message)
    this.audit('tasks.cancel', true, 'ok', { repoId: task.repoId, taskId })
    return {
      op: 'tasks.cancel',
      ok: true,
      message: `Cancelled "${task.title}".`,
      value: compactTask(this.deps.tasks.get(taskId)!),
      card: {
        type: 'task',
        taskId,
        repoId: task.repoId,
        title: task.title,
        status: 'cancelled',
        approval: task.approval
      }
    }
  }

  private tasksRetry(taskId: string): AssistantActionResult {
    const task = this.deps.tasks.get(taskId)
    if (!task) return this.error('tasks.retry', 'That task does not exist.')
    if (!this.canOperate(task)) {
      return this.error(
        'tasks.retry',
        'That task was created by a person. Mira can suggest a fix task instead of retrying it.'
      )
    }
    const result = this.deps.tasks.retry(taskId, { assistantRunId: this.deps.runId })
    if (!result.ok) return this.error('tasks.retry', result.error.message)
    const retried = this.deps.tasks.get(result.value.id)
    this.audit('tasks.retry', true, 'ok', { repoId: task.repoId, taskId: result.value.id })
    return {
      op: 'tasks.retry',
      ok: true,
      message: `Retried as attempt ${String(result.value.attempt)}.`,
      value: retried ? compactTask(retried) : null,
      card: retried
        ? {
            type: 'task',
            taskId: retried.id,
            repoId: retried.repoId,
            title: retried.title,
            status: retried.status,
            approval: retried.approval,
            canResume: retried.canResume
          }
        : undefined
    }
  }

  /**
   * Continues a stopped task in its existing session and worktree.
   *
   * The ownership rule is the same as retry: Mira may continue only work she
   * or a supervisor created. A person's task needs the person's decision.
   */
  private tasksResume(taskId: string): AssistantActionResult {
    const task = this.deps.tasks.get(taskId)
    if (!task) return this.error('tasks.resume', 'That task does not exist.')
    if (!this.canOperate(task)) {
      return this.error(
        'tasks.resume',
        'That task was created by a person. Mira can suggest a fix task instead of continuing it.'
      )
    }
    const result = this.deps.tasks.resume(taskId, { assistantRunId: this.deps.runId })
    if (!result.ok) return this.error('tasks.resume', result.error.message)
    const continued = this.deps.tasks.get(result.value.id)
    this.audit('tasks.resume', true, 'ok', { repoId: task.repoId, taskId: result.value.id })
    return {
      op: 'tasks.resume',
      ok: true,
      message: `Continued as attempt ${String(result.value.attempt)}.`,
      value: continued ? compactTask(continued) : null,
      card: continued
        ? {
            type: 'task',
            taskId: continued.id,
            repoId: continued.repoId,
            title: continued.title,
            status: continued.status,
            approval: continued.approval,
            canResume: continued.canResume
          }
        : undefined
    }
  }

  /**
   * Archive is the reversible cleanup primitive. Mira may hide finished work
   * from the working list, but she never hard-deletes a task.
   */
  private tasksArchive(taskId: string): AssistantActionResult {
    const task = this.deps.tasks.get(taskId)
    if (!task) return this.error('tasks.archive', 'That task does not exist.')
    const result = this.deps.tasks.archive(taskId)
    if (!result.ok) return this.error('tasks.archive', result.error.message)
    this.audit('tasks.archive', true, 'ok', { repoId: task.repoId, taskId })
    return {
      op: 'tasks.archive',
      ok: true,
      message: task.archivedAt !== null
        ? `"${task.title}" is already in history.`
        : `Moved "${task.title}" to history.`,
      value: { taskId, archived: true }
    }
  }

  private async sessionsMessage(taskId: string, text: string): Promise<AssistantActionResult> {
    const task = this.deps.tasks.get(taskId)
    if (!task) return this.error('sessions.message', 'That task does not exist.')
    if (!this.canOperate(task)) {
      return this.error('sessions.message', 'That task was created by a person.')
    }
    if (!task.sessionId) return this.error('sessions.message', 'That task has no session.')
    if (!(await this.deliverToSession(task.sessionId, text))) {
      return this.error('sessions.message', 'That task session is not live.')
    }
    this.audit('sessions.message', true, 'ok', { repoId: task.repoId, taskId })
    return {
      op: 'sessions.message',
      ok: true,
      message: `Sent a message to "${task.title}".`,
      value: { taskId, delivered: true }
    }
  }

  /**
   * Messages the project supervisor, creating its session if this is the first
   * time the project needs one. The supervisor is the execution back office;
   * Mira remains the user's front door.
   */
  private async supervisorMessage(repoId: string, text: string): Promise<AssistantActionResult> {
    const repo = this.deps.repositories.findById(repoId as RepoId)
    if (!repo) return this.error('supervisor.message', 'That repository is not registered.')
    const summary = await this.deps.supervisors.ensure(repoId as RepoId)
    if (!(await this.deliverToSession(summary.id, text))) {
      return this.error('supervisor.message', 'The project supervisor session is not live.')
    }
    this.audit('supervisor.message', true, 'ok', { repoId, sessionId: summary.id })
    return {
      op: 'supervisor.message',
      ok: true,
      message: `Sent a message to the ${repo.displayName} supervisor.`,
      value: { repoId, sessionId: summary.id, delivered: true }
    }
  }

  /** Types a prompt and then submits it with a separate Enter keystroke. */
  private async deliverToSession(sessionId: string, text: string): Promise<boolean> {
    const session = await this.deps.sessions.get(sessionId)
    if (session.state !== 'live' || !session.incarnationId) return false
    await this.deps.sessions.write(sessionId, session.incarnationId, buildAgentPromptPaste(text))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, AGENT_SUBMIT_DELAY_MS)
      timer.unref?.()
    })
    await this.deps.sessions.write(sessionId, session.incarnationId, '\r')
    return true
  }

  private reviewRecommend(
    taskId: string,
    decision: 'accept' | 'reject',
    note?: string
  ): AssistantActionResult {
    const task = this.deps.tasks.get(taskId)
    if (!task) return this.error('review.recommend', 'That task does not exist.')
    const result = this.deps.tasks.recommendReview(taskId, decision, note ?? null, null)
    if (!result.ok) return this.error('review.recommend', result.error.message)
    this.audit('review.recommend', true, decision, { repoId: task.repoId, taskId })
    return {
      op: 'review.recommend',
      ok: true,
      message: `Recorded a non-binding recommendation to ${decision} "${task.title}".`,
      value: { taskId, decision }
    }
  }

  private notify(
    text: string,
    kind: Extract<AssistantActionPayload, { op: 'notify' }>['kind'],
    priority: Extract<AssistantActionPayload, { op: 'notify' }>['priority']
  ): AssistantActionResult {
    const message = this.deps.store.appendMessage({
      id: `msg_${String(this.deps.now())}_${Math.random().toString(36).slice(2, 7)}`,
      threadId: this.deps.threadId,
      runId: this.deps.runId,
      role: 'assistant',
      kind: 'notification',
      body: text,
      card: { type: 'notification', kind: kind ?? 'custom', text },
      notificationKind: kind ?? 'custom',
      notificationPriority: priority ?? 'normal',
      notificationState: 'pending',
      notificationDedupeKey: `run:${this.deps.runId}:notify:${createHash('sha256')
        .update(text)
        .digest('hex')
        .slice(0, 16)}`,
      createdAt: this.deps.now()
    })
    this.audit('notify', message !== null, message ? 'ok' : 'deduped', {
      messageId: message?.id ?? null
    })
    return {
      op: 'notify',
      ok: message !== null,
      message: message ? 'Notification queued.' : 'That notification was already delivered.',
      value: { messageId: message?.id ?? null }
    }
  }

  private memorySet(key: string, value: string): AssistantActionResult {
    this.deps.store.setMemory(key, value, this.deps.now())
    this.audit('memory.set', true, 'ok', { key })
    return { op: 'memory.set', ok: true, message: `Remembered "${key}".`, value: { key } }
  }

  private memoryForget(key: string): AssistantActionResult {
    const removed = this.deps.store.forgetMemory(key)
    this.audit('memory.forget', true, removed ? 'ok' : 'noop', { key })
    return {
      op: 'memory.forget',
      ok: true,
      message: removed ? `Forgot "${key}".` : `I did not know "${key}".`,
      value: { key, removed }
    }
  }

  private canOperate(task: { createdByActor: string | null; origin: string }): boolean {
    return task.createdByActor === MIRA_ACTOR_ID || task.origin === 'supervisor'
  }

  private async resolveHarness(repoId: RepoId, requested?: string): Promise<HarnessId | null> {
    const settings = this.deps.store.getSettings()
    const detection = await this.deps.listHarnesses({ repoId })
    const available = new Set(
      detection.filter((entry) => entry.state === 'available').map((entry) => entry.harness)
    )
    if (requested && available.has(requested as HarnessId)) return requested as HarnessId
    for (const harness of settings.harnessPriority) {
      if (available.has(harness)) return harness
    }
    return null
  }

  private error(op: string, message: string): AssistantActionResult {
    this.audit(op, false, 'rejected', { message })
    return { op, ok: false, message, card: { type: 'error', message } }
  }

  private audit(op: string, ok: boolean, outcome: string, detail: Record<string, unknown>): void {
    this.deps.store.recordAction({
      threadId: this.deps.threadId,
      runId: this.deps.runId,
      actor: 'mira',
      op,
      repoId: typeof detail.repoId === 'string' ? detail.repoId : null,
      taskId: typeof detail.taskId === 'string' ? detail.taskId : null,
      sessionId: typeof detail.sessionId === 'string' ? detail.sessionId : null,
      outcome: ok ? outcome : `rejected:${outcome}`,
      detail,
      now: this.deps.now()
    })
  }
}

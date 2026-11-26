import { createHash } from 'node:crypto'
import type { AssistantActionPayload } from './assistant-envelope'
import type { AssistantPolicy } from './assistant-policy'
import type { AssistantStore } from '../persistence/assistant-store'
import type { MemoryService } from '../memory/memory-service'
import type { PeerMailService } from '../bots/peer-mail-service'
import type { RepositoryStore } from '../persistence/repository-store'
import type { TaskService } from '../tasks/task-service'
import type { TaskStore } from '../tasks/task-store'
import type { ItemService } from '../items/item-service'
import type { SessionService } from '../sessions/session-service'
import type { SupervisorService } from '../supervisor/supervisor-service'
import type { GitWorkspaceService } from '../git/git-workspace-service'
import type { HarnessDetectionResult } from '../harness/harness-detector'
import type { AssistantCard, AssistantSettings } from '../../shared/domain/assistant'
import {
  DEFAULT_ASSISTANT_SETTINGS,
  MIRA_ACTOR_ID,
  MIRA_POLICY_APPROVER
} from '../../shared/domain/assistant'
import type { TaskStatus } from '../../shared/domain/task'
import type { HarnessId } from '../../shared/domain/harness'
import type { RepoId } from '../../shared/domain/ids'
import { buildAgentPromptPaste, AGENT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt'

const MAX_DIFF_BYTES = 200_000

function normalizeMemoryFact(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

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
  /** The bot executing this run; defaults to the legacy assistant actor. */
  botId?: string
  /** The bot's configured display name, for user-facing errors. */
  botName?: string
  /** The bot's group id for this turn, if any. */
  groupId?: string | null
  /** The group thread this turn came from, attached to created tasks for milestones. */
  groupThreadId?: string | null
  group?: { isMember(groupId: string, botId: string): boolean }
  /** Resolve per-bot assistant settings (harness priority, auto-dispatch). */
  botSettings?: (botId: string) => AssistantSettings
  /** The bot's MEMORY.md; absent makes memory actions unavailable. */
  memoryFiles?: MemoryService
  /** Local mail to another bot; absent makes peer mail unavailable. */
  peerMail?: Pick<PeerMailService, 'send'>
  /** Owner-facing item conversation; absent means item actions are unavailable. */
  items?: ItemService
  /** Only the Chief may create tasks for another bot. */
  canAssignOthers?: boolean
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
 * The in-process control plane behind a bot's typed actions.
 *
 * Every write is authorized here and audited in `assistant_actions`. The model
 * never receives a task/session handle it can use outside this executor.
 */
export class AssistantActions {
  private peerMailsSent = 0

  constructor(private readonly deps: AssistantActionDeps) {}

  private actor(): string {
    return this.deps.botId ?? MIRA_ACTOR_ID
  }

  private displayName(): string {
    return this.deps.botName ?? 'The assistant'
  }

  private settingsFor(botId: string): AssistantSettings {
    return this.deps.botSettings?.(botId) ?? DEFAULT_ASSISTANT_SETTINGS
  }

  private currentGroupId(): string | null {
    return this.deps.groupId ?? null
  }

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
        case 'memory.add':
          return this.memoryAdd(action.text)
        case 'memory.forget':
          return this.memoryForget(action.fact)
        case 'peers.message':
          return this.peersMessage(action.to, action.text)
        case 'items.comment':
          return this.itemsComment(action.taskId, action.text)
        case 'items.ask':
          return this.itemsAsk(action.taskId, action.text, action.options)
        case 'items.link':
          return this.itemsLink(action.taskId, action.kind, action.ref)
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
    const actor = this.actor()
    const targetBotId = action.botId ?? this.deps.botId ?? null
    if (
      targetBotId !== null &&
      this.deps.botId !== undefined &&
      targetBotId !== this.deps.botId &&
      this.deps.canAssignOthers !== true
    ) {
      return this.error('tasks.create', 'Only the Chief can assign work to another bot.')
    }
    const targetGroupId = action.groupId ?? this.currentGroupId()
    if (
      targetBotId !== null &&
      targetGroupId !== null &&
      this.deps.groupId !== null &&
      this.deps.groupId !== undefined &&
      targetGroupId === this.deps.groupId &&
      this.deps.group !== undefined &&
      !this.deps.group.isMember(targetGroupId, targetBotId)
    ) {
      return this.error('tasks.create', 'That bot is not a member of the group.')
    }
    const settings =
      targetBotId !== null && targetBotId !== this.deps.botId
        ? this.settingsFor(targetBotId)
        : this.settingsFor(actor)
    const harness = await this.resolveHarness(
      action.repoId as RepoId,
      action.harness,
      settings
    )
    if (!harness) {
      return this.error('tasks.create', 'No agent harness is available in that project.')
    }
    const decision = this.deps.policy.classify({
      repoId: action.repoId as RepoId,
      title: action.title ?? null,
      prompt: action.prompt,
      settings: settings.autoDispatch,
      actor
    })
    const key =
      action.idempotencyKey ??
      createHash('sha256').update(`${action.title ?? ''}\n${action.prompt}`).digest('hex').slice(0, 24)
    const result = this.deps.tasks.create({
      repoId: action.repoId as RepoId,
      title: action.title,
      prompt: action.prompt,
      harness,
      botId: targetBotId,
      groupId: targetGroupId,
      groupThreadId:
        targetGroupId !== null && targetGroupId === this.deps.groupId
          ? (this.deps.groupThreadId ?? null)
          : null,
      acceptanceCriteria: action.acceptanceCriteria ?? null,
      origin: 'supervisor',
      createdByActor: actor,
      createdBySessionId: null,
      assistantRunId: this.deps.runId,
      approvalPolicy: decision.autoApprove ? `${actor}-low-risk` : `${actor}-human-approval`,
      approval: decision.autoApprove ? 'approved' : 'pending',
      ...(decision.autoApprove
        ? { approvedBy: actor === MIRA_ACTOR_ID ? MIRA_POLICY_APPROVER : `${actor}-policy` }
        : {}),
      dedupeKey: `${actor}:${this.deps.runId}:${key}`
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
        `That task was created by a person. ${this.displayName()} can suggest a change instead of cancelling it.`
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
        `That task was created by a person. ${this.displayName()} can suggest a fix task instead of retrying it.`
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
   * The ownership rule is the same as retry: a bot may continue only work it
   * or a supervisor created. A person's task needs the person's decision.
   */
  private tasksResume(taskId: string): AssistantActionResult {
    const task = this.deps.tasks.get(taskId)
    if (!task) return this.error('tasks.resume', 'That task does not exist.')
    if (!this.canOperate(task)) {
      return this.error(
        'tasks.resume',
        `That task was created by a person. ${this.displayName()} can suggest a fix task instead of continuing it.`
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
   * Archive is the reversible cleanup primitive. A bot may hide finished work
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
   * The bot remains the user's front door.
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

  private itemsComment(taskId: string, text: string): AssistantActionResult {
    if (this.deps.items === undefined) return this.error('items.comment', 'Items are unavailable.')
    if (this.deps.taskStore.findById(taskId) === null) {
      return this.error('items.comment', 'That item could not be found.')
    }
    const comment = this.deps.items.comment({
      taskId,
      body: text,
      authorKind: 'bot',
      authorBotId: this.deps.botId ?? null,
      authorName: this.deps.botName ?? null
    })
    return {
      op: 'items.comment',
      ok: true,
      message: 'Comment added.',
      value: comment
    }
  }

  private itemsAsk(
    taskId: string,
    text: string,
    options: readonly string[] | undefined
  ): AssistantActionResult {
    if (this.deps.items === undefined) return this.error('items.ask', 'Items are unavailable.')
    if (this.deps.taskStore.findById(taskId) === null) {
      return this.error('items.ask', 'That item could not be found.')
    }
    const question = this.deps.items.ask({
      taskId,
      body: text,
      ...(options === undefined ? {} : { options }),
      authorKind: 'bot',
      authorBotId: this.deps.botId ?? null,
      authorName: this.deps.botName ?? null
    })
    return {
      op: 'items.ask',
      ok: true,
      message: 'Question posted.',
      value: question
    }
  }

  private itemsLink(
    taskId: string,
    kind: 'url' | 'file' | 'pr',
    ref: string
  ): AssistantActionResult {
    if (this.deps.items === undefined) return this.error('items.link', 'Items are unavailable.')
    if (this.deps.taskStore.findById(taskId) === null) {
      return this.error('items.link', 'That item could not be found.')
    }
    const link = this.deps.items.linkAdd({ taskId, kind, ref })
    return {
      op: 'items.link',
      ok: true,
      message: 'Link added.',
      value: link
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

  private async memoryAdd(text: string): Promise<AssistantActionResult> {
    const botId = this.deps.botId
    if (this.deps.memoryFiles === undefined || botId === undefined) {
      this.audit('memory.add', false, 'unavailable', { text })
      return {
        op: 'memory.add',
        ok: false,
        message: 'Memory is not available in this context.',
        value: { text }
      }
    }
    if (await this.deps.memoryFiles.tidiedOut(botId, text)) {
      this.audit('memory.add', true, 'kept-out', { text })
      return {
        op: 'memory.add',
        ok: true,
        message:
          'A recent tidy-up moved that fact out of MEMORY.md; it stays in memory/archive.md.',
        value: { text, added: false }
      }
    }
    const fact = await this.deps.memoryFiles.add(botId, text, {
      kind: 'bot',
      botId,
      name: this.displayName()
    })
    if (fact === null) {
      return {
        op: 'memory.add',
        ok: true,
        message: 'I already remember that.',
        value: { text, added: false }
      }
    }
    this.audit('memory.add', true, 'ok', { text })
    return {
      op: 'memory.add',
      ok: true,
      message: `Remembered: ${fact.text}`,
      value: { text: fact.text, added: true }
    }
  }

  private async peersMessage(to: string, text: string): Promise<AssistantActionResult> {
    const fromBotId = this.deps.botId
    if (this.deps.peerMail === undefined || fromBotId === undefined) {
      this.audit('peers.message', false, 'unavailable', { to })
      return {
        op: 'peers.message',
        ok: false,
        message: 'Bot mail is not available in this context.',
        value: { to }
      }
    }
    const latestUser = this.deps.store
      .listMessages(this.deps.threadId, { limit: 5 })
      .find((message) => message.role === 'user')
    if (latestUser?.body.startsWith('[Bot mail') === true) {
      this.audit('peers.message', false, 'mail-turn', { to })
      return {
        op: 'peers.message',
        ok: false,
        message: 'A turn started by bot mail cannot send more bot mail.',
        value: { to }
      }
    }
    if (this.peerMailsSent >= 2) {
      this.audit('peers.message', false, 'capped', { to })
      return {
        op: 'peers.message',
        ok: false,
        message: 'This turn already asked two bots; finish the answer first.',
        value: { to }
      }
    }
    try {
      const mail = this.deps.peerMail.send({ fromBotId, to, body: text })
      this.peerMailsSent += 1
      this.audit('peers.message', true, 'queued', { to })
      return {
        op: 'peers.message',
        ok: true,
        message: `Sent to ${to}; its answer will arrive in this chat.`,
        value: { mailId: mail.id, to: mail.toBotId }
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message === 'PEER_NOT_FOUND'
          ? 'No bot by that name exists.'
          : error instanceof Error && error.message === 'PEER_PAUSED'
            ? 'That bot is paused.'
            : error instanceof Error && error.message === 'PEER_SELF'
              ? 'A bot cannot mail itself.'
              : error instanceof Error && error.message === 'PEER_BODY'
                ? 'That message is empty or too long.'
                : error instanceof Error
                  ? error.message
                  : String(error)
      this.audit('peers.message', false, 'error', { to, message })
      return {
        op: 'peers.message',
        ok: false,
        message,
        value: { to }
      }
    }
  }

  private async memoryForget(fact: string): Promise<AssistantActionResult> {
    const botId = this.deps.botId
    if (this.deps.memoryFiles === undefined || botId === undefined) {
      this.audit('memory.forget', false, 'unavailable', { fact })
      return {
        op: 'memory.forget',
        ok: false,
        message: 'Memory is not available in this context.',
        value: { fact, removed: false }
      }
    }
    const wanted = normalizeMemoryFact(fact)
    const read = await this.deps.memoryFiles.read(botId)
    const found = read.facts.find((entry) => normalizeMemoryFact(entry.text) === wanted)
    if (found === undefined) {
      this.audit('memory.forget', true, 'noop', { fact })
      return {
        op: 'memory.forget',
        ok: true,
        message: `I did not have "${fact}" in memory.`,
        value: { fact, removed: false }
      }
    }
    const removed = await this.deps.memoryFiles.forget(botId, found)
    this.audit('memory.forget', removed, removed ? 'ok' : 'noop', { fact })
    return {
      op: 'memory.forget',
      ok: true,
      message: removed ? `Forgot: ${found.text}` : `I did not have "${fact}" in memory.`,
      value: { fact: found.text, removed }
    }
  }

  private canOperate(task: {
    createdByActor: string | null
    origin: string
    botId?: string | null
  }): boolean {
    return (
      task.createdByActor === this.actor() ||
      (this.deps.botId !== undefined && task.botId === this.deps.botId) ||
      task.createdByActor === MIRA_ACTOR_ID
    )
  }

  private async resolveHarness(
    repoId: RepoId,
    requested?: string,
    settings: AssistantSettings = DEFAULT_ASSISTANT_SETTINGS
  ): Promise<HarnessId | null> {
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
      actor: this.actor() === MIRA_ACTOR_ID ? 'mira' : 'system',
      botId: this.deps.botId ?? null,
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

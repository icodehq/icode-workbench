import type { AssistantMessageRecord } from '../persistence/assistant-store'
import type { RepositoryStore } from '../persistence/repository-store'
import type { TaskStore } from '../tasks/task-store'
import type { TaskRecord } from '../../shared/domain/task'
import { taskCanResume } from '../../shared/domain/task'
import type {
  AssistantSettings,
  AssistantNotificationKind,
  AssistantPriority,
  AssistantCard
} from '../../shared/domain/assistant'
import { mainT } from '../i18n/main-i18n'

export type AssistantNotifierService = {
  postNotification(input: {
    body: string
    card?: AssistantCard | null
    kind: 'notification'
    notificationKind: AssistantNotificationKind
    priority: AssistantPriority
    dedupeKey: string
  }): AssistantMessageRecord | null
  markNotificationDelivered(messageId: string): void
}

export type AssistantNotifierDeps = {
  service: AssistantNotifierService
  taskStore: TaskStore
  repositories: RepositoryStore
  settings: () => AssistantSettings
  now: () => number
  isWindowFocused: () => boolean
  onOsNotify: (input: {
    title: string
    body: string
    messageId: string
  }) => void
}

type Need = {
  fingerprint: string
  priority: AssistantPriority
  kind: AssistantNotificationKind
  body: string
  card: AssistantCard
}

function inQuietHours(now: number, startMinute: number, endMinute: number): boolean {
  const date = new Date(now)
  const minute = date.getHours() * 60 + date.getMinutes()
  return startMinute <= endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute
}

function taskCard(task: TaskRecord, canResume: boolean): AssistantCard {
  return {
    type: 'task',
    taskId: task.id,
    repoId: task.repoId,
    title: task.title,
    status: task.status,
    approval: task.approval,
    canResume
  }
}

/**
 * Turns task/project changes into proactive Mira messages.
 *
 * The first sweep primes fingerprints and posts nothing: upgrading iCode must
 * not replay every existing need as a notification. After that, only new
 * fingerprints become messages, and the database's partial unique index is the
 * final dedupe.
 */
export class AssistantNotifier {
  private readonly fingerprints = new Set<string>()
  private primed = false
  private pendingChange = false
  private timer: NodeJS.Timeout | null = null
  private osSentAt: number[] = []

  constructor(private readonly deps: AssistantNotifierDeps) {}

  async start(): Promise<void> {
    try {
      await this.prime()
    } catch {
      // A failed baseline must not prevent later task changes from notifying.
      this.primed = true
    }
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  onChange(): void {
    if (!this.primed) {
      this.pendingChange = true
      return
    }
    this.schedule()
  }

  /** Test seam: run one sweep without waiting for the debounce. */
  async sweepNow(): Promise<void> {
    await this.sweep()
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.sweep()
    }, 750)
    this.timer.unref?.()
  }

  private async prime(): Promise<void> {
    const needs = await this.compute()
    for (const need of needs) this.fingerprints.add(need.fingerprint)
    this.primed = true
    if (this.pendingChange) {
      this.pendingChange = false
      this.schedule()
    }
  }

  private async compute(): Promise<Need[]> {
    const tasks = this.deps.taskStore.list({ limit: 200 })
    const repositories = this.deps.repositories.list()
    const needs: Need[] = []
    for (const task of tasks) {
      // Eligibility first: ineligible tasks must not pay for a successor query.
      const canResume =
        taskCanResume(task, false) && this.deps.taskStore.findSuccessor(task.id) === null
      const card = taskCard(task, canResume)
      if (task.approval === 'pending' && task.status === 'queued' && task.createdByActor !== 'mira') {
        needs.push({
          fingerprint: `task:${task.id}:approval:${String(task.createdAt)}`,
          priority: 'high',
          kind: 'approval-needed',
          body: mainT('notifications.taskApproval', { title: task.title }),
          card
        })
      }
      if (task.status === 'waiting') {
        needs.push({
          fingerprint: `task:${task.id}:waiting:${String(task.updatedAt)}`,
          priority: 'high',
          kind: 'task-waiting',
          body: mainT('notifications.taskWaiting', { title: task.title }),
          card
        })
      }
      if (task.status === 'failed') {
        needs.push({
          fingerprint: `task:${task.id}:failed:${String(task.finishedAt ?? task.updatedAt)}:${String(task.attempt)}`,
          priority: 'high',
          kind: 'task-failed',
          body:
            task.attempt > 1
              ? mainT('notifications.taskFailedAttempt', {
                  title: task.title,
                  attempt: task.attempt
                })
              : mainT('notifications.taskFailed', { title: task.title }),
          card
        })
      }
      if (task.status === 'completed' && task.reviewDecision === 'pending') {
        needs.push({
          fingerprint: `task:${task.id}:review:${String(task.finishedAt ?? task.updatedAt)}`,
          priority: 'normal',
          kind: 'review-ready',
          body: mainT('notifications.reviewReady', { title: task.title }),
          card
        })
      }
      if (
        task.status === 'completed' &&
        task.reviewDecision !== 'pending' &&
        (task.createdByActor === 'mira' || task.origin === 'supervisor')
      ) {
        needs.push({
          fingerprint: `task:${task.id}:completed:${String(task.finishedAt ?? task.updatedAt)}`,
          priority: 'low',
          kind: 'task-completed',
          body: mainT('notifications.taskCompleted', { title: task.title }),
          card
        })
      }
    }
    for (const repo of repositories) {
      if (repo.preparation?.state === 'failed') {
        needs.push({
          fingerprint: `repo:${repo.id}:setup:${String(repo.preparation.finishedAt ?? repo.preparation.startedAt)}`,
          priority: 'high',
          kind: 'custom',
          body: mainT('notifications.firstCommitFailed', { title: repo.displayName }),
          card: {
            type: 'notification',
            kind: 'custom',
            text: mainT('notifications.firstCommitFailed', { title: repo.displayName })
          }
        })
      }
    }
    return needs
  }

  private async sweep(): Promise<void> {
    const needs = await this.compute().catch(() => [] as Need[])
    if (!this.deps.settings().notifications.enabled) {
      for (const need of needs) this.fingerprints.add(need.fingerprint)
      return
    }
    for (const need of needs) {
      if (this.fingerprints.has(need.fingerprint)) continue
      this.fingerprints.add(need.fingerprint)
      const message = this.deps.service.postNotification({
        body: need.body,
        card: need.card,
        kind: 'notification',
        notificationKind: need.kind,
        priority: need.priority,
        dedupeKey: need.fingerprint
      })
      if (!message) continue
      this.deliverOs(need, message)
    }
  }

  private deliverOs(need: Need, message: AssistantMessageRecord): void {
    const settings = this.deps.settings()
    if (!settings.notifications.enabled) return
    if (need.priority === 'low') return
    if (settings.notifications.quietMode === 'in-app') return
    const now = this.deps.now()
    if (
      settings.notifications.quietMode === 'respect-hours' &&
      need.priority !== 'high' &&
      inQuietHours(
        now,
        settings.notifications.quietHours.startMinute,
        settings.notifications.quietHours.endMinute
      )
    ) {
      return
    }
    if (this.deps.isWindowFocused()) return
    this.osSentAt = this.osSentAt.filter((timestamp) => now - timestamp < 60 * 60 * 1000)
    if (this.osSentAt.length >= settings.notifications.budgetPerHour) return
    this.osSentAt.push(now)
    this.deps.service.markNotificationDelivered(message.id)
    try {
      this.deps.onOsNotify({
        title: settings.personaName,
        body: need.body,
        messageId: message.id
      })
    } catch {
      // The in-app message and rail badge are still the durable notification.
    }
  }
}

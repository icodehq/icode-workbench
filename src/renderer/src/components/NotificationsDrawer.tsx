import { useEffect } from 'react'
import { Bell, Check, Loader2, X } from 'lucide-react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { SessionSummary } from '../../../shared/schemas/ipc'
import type { OpenBotsTab } from '../state/use-bots'
import {
  activityDotClass,
  activityLabel,
  activityTone
} from './status'
import { taskAttention } from './task-status'
import { translate } from '../i18n/i18n-store'
import { useT, useTp } from '../i18n/use-i18n'

export type ActivityEntry = {
  session: SessionSummary
  repoName: string
}

export type NeedsYouEntry = {
  task: TaskRecordPayload
  repoName: string
}

/** One unread bot home or group room in the notification centre. */
export type BotsNotificationEntry = {
  key: string
  kind: 'group' | 'bot'
  tab: OpenBotsTab
  label: string
  unread: number
  needs: number
}

type Props = {
  open: boolean
  needsTasks: NeedsYouEntry[]
  bots: BotsNotificationEntry[]
  activity: ActivityEntry[]
  markingRead: boolean
  onClose: () => void
  onOpenTask: (task: TaskRecordPayload) => void
  onOpenSession: (sessionId: string) => void
  onOpenBots: (tab: OpenBotsTab) => void
  onMarkRead: () => void
}

function attentionDot(task: TaskRecordPayload): string {
  const attention = taskAttention(task)
  if (attention === 'Approval') return 'bg-signal'
  if (attention === 'Answer') return 'bg-signal animate-pulse'
  if (attention === 'Retry') return 'bg-destructive'
  if (attention === 'Review') return 'bg-add'
  if (attention === 'Blocked') return 'bg-signal'
  return 'bg-muted-foreground'
}

function attentionText(task: TaskRecordPayload): string {
  if (taskAttention(task) === 'Blocked') return translate('notifications.blocked')
  if (task.approval === 'pending' && task.status === 'queued') {
    return task.createdByActor === 'mira'
      ? translate('notifications.proposedByAssistant')
      : translate('notifications.proposedBySupervisor')
  }
  if (task.status === 'waiting') return translate('notifications.waitingInput')
  if (task.status === 'failed') return translate('notifications.failed')
  if (task.status === 'completed' && task.reviewDecision === 'pending') {
    return translate('notifications.attentionReviewReady')
  }
  return translate(`task.status.${task.status}`)
}


/**
 * The bell's drawer: what needs the user, plus the recent activity the window
 * observed. Activity is per-session and advisory; it never changes lifecycle
 * state, and marking it read only clears the unread flag.
 */
export default function NotificationsDrawer({
  open,
  needsTasks,
  bots,
  activity,
  markingRead,
  onClose,
  onOpenTask,
  onOpenSession,
  onOpenBots,
  onMarkRead
}: Props): React.JSX.Element | null {
  const t = useT()
  const tp = useTp()
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null

  const unread = activity.filter((entry) => entry.session.activity?.unread === true).length

  return (
    <div
      className="fixed inset-0 z-[65] bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label={t('notifications.title')}
      data-testid="notifications-drawer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <aside className="icode-drawer absolute bottom-3 right-3 top-3 flex w-[min(420px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-[var(--icode-shadow-overlay)]">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
            <Bell size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{t('notifications.title')}</h2>
            <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
              {t('notifications.subtitle')}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('notifications.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {bots.length > 0 ? (
            <section className="mb-2" data-testid="notifications-bots">
              <h3 className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                {t('bots.label')} · {bots.length}
              </h3>
              <ul className="space-y-0.5">
                {bots.map((entry) => (
                  <li key={entry.key}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                      onClick={() => {
                        onClose()
                        onOpenBots(entry.tab)
                      }}
                      data-testid={`notification-bots-${entry.key}`}
                    >
                      <span
                        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                          entry.needs > 0 ? 'bg-signal' : 'bg-info'
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] font-medium text-foreground">
                          {entry.label}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {entry.kind === 'group' ? t('bots.groups') : t('bots.bots')}
                          {entry.needs > 0
                            ? ` · ${t('notifications.needsYou', { count: entry.needs })}`
                            : ''}
                        </span>
                      </span>
                      {entry.needs > 0 ? (
                        <span className="shrink-0 rounded bg-signal-weak px-1 text-[9px] font-medium text-signal">
                          {entry.needs}
                        </span>
                      ) : null}
                      {entry.unread > 0 ? (
                        <span className="shrink-0 rounded-full bg-signal-weak px-1 text-[9px] font-medium text-signal">
                          {entry.unread > 9 ? '9+' : entry.unread}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="mb-2" data-testid="notifications-needs">
            <h3 className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              {t('notifications.needsYou', { count: needsTasks.length })}
            </h3>
            {needsTasks.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-muted-foreground">
                {t('notifications.nothingNeedsAttention')}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {needsTasks.map(({ task, repoName }) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                      onClick={() => {
                        onClose()
                        onOpenTask(task)
                      }}
                      data-testid={`notification-task-${task.id}`}
                    >
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${attentionDot(task)}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] font-medium text-foreground">
                          {task.title}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {repoName} · {attentionText(task)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="notifications-activity">
            <h3 className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
              {t('notifications.activity')}
            </h3>
            {activity.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-muted-foreground">
                {t('notifications.noActivity')}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {activity.map(({ session, repoName }) => {
                  const entry = session.activity
                  if (entry === null) return null
                  return (
                    <li key={session.id}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                        onClick={() => {
                          onClose()
                          onOpenSession(session.id)
                        }}
                        data-testid={`notification-activity-${session.id}`}
                      >
                        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${activityDotClass(entry)}`} />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground">
                              {session.title}
                            </span>
                            {entry.unread ? (
                              <span className="shrink-0 rounded-full bg-accent/15 px-1.5 text-[8px] text-accent">
                                {t('notifications.unread')}
                              </span>
                            ) : null}
                          </span>
                          <span className={`mt-0.5 block truncate text-[10px] ${activityTone(entry)}`}>
                            {repoName} · {activityLabel(entry)}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[10.5px] hover:bg-muted disabled:opacity-40"
            onClick={onMarkRead}
            disabled={unread === 0 || markingRead}
            data-testid="notifications-mark-read"
          >
            {markingRead ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Check size={11} />
            )}
            {t('notifications.markRead')}
          </button>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {unread === 0 ? t('notifications.allCaughtUp') : tp('notifications.unreadSessions', unread)}
          </span>
        </div>
      </aside>
    </div>
  )
}

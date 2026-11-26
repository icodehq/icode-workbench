import { useEffect, useMemo, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import type { ItemPayload } from '../../../../shared/schemas/items'
import type { ItemStatus } from '../../../../shared/domain/item'
import type { GroupSummaryPayload } from '../../../../shared/schemas/groups'
import type { MessageKey } from '../../../../shared/i18n'
import type { Notice } from '../../state/workspace'
import { useItems } from '../../state/use-items'
import { usePermissions } from '../../state/use-permissions'
import { useT } from '../../i18n/use-i18n'
import type { AssistantTaskAction } from '../AssistantCardView'

const STATUS_LABEL: Record<ItemStatus, MessageKey> = {
  needs_you: 'item.status.needs_you',
  working: 'item.status.working',
  waiting: 'item.status.waiting',
  planned: 'item.status.planned',
  done: 'item.status.done',
  canceled: 'item.status.canceled'
}

const SHOW_LIMIT = 3

/** The last few non-empty lines of a terminal snapshot, with control sequences removed. */
function lastOutputLines(snapshot: string, limit = 20): string {
  const plain = snapshot
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r/gu, '')
  const lines = plain.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0)
  return lines.slice(-limit).join('\n').slice(-1_200)
}

/**
 * The room's action surface for work that is blocked on a person.
 *
 * A worker session that asks for permission cannot be answered from the chat
 * itself yet, so the dock keeps the two actions that matter close: open the
 * exact waiting session, or open the item and answer there.
 */
export default function GroupNeedsDock({
  group,
  notify,
  onOpenTask,
  onOpenSession,
  onTaskAction
}: {
  group: GroupSummaryPayload
  notify: (notice: Notice) => void
  onOpenTask: (taskId: string) => void
  onOpenSession: (sessionId: string) => void
  onTaskAction: (action: AssistantTaskAction, taskId: string) => void
}): React.JSX.Element | null {
  const t = useT()
  const state = useItems({ groupId: group.id }, notify)
  const permissionState = usePermissions(group.id, notify)
  const needs = useMemo(
    () =>
      state.items.filter(
        (item) => item.status === 'needs_you' || item.task.status === 'waiting'
      ),
    [state.items]
  )
  const waitingSessionId =
    needs.find((item) => item.task.status === 'waiting' && item.task.sessionId !== null)?.task
      .sessionId ?? null
  const [preview, setPreview] = useState<{
    sessionId: string
    incarnationId: string
    text: string
  } | null>(null)
  const [previewNonce, setPreviewNonce] = useState(0)
  const [reply, setReply] = useState('')
  const [sendingReply, setSendingReply] = useState(false)
  useEffect(() => {
    if (waitingSessionId === null) {
      setPreview(null)
      return
    }
    let cancelled = false
    const load = (): void => {
      void window.icode.terminal
        .preview({ sessionId: waitingSessionId })
        .then((result) => {
          if (cancelled || !result.ok) return
          setPreview({
            sessionId: waitingSessionId,
            incarnationId: result.value.incarnationId,
            text: lastOutputLines(result.value.snapshot)
          })
        })
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [waitingSessionId, previewNonce])
  if (state.loading || (needs.length === 0 && permissionState.permissions.length === 0)) {
    return null
  }
  const sendReply = async (): Promise<void> => {
    const value = reply.trim()
    if (preview === null || value.length === 0 || sendingReply) return
    setSendingReply(true)
    const result = await window.icode.terminal.write({
      sessionId: preview.sessionId,
      incarnationId: preview.incarnationId,
      data: `${value}\r`
    })
    setSendingReply(false)
    if (!result.ok) {
      notify({ tone: 'error', message: result.error.message })
      return
    }
    setReply('')
    window.setTimeout(() => setPreviewNonce((current) => current + 1), 400)
  }
  const answer = (item: ItemPayload, option: string): void => {
    if (item.openQuestion === null) return
    void state.answer(item.task.id, item.openQuestion.id, option)
  }
  return (
    <div
      className="shrink-0 border-t border-border bg-card/70 px-3 py-2"
      data-testid="group-needs-dock"
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-signal">
        <AlertCircle size={10} />
        {t('activity.needsYou')} · {needs.length + permissionState.permissions.length}
      </div>
      {permissionState.permissions.length > 0 ? (
        <div className="mt-1 space-y-1.5" data-testid="group-permissions">
          {permissionState.permissions.map((permission) => (
            <div
              key={permission.id}
              className="rounded-md border border-signal/50 bg-signal-weak/30 px-2 py-1.5"
              data-testid={`group-permission-${permission.id}`}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground">
                  {t('items.permission.title')}
                  {permission.toolName !== null ? ` · ${permission.toolName}` : ''}
                </span>
              </div>
              {permission.input !== null && permission.input.length > 0 ? (
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-1.5 font-mono text-[9px] leading-snug text-muted-foreground">
                  {permission.input}
                </pre>
              ) : null}
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  className="inline-flex h-6 items-center rounded bg-accent px-2 text-[10px] font-medium text-accent-ink hover:opacity-90"
                  onClick={() =>
                    void permissionState.respond(permission.id, { behavior: 'allow' })
                  }
                  data-testid={`group-permission-allow-${permission.id}`}
                >
                  {t('items.permission.allow')}
                </button>
                <button
                  type="button"
                  className="inline-flex h-6 items-center rounded border border-destructive/40 px-2 text-[10px] text-destructive hover:bg-destructive/5"
                  onClick={() =>
                    void permissionState.respond(permission.id, {
                      behavior: 'deny',
                      message: t('items.permission.denied')
                    })
                  }
                  data-testid={`group-permission-deny-${permission.id}`}
                >
                  {t('items.permission.deny')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-1 space-y-1.5">
        {needs.slice(0, SHOW_LIMIT).map((item) => (
          <div
            key={item.task.id}
            className="rounded-md border border-signal/30 bg-signal-weak/20 px-2 py-1.5"
            data-testid={`group-need-${item.task.id}`}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground">
                {item.task.title}
              </span>
              <span className="shrink-0 text-[9px] text-muted-foreground">
                {t(STATUS_LABEL[item.status])}
              </span>
            </div>
            {item.openQuestion !== null ? (
              <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
                {item.openQuestion.body}
              </p>
            ) : null}
            {preview !== null &&
            item.task.sessionId === preview.sessionId &&
            preview.text.length > 0 ? (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-1.5 font-mono text-[9px] leading-snug text-muted-foreground">
                {preview.text}
              </pre>
            ) : null}
            {preview !== null && item.task.sessionId === preview.sessionId ? (
              <div className="mt-1 flex items-center gap-1">
                <input
                  className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-[10px] text-foreground outline-none focus:border-line-strong"
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void sendReply()
                    }
                  }}
                  placeholder={t('items.sessionReplyPlaceholder')}
                  data-testid={`group-need-reply-${item.task.id}`}
                />
                <button
                  type="button"
                  className="inline-flex h-6 items-center rounded border border-border bg-card px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  onClick={() => void sendReply()}
                  disabled={sendingReply || reply.trim().length === 0}
                  data-testid={`group-need-reply-send-${item.task.id}`}
                >
                  {t('bots.composer.send')}
                </button>
              </div>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {item.openQuestion?.options?.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="inline-flex h-6 items-center rounded border border-signal/40 bg-card px-1.5 text-[10px] text-foreground hover:bg-muted"
                  onClick={() => answer(item, option)}
                  data-testid={`group-need-answer-${option}`}
                >
                  {option}
                </button>
              ))}
              {item.task.sessionId !== null ? (
                <button
                  type="button"
                  className="inline-flex h-6 items-center rounded border border-border bg-card px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onOpenSession(item.task.sessionId!)}
                  data-testid={`group-need-session-${item.task.id}`}
                >
                  {t('items.openSession')}
                </button>
              ) : null}
              <button
                type="button"
                className="inline-flex h-6 items-center rounded border border-border bg-card px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onOpenTask(item.task.id)}
                data-testid={`group-need-item-${item.task.id}`}
              >
                {t('items.openTask')}
              </button>
              {item.task.approval === 'pending' && item.task.status === 'queued' ? (
                <>
                  <button
                    type="button"
                    className="inline-flex h-6 items-center rounded border border-border bg-card px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => onTaskAction('approve', item.task.id)}
                  >
                    {t('taskOverview.approve')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-6 items-center rounded border border-border bg-card px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => onTaskAction('reject', item.task.id)}
                  >
                    {t('taskOverview.reject')}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ))}
        {needs.length > SHOW_LIMIT ? (
          <p className="px-0.5 text-[9.5px] text-muted-foreground">
            {t('items.moreInRail', { count: needs.length - SHOW_LIMIT })}
          </p>
        ) : null}
      </div>
    </div>
  )
}

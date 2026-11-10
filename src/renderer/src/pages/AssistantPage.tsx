import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, Plus, Settings2, Square } from 'lucide-react'
import type { AssistantRunStage } from '../../../shared/domain/assistant'
import type { AssistantTarget } from '../router/routes'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { AssistantCardPayload } from '../../../shared/schemas/assistant'
import type { AssistantState } from '../state/use-assistant'
import {
  conversationLabel,
  visibleMessages
} from '../state/assistant-transcript'
import AssistantAvatar from '../components/AssistantAvatar'
import AssistantCardView, { type AssistantTaskAction } from '../components/AssistantCardView'
import Markdown from '../components/Markdown'
import { useT } from '../i18n/use-i18n'
import { getLocale } from '../i18n/i18n-store'
import { formatDateTime } from '../../../shared/i18n'

const STATUS_KEY: Record<
  AssistantState['status'],
  'assistant.status.working' | 'assistant.status.ready' | 'assistant.status.noHarness' | 'assistant.status.needsAttention'
> = {
  working: 'assistant.status.working',
  idle: 'assistant.status.ready',
  offline: 'assistant.status.noHarness',
  error: 'assistant.status.needsAttention'
}

const STAGE_KEY: Record<
  AssistantRunStage,
  | 'assistant.stage.selecting'
  | 'assistant.stage.calling'
  | 'assistant.stage.thinking'
  | 'assistant.stage.reading'
  | 'assistant.stage.acting'
  | 'assistant.stage.done'
> = {
  selecting: 'assistant.stage.selecting',
  calling: 'assistant.stage.calling',
  thinking: 'assistant.stage.thinking',
  reading: 'assistant.stage.reading',
  acting: 'assistant.stage.acting',
  done: 'assistant.stage.done'
}

function useElapsedSeconds(startedAt: number | null): number {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (startedAt === null) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
}

const SUGGESTION_KEYS = [
  'assistant.suggestion.needs',
  'assistant.suggestion.catchUp',
  'assistant.suggestion.plan'
] as const

function formatTime(value: number): string {
  return formatDateTime(getLocale(), value, { hour: '2-digit', minute: '2-digit' })
}

function liveTaskCard(
  card: AssistantCardPayload,
  tasks: TaskRecordPayload[]
): AssistantCardPayload {
  if (card.type !== 'task') return card
  const live = tasks.find((task) => task.id === card.taskId)
  return live
    ? {
        ...card,
        title: live.title,
        status: live.status,
        approval: live.approval ?? card.approval,
        canResume: live.canResume
      }
    : card
}

export default function AssistantPage({
  assistant,
  request,
  repos,
  tasks,
  onOpenTask,
  onTaskAction,
  onOpenSettings
}: {
  assistant: AssistantState
  request: (AssistantTarget & { nonce: number }) | null
  repos: RepositorySummary[]
  tasks: TaskRecordPayload[]
  onOpenTask?: (taskId: string) => void
  onTaskAction?: (action: AssistantTaskAction, taskId: string) => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState('')
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const stickBottom = useRef(true)
  const pendingAnchor = useRef<{ height: number; top: number } | null>(null)

  const selectedConversation =
    assistant.conversations.find(
      (conversation) => conversation.id === assistant.selectedConversationId
    ) ?? null
  const latestConversation =
    assistant.conversations.find(
      (conversation) => conversation.id === assistant.latestConversationId
    ) ?? null
  const followingLatest =
    assistant.selectedConversationId === assistant.latestConversationId
  const visible = visibleMessages(assistant.messages, focusedId)
  const earlierConversations = assistant.conversations
    .filter((conversation) => conversation.id !== assistant.latestConversationId)
    .reverse()

  const repoName = (repoId: string | undefined): string | undefined =>
    repoId === undefined ? undefined : repos.find((repo) => repo.id === repoId)?.displayName

  useEffect(() => {
    stickBottom.current = true
    setFocusedId(null)
  }, [assistant.selectedConversationId])

  useLayoutEffect(() => {
    const thread = threadRef.current
    if (!thread) return
    const anchor = pendingAnchor.current
    if (anchor !== null) {
      pendingAnchor.current = null
      thread.scrollTop = thread.scrollHeight - anchor.height + anchor.top
      return
    }
    if (stickBottom.current) thread.scrollTop = thread.scrollHeight
  }, [assistant.messages, assistant.loadingOlder, assistant.selectedConversationId])

  useEffect(() => {
    if (!request?.messageId) return
    const message = assistant.messages.find((entry) => entry.id === request.messageId)
    if (!message) return
    stickBottom.current = false
    setFocusedId(message.id)
    const element = document.getElementById(`assistant-message-${message.id}`)
    element?.scrollIntoView({ block: 'center' })
    void assistant.markRead(message.id)
  }, [assistant.markRead, assistant.messages, request])

  useEffect(() => {
    if (!followingLatest || assistant.messages.length === 0) return
    if (document.hasFocus()) void assistant.markRead()
  }, [assistant.markRead, assistant.messages.length, followingLatest])

  const onScroll = (): void => {
    const thread = threadRef.current
    if (!thread) return
    stickBottom.current =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48
  }

  const loadOlder = async (): Promise<void> => {
    const thread = threadRef.current
    pendingAnchor.current = thread
      ? { height: thread.scrollHeight, top: thread.scrollTop }
      : null
    const applied = await assistant.loadOlder()
    if (!applied) pendingAnchor.current = null
  }

  const selectConversation = (conversationId: string): void => {
    setFocusedId(null)
    void assistant.selectConversation(conversationId)
  }

  const send = async (text: string): Promise<void> => {
    const value = text.trim()
    if (value.length === 0 || assistant.status === 'working') return
    setDraft('')
    setFocusedId(null)
    stickBottom.current = true
    const ok = await assistant.send(value, request?.repoId)
    if (!ok) setDraft(value)
    inputRef.current?.focus()
  }

  const working = assistant.status === 'working'
  const live = assistant.live
  const elapsed = useElapsedSeconds(live?.startedAt ?? null)
  const hasUserMessage = visible.some((message) => message.role === 'user')
  const contextRepo = request?.repoId
    ? repos.find((repo) => repo.id === request.repoId) ?? null
    : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="assistant-view">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-5 py-3">
        <AssistantAvatar name={assistant.personaName} status={assistant.status} size="lg" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
              {assistant.personaName}
            </h1>
            <span className="text-[10.5px] text-muted-foreground">{t(STATUS_KEY[assistant.status])}</span>
          </div>
          <p className="truncate text-[10.5px] text-muted-foreground">
            {assistant.harness ? `${assistant.harness} · ` : ''}
            {assistant.target ?? t('assistant.targetAll')}
          </p>
        </div>
        {assistant.conversations.length > 0 ? (
          <select
            className="ml-auto max-w-[240px] truncate rounded-md border border-border bg-background px-2 py-1 text-[10.5px] text-muted-foreground outline-none focus:border-line-strong"
            value={assistant.selectedConversationId ?? ''}
            onChange={(event) => selectConversation(event.target.value)}
            aria-label="Mira conversation"
            data-testid="assistant-conversation-select"
          >
            {latestConversation ? (
              <option value={latestConversation.id}>
                {conversationLabel(latestConversation, true)}
              </option>
            ) : null}
            {earlierConversations.length > 0 ? (
              <optgroup label="Earlier conversations">
                {earlierConversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversationLabel(conversation, false)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        ) : (
          <span className="ml-auto rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
            {contextRepo?.displayName ?? t('assistant.allProjects')}
          </span>
        )}
        {assistant.conversations.length > 0 ? (
          <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
            {contextRepo?.displayName ?? t('assistant.allProjects')}
          </span>
        ) : null}
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => void assistant.newConversation()}
          disabled={working}
          title="New conversation"
          aria-label="New conversation"
          data-testid="assistant-new-conversation"
        >
          <Plus size={12} />
        </button>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onOpenSettings}
          title={t('assistant.settings')}
          aria-label={t('assistant.settings')}
          data-testid="assistant-settings"
        >
          <Settings2 size={12} />
        </button>
      </header>

      {!followingLatest && selectedConversation ? (
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/30 px-5 py-1.5 text-[10.5px] text-muted-foreground">
          <span>Viewing an earlier conversation</span>
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 hover:bg-muted hover:text-foreground"
            onClick={() => {
              if (latestConversation) selectConversation(latestConversation.id)
            }}
            data-testid="assistant-back-to-current"
          >
            Back to current
          </button>
        </div>
      ) : null}

      <div
        ref={threadRef}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        onScroll={onScroll}
        data-testid="assistant-thread"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {assistant.hasMore ? (
            <button
              type="button"
              className="mx-auto rounded-full border border-border bg-card px-3 py-1 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void loadOlder()}
              disabled={assistant.loadingOlder}
              data-testid="assistant-load-older"
            >
              {assistant.loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          ) : null}

          {visible.map((message) => {
            const user = message.role === 'user'
            const system = message.role === 'system' || message.kind === 'error'
            const boundary = message.role === 'system' && message.kind === 'status'
            return (
              <div
                key={message.id}
                id={`assistant-message-${message.id}`}
                data-testid={`assistant-message-${message.id}`}
                data-focused={focusedId === message.id ? 'true' : undefined}
                className={`flex gap-2.5 ${user ? 'flex-row-reverse' : ''} ${
                  boundary ? 'justify-center' : ''
                } ${
                  focusedId === message.id ? 'rounded-md bg-signal-weak/60 p-2' : ''
                }`}
              >
                {!user && !boundary ? (
                  <AssistantAvatar
                    name={assistant.personaName}
                    status={assistant.status}
                    size="sm"
                  />
                ) : null}
                <div
                  className={`flex min-w-0 max-w-[86%] flex-col gap-1.5 ${
                    boundary ? 'items-center' : user ? 'items-end' : 'w-full'
                  }`}
                >
                  <div
                    className={`break-words rounded-lg px-3 py-2 text-[12px] leading-relaxed ${
                      user || system ? 'whitespace-pre-wrap' : ''
                    } ${
                      user
                        ? 'bg-accent/12 text-foreground'
                        : boundary
                          ? 'border border-dashed border-border bg-muted/30 text-center text-[11px] text-muted-foreground'
                          : system
                            ? 'border border-destructive/25 bg-destructive/5 text-destructive'
                            : 'border border-border bg-card text-foreground'
                    }`}
                  >
                    {user || system ? message.body : <Markdown text={message.body} />}
                  </div>
                  {message.card ? (
                    <AssistantCardView
                      card={liveTaskCard(message.card, tasks)}
                      repoName={repoName('repoId' in message.card ? message.card.repoId : undefined)}
                      onOpenTask={onOpenTask}
                      onTaskAction={onTaskAction}
                    />
                  ) : null}
                  <span className="text-[9.5px] text-muted-foreground">{formatTime(message.createdAt)}</span>
                </div>
              </div>
            )
          })}

          {followingLatest && live && live.draft.length > 0 ? (
            <div className="flex gap-2.5" data-testid="assistant-live-draft">
              <AssistantAvatar
                name={assistant.personaName}
                status={assistant.status}
                size="sm"
              />
              <div className="flex w-full min-w-0 max-w-[86%] flex-col gap-1.5">
                <div className="break-words rounded-lg border border-border bg-card px-3 py-2 text-[12px] leading-relaxed text-foreground">
                  <Markdown text={live.draft} streaming />
                  <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-accent align-middle" />
                </div>
              </div>
            </div>
          ) : followingLatest && working ? (
            <div className="flex gap-2.5" data-testid="assistant-live-thinking">
              <AssistantAvatar
                name={assistant.personaName}
                status={assistant.status}
                size="sm"
              />
              <div className="rounded-lg border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
                <span className="animate-pulse">…</span>
              </div>
            </div>
          ) : null}

          {followingLatest && working ? (
            <div className="flex items-center gap-2 pl-8 text-[11px] text-muted-foreground">
              <Loader2 size={11} className="animate-spin" />
              <span data-testid="assistant-working">
                {t('assistant.runningStage', {
                  stage: t(STAGE_KEY[live?.stage ?? 'selecting'])
                })}
              </span>
              {elapsed > 0 ? <span>{t('duration.seconds', { seconds: elapsed })}</span> : null}
              {live?.thinkingTokens ? (
                <span>{t('assistant.thinkingTokens', { count: live.thinkingTokens })}</span>
              ) : null}
              {live?.target ? <span>· {live.target}</span> : null}
              <button
                type="button"
                className="ml-1 inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] hover:bg-muted"
                onClick={() => void assistant.stop()}
                data-testid="assistant-stop"
              >
                <Square size={8} />
                {t('assistant.stop')}
              </button>
            </div>
          ) : null}

          {followingLatest && !hasUserMessage && !working ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SUGGESTION_KEYS.map((suggestionKey) => (
                <button
                  key={suggestionKey}
                  type="button"
                  className="rounded-full border border-border bg-card px-2.5 py-1 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => void send(t(suggestionKey))}
                >
                  {t(suggestionKey)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-card px-5 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <textarea
            ref={inputRef}
            className="min-h-[38px] max-h-32 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-line-strong"
            placeholder={
              working
                ? t('assistant.workingPlaceholder')
                : followingLatest
                  ? t('assistant.placeholder')
                  : 'Viewing an earlier conversation — sending returns to the current one'
            }
            rows={1}
            value={draft}
            disabled={working}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send(draft)
              }
            }}
            data-testid="assistant-composer"
          />
          <button
            type="button"
            className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-md bg-accent text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={working || draft.trim().length === 0}
            onClick={() => void send(draft)}
            aria-label={t('assistant.send')}
            data-testid="assistant-send"
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

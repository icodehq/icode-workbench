import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, Settings2, Square } from 'lucide-react'
import type { AssistantRunStage } from '../../../shared/domain/assistant'
import { ASSISTANT_LIMITS } from '../../../shared/domain/assistant'
import { MODEL_HARNESSES } from '../../../shared/domain/harness'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { AssistantCardPayload } from '../../../shared/schemas/assistant'
import type { BotSummaryPayload } from '../../../shared/schemas/bots'
import type { AssistantState } from '../state/use-assistant'
import {
  conversationLabel,
  visibleMessages
} from '../state/assistant-transcript'
import AssistantAvatar from '../components/AssistantAvatar'
import AssistantCardView, { type AssistantTaskAction } from '../components/AssistantCardView'
import Markdown from '../components/Markdown'
import { useT } from '../i18n/use-i18n'
import ChatComposer from '../components/composer/ChatComposer'
import {
  filesToAttachments,
  messageWithAttachments,
  usePersistentDraft,
  type ComposerAttachment
} from '../lib/composer-input'
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
  repos,
  tasks,
  mentionBots = [],
  role,
  suggestions = true,
  showHeader = true,
  color,
  image,
  mascot,
  outfit,
  draftScope,
  onOpenTask,
  onTaskAction,
  onOpenSettings
}: {
  assistant: AssistantState
  repos: RepositorySummary[]
  tasks: TaskRecordPayload[]
  /** Other bots this chat can name with @. */
  mentionBots?: BotSummaryPayload[]
  /** A bot's job/role, shown under its name. */
  role?: string
  /** Broader starters fit a generalist; a specialist's chat starts blank. */
  suggestions?: boolean
  /** Bot home supplies its own header and uses this page for the transcript. */
  showHeader?: boolean
  /** The bot's avatar color, when its identity has one. */
  color?: string
  /** The bot's uploaded avatar image, when it has one. */
  image?: string | null
  mascot?: string | null
  outfit?: string | null
  /** Stable key for this chat's unsent draft; defaults to its assistant thread. */
  draftScope?: string
  onOpenTask?: (taskId: string) => void
  onTaskAction?: (action: AssistantTaskAction, taskId: string) => void
  onOpenSettings?: () => void
}): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = usePersistentDraft(
    `${draftScope ?? assistant.threadId ?? 'assistant'}:${assistant.selectedConversationId ?? 'latest'}`
  )
  const [queued, setQueued] = useState<string[]>([])
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [caret, setCaret] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const queueBusy = useRef(false)
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

  const mentionMenu = useMemo(() => {
    if (mentionBots.length === 0) return null
    const before = draft.slice(0, caret)
    const match = /(?:^|[\s(])@([^@\n]*)$/u.exec(before)
    if (match === null) return null
    const start = match.index + match[0].lastIndexOf('@')
    const query = (match[1] ?? '').trim().toLocaleLowerCase()
    const items = mentionBots.filter((bot) =>
      bot.name.toLocaleLowerCase().startsWith(query)
    )
    if (items.length === 0) return null
    return { start, items: items.slice(0, 6) }
  }, [caret, draft, mentionBots])

  const insertMention = (name: string): void => {
    if (mentionMenu === null) return
    const next = `${draft.slice(0, mentionMenu.start)}@${name} ${draft.slice(caret)}`
    setDraft(next)
    const position = mentionMenu.start + name.length + 2
    setCaret(position)
    setMentionDismissed(true)
    requestAnimationFrame(() => {
      const field = inputRef.current
      if (field === null) return
      field.focus()
      field.setSelectionRange(position, position)
    })
  }

  const composerKeys = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (mentionMenu === null || mentionDismissed) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setMentionIndex(
        (current) =>
          (current + step + mentionMenu.items.length) % mentionMenu.items.length
      )
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const bot = mentionMenu.items[Math.min(mentionIndex, mentionMenu.items.length - 1)]
      if (bot !== undefined) insertMention(bot.name)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setMentionDismissed(true)
      return true
    }
    return false
  }

  const submit = async (text: string): Promise<void> => {
    const value = text.trim()
    if (value.length === 0 || assistant.status === 'working') return
    setDraft('')
    setFocusedId(null)
    stickBottom.current = true
    const ok = await assistant.send(value)
    if (!ok) setDraft(value)
    inputRef.current?.focus()
  }

  const send = async (text: string): Promise<void> => {
    const value = messageWithAttachments(text, attachments)
    if (value.length === 0) return
    setAttachments([])
    if (assistant.status === 'working') {
      setQueued((current) => [...current, value])
      setDraft('')
      inputRef.current?.focus()
      return
    }
    await submit(value)
  }

  const addFiles = (files: File[]): void => {
    void filesToAttachments(files).then((added) => {
      if (added.length > 0) setAttachments((current) => [...current, ...added])
    })
  }

  useEffect(() => {
    if (assistant.status === 'working') queueBusy.current = false
  }, [assistant.status])

  useEffect(() => {
    if (assistant.status === 'working' || queued.length === 0 || queueBusy.current) return
    const [next, ...rest] = queued
    if (next === undefined) return
    queueBusy.current = true
    setQueued(rest)
    void submit(next)
    // submit reads the current status; queued drains one turn at a time.
  }, [assistant.status, queued])

  const working = assistant.status === 'working'
  const live = assistant.live
  const elapsed = useElapsedSeconds(live?.startedAt ?? null)
  const hasUserMessage = visible.some((message) => message.role === 'user')

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background" data-testid="assistant-view">
      {showHeader ? (
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-5 py-3">
        <AssistantAvatar name={assistant.personaName} status={assistant.status} size="lg" color={color} image={image}
                    mascot={mascot}
                    outfit={outfit} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
              {assistant.personaName}
            </h1>
            <span className="text-[10.5px] text-muted-foreground">{t(STATUS_KEY[assistant.status])}</span>
          </div>
          <p className="truncate text-[10.5px] text-muted-foreground">
            {role ? `${role} · ` : ''}
            {assistant.harness ? `${assistant.harness} · ` : ''}
            {assistant.target ?? t('assistant.targetAll')}
          </p>
        </div>
        {assistant.conversations.length > 0 ? (
          <select
            className="ml-auto max-w-[320px] truncate rounded-md border border-border bg-background px-2 py-1 text-[10.5px] text-muted-foreground outline-none focus:border-line-strong"
            value={assistant.selectedConversationId ?? ''}
            onChange={(event) => selectConversation(event.target.value)}
            aria-label={`${assistant.personaName} conversation`}
            data-testid="assistant-conversation-select"
          >
            {latestConversation ? (
              <option value={latestConversation.id}>
                {conversationLabel(latestConversation, true, getLocale())}
              </option>
            ) : null}
            {earlierConversations.length > 0 ? (
              <optgroup label="Earlier conversations">
                {earlierConversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversationLabel(conversation, false, getLocale())}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        ) : (
          <span className="ml-auto rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
            {t('assistant.allProjects')}
          </span>
        )}
        {assistant.conversations.length > 0 ? (
          <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
            {t('assistant.allProjects')}
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
        {onOpenSettings ? (
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
        ) : null}
      </header>
      ) : null}

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
        <div className="icode-chat-measure mx-auto flex flex-col gap-3">
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
                    color={color}
                    image={image}
                    mascot={mascot}
                    outfit={outfit}
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
                color={color}
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
                color={color}
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

          {suggestions && followingLatest && !hasUserMessage && !working ? (
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

      <ChatComposer
        textareaRef={inputRef}
        value={draft}
        onChange={(value, nextCaret) => {
          setDraft(value)
          setCaret(nextCaret)
          setMentionIndex(0)
          setMentionDismissed(false)
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={composerKeys}
        onSend={() => void send(draft)}
        onStop={() => void assistant.stop()}
        working={working}
        placeholder={
          working
            ? t('assistant.workingPlaceholder', { name: assistant.personaName })
            : followingLatest
              ? t('assistant.placeholder', { name: assistant.personaName })
              : 'Viewing an earlier conversation — sending returns to the current one'
        }
        queued={queued.length}
        queuedLabel={
          queued.length > 0
            ? t('assistant.composer.queued', { count: String(queued.length) })
            : undefined
        }
        attachments={attachments}
        menu={
          mentionMenu !== null && !mentionDismissed ? (
            <div
              className="w-64 overflow-hidden rounded-md border border-border bg-card py-1 shadow-xl"
              data-testid="assistant-mention-menu"
            >
              {mentionMenu.items.map((bot, index) => (
                <button
                  key={bot.id}
                  type="button"
                  className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] ${
                    mentionIndex === index ? 'bg-muted' : 'hover:bg-muted'
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    insertMention(bot.name)
                  }}
                >
                  <AssistantAvatar
                    name={bot.name}
                    status={bot.status}
                    size="sm"
                    color={bot.avatarColor}
                    image={bot.avatarImage}
                    mascot={bot.avatarMascot}
                    outfit={bot.avatarOutfit}
                  />
                  <span className="truncate">{bot.name}</span>
                </button>
              ))}
            </div>
          ) : undefined
        }
        commands={[
          { name: '/new', run: () => void assistant.newConversation() },
          { name: '/stop', run: () => void assistant.stop() },
          ...(onOpenSettings === undefined
            ? []
            : [{ name: '/settings', run: onOpenSettings }])
        ]}
        contextUsage={
          assistant.contextChars === null
            ? null
            : { used: assistant.contextChars, max: ASSISTANT_LIMITS.maxPromptChars }
        }
        onAttachFiles={addFiles}
        onRemoveAttachment={(id) =>
          setAttachments((current) => current.filter((file) => file.id !== id))
        }
        footerRight={
          <select
            className="h-6 max-w-24 shrink-0 rounded border border-border bg-background px-1 text-[9px] text-muted-foreground outline-none hover:text-foreground focus:border-line-strong"
            value={assistant.settings.harnessPriority[0]}
            onChange={(event) => {
              const harness = event.target.value as (typeof MODEL_HARNESSES)[number]
              void assistant.saveSettings({
                ...assistant.settings,
                harnessPriority: [
                  harness,
                  ...assistant.settings.harnessPriority.filter(
                    (entry) => entry !== harness
                  )
                ]
              })
            }}
            title="Agent"
            aria-label="Agent"
            data-testid="assistant-agent"
          >
            {MODEL_HARNESSES.map((harness) => (
              <option key={harness} value={harness}>
                {harness === 'claude'
                  ? 'Claude'
                  : harness === 'codex'
                    ? 'Codex'
                    : 'OpenCode'}
              </option>
            ))}
          </select>
        }
        testIds={{ textarea: 'assistant-composer', send: 'assistant-send' }}
      />
    </div>
  )
}

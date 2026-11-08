import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, Settings2, Square } from 'lucide-react'
import type { AssistantRunStage } from '../../../shared/domain/assistant'
import type { AssistantTarget } from '../router/routes'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { AssistantCardPayload } from '../../../shared/schemas/assistant'
import type { AssistantState } from '../state/use-assistant'
import AssistantAvatar from '../components/AssistantAvatar'
import AssistantCardView, { type AssistantTaskAction } from '../components/AssistantCardView'
import Markdown from '../components/Markdown'

const STATUS_LABEL: Record<AssistantState['status'], string> = {
  working: 'working',
  idle: 'ready',
  offline: 'no harness',
  error: 'needs attention'
}

const STAGE_LABEL: Record<AssistantRunStage, string> = {
  selecting: 'Finding a harness',
  calling: 'Contacting the agent',
  thinking: 'Thinking',
  reading: 'Reading project state',
  acting: 'Taking action',
  done: 'Finishing'
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

const SUGGESTIONS = [
  'What needs me across all projects?',
  'Catch me up on the last day.',
  'Plan the next step for the active project.'
]

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function liveTaskCard(
  card: AssistantCardPayload,
  tasks: TaskRecordPayload[]
): AssistantCardPayload {
  if (card.type !== 'task') return card
  const live = tasks.find((task) => task.id === card.taskId)
  return live
    ? { ...card, title: live.title, status: live.status, approval: live.approval ?? card.approval }
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
  const [draft, setDraft] = useState('')
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const repoName = (repoId: string | undefined): string | undefined =>
    repoId === undefined ? undefined : repos.find((repo) => repo.id === repoId)?.displayName

  useEffect(() => {
    const thread = threadRef.current
    if (!thread) return
    if (request?.messageId) {
      const message = assistant.messages.find((entry) => entry.id === request.messageId)
      if (!message) return
      const element = document.getElementById(`assistant-message-${message.id}`)
      element?.scrollIntoView({ block: 'center' })
      setFocusedId(message.id)
      void assistant.markRead(message.id)
      return
    }
    thread.scrollTop = thread.scrollHeight
    if (document.hasFocus()) void assistant.markRead()
    // The request nonce is the deep-link trigger; messages are needed to find it.
  }, [assistant.markRead, assistant.messages, request])

  useEffect(() => {
    if (assistant.messages.length === 0) return
    const thread = threadRef.current
    if (!thread || focusedId !== null) return
    thread.scrollTop = thread.scrollHeight
  }, [assistant.messages.length, focusedId])

  const send = async (text: string): Promise<void> => {
    const value = text.trim()
    if (value.length === 0 || assistant.status === 'working') return
    setDraft('')
    setFocusedId(null)
    const ok = await assistant.send(value, request?.repoId)
    if (!ok) setDraft(value)
    inputRef.current?.focus()
  }

  const working = assistant.status === 'working'
  const live = assistant.live
  const elapsed = useElapsedSeconds(live?.startedAt ?? null)
  const hasUserMessage = assistant.messages.some((message) => message.role === 'user')
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
            <span className="text-[10.5px] text-muted-foreground">{STATUS_LABEL[assistant.status]}</span>
          </div>
          <p className="truncate text-[10.5px] text-muted-foreground">
            {assistant.harness ? `${assistant.harness} · ` : ''}
            {assistant.target ?? 'all projects'}
          </p>
        </div>
        <span className="ml-auto rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
          {contextRepo?.displayName ?? 'All projects'}
        </span>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onOpenSettings}
          title="Mira settings"
          aria-label="Mira settings"
          data-testid="assistant-settings"
        >
          <Settings2 size={12} />
        </button>
      </header>

      <div
        ref={threadRef}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        data-testid="assistant-thread"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {assistant.messages.map((message) => {
            const user = message.role === 'user'
            const system = message.role === 'system' || message.kind === 'error'
            return (
              <div
                key={message.id}
                id={`assistant-message-${message.id}`}
                data-testid={`assistant-message-${message.id}`}
                data-focused={focusedId === message.id ? 'true' : undefined}
                className={`flex gap-2.5 ${user ? 'flex-row-reverse' : ''} ${
                  focusedId === message.id ? 'rounded-md bg-signal-weak/60 p-2' : ''
                }`}
              >
                {!user ? (
                  <AssistantAvatar
                    name={assistant.personaName}
                    status={assistant.status}
                    size="sm"
                  />
                ) : null}
                <div
                  className={`flex min-w-0 max-w-[86%] flex-col gap-1.5 ${
                    user ? 'items-end' : 'w-full'
                  }`}
                >
                  <div
                    className={`break-words rounded-lg px-3 py-2 text-[12px] leading-relaxed ${
                      user || system ? 'whitespace-pre-wrap' : ''
                    } ${
                      user
                        ? 'bg-accent/12 text-foreground'
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

          {live && live.draft.length > 0 ? (
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
          ) : live && working ? (
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

          {working ? (
            <div className="flex items-center gap-2 pl-8 text-[11px] text-muted-foreground">
              <Loader2 size={11} className="animate-spin" />
              <span data-testid="assistant-working">
                {STAGE_LABEL[live?.stage ?? 'selecting']}…
              </span>
              {elapsed > 0 ? <span>{elapsed}s</span> : null}
              {live?.thinkingTokens ? (
                <span>· {live.thinkingTokens} thinking tokens</span>
              ) : null}
              {live?.target ? <span>· {live.target}</span> : null}
              <button
                type="button"
                className="ml-1 inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] hover:bg-muted"
                onClick={() => void assistant.stop()}
                data-testid="assistant-stop"
              >
                <Square size={8} />
                Stop
              </button>
            </div>
          ) : null}

          {!hasUserMessage && !working ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="rounded-full border border-border bg-card px-2.5 py-1 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => void send(suggestion)}
                >
                  {suggestion}
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
            placeholder={working ? 'Mira is working…' : 'Ask Mira about any project…'}
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
            aria-label="Send"
            data-testid="assistant-send"
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

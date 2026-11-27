import { useEffect, useMemo, useRef, useState } from 'react'
import {
  History,
  ListTodo,
  MessageSquare,
  Search,
  TerminalSquare,
  Users,
  X
} from 'lucide-react'
import type { RepositorySummary, SessionListView } from '../../../shared/schemas/ipc'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type {
  BotChatPayload,
  BotHistorySearchResult,
  BotSummaryPayload
} from '../../../shared/schemas/bots'
import type { GroupSummaryPayload } from '../../../shared/schemas/groups'
import {
  ASSISTANT_PREVIOUS_HOME_TITLE,
  ASSISTANT_SIDE_CHAT_TITLE
} from '../../../shared/domain/assistant'
import { groupThreadIsUntitled } from '../../../shared/domain/group'
import { harnessLabel } from '../../../shared/domain/harness'
import { useT } from '../i18n/use-i18n'
import { callApi } from '../lib/api'
import { relativeTimeLabel } from './projects-wall-model'

type HistoryKind = 'session' | 'task' | 'room' | 'chat'

type HistoryEntry = {
  key: string
  kind: HistoryKind
  title: string
  subtitle: string
  detail: string | null
  /** Hidden text that still matches the query, such as a task prompt. */
  searchText?: string
  time: number
  sessionId?: string
  taskId?: string
  groupId?: string
  threadId?: string
  botId?: string
}

type Filter = 'all' | HistoryKind

const FILTERS: Filter[] = ['all', 'session', 'task', 'room', 'chat']

function clipped(text: string, max = 80): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/**
 * A global, searchable history across project sessions, tasks, group rooms
 * and bot chats. Selecting a row opens the same destination as its ordinary
 * sidebar or room entry, so a closed tab is not a dead end.
 */
export default function SessionHistoryDialog({
  open,
  repos,
  onClose,
  onOpenSession,
  onOpenTask,
  onOpenGroup,
  onOpenBotChat
}: {
  open: boolean
  repos: RepositorySummary[]
  onClose: () => void
  onOpenSession: (sessionId: string) => void
  onOpenTask: (taskId: string) => void
  onOpenGroup: (groupId: string, threadId?: string) => void
  onOpenBotChat: (botId: string, threadId: string) => void
}): React.JSX.Element | null {
  const t = useT()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [active, setActive] = useState(0)
  const [matches, setMatches] = useState<
    ReadonlyMap<string, { snippet: string; time: number }>
  >(new Map())
  const inputRef = useRef<HTMLInputElement | null>(null)
  const reposRef = useRef(repos)
  reposRef.current = repos

  useEffect(() => {
    if (!open) return
    setQuery('')
    setFilter('all')
    setActive(0)
    setMatches(new Map())
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const repoName = (repoId: string): string =>
      reposRef.current.find((repo) => repo.id === repoId)?.displayName ?? repoId
    void (async () => {
      const [sessionsResult, tasksResult, groupsResult, botsResult] = await Promise.all([
        callApi<SessionListView>(window.icode.sessions.list({})),
        callApi<TaskRecordPayload[]>(
          window.icode.tasks.list({ includeArchived: true, limit: 200 })
        ),
        callApi<GroupSummaryPayload[]>(window.icode.groups.list()),
        callApi<BotSummaryPayload[]>(window.icode.bots.list())
      ])
      if (cancelled) return
      const next: HistoryEntry[] = []
      let firstError: string | null = null
      const noteError = (result: { ok: false; error: { message: string } }): void => {
        firstError ??= result.error.message
      }

      if (sessionsResult.ok) {
        for (const session of sessionsResult.value.sessions) {
          next.push({
            key: `session:${session.id}`,
            kind: 'session',
            title: session.title,
            subtitle: repoName(session.repoId),
            detail: `${session.harness} · ${session.state}`,
            time: session.updatedAt,
            sessionId: session.id
          })
        }
      } else noteError(sessionsResult)

      if (tasksResult.ok) {
        for (const task of tasksResult.value) {
          next.push({
            key: `task:${task.id}`,
            kind: 'task',
            title: task.title.trim().length > 0 ? task.title : clipped(task.prompt, 60),
            subtitle: repoName(task.repoId),
            detail: task.archivedAt === null ? task.status : `${task.status} · archived`,
            searchText: task.prompt,
            time: task.updatedAt,
            taskId: task.id
          })
        }
      } else noteError(tasksResult)

      if (groupsResult.ok) {
        for (const group of groupsResult.value) {
          for (const thread of group.threads) {
            if (thread.latestAt === null) continue
            next.push({
              key: `room:${group.id}:${thread.id}`,
              kind: 'room',
              title: thread.isDefault
                ? group.name
                : groupThreadIsUntitled(thread)
                  ? t('bots.thread.untitled')
                  : thread.title,
              subtitle: group.name,
              detail: thread.latestText === null ? null : clipped(thread.latestText, 90),
              time: thread.latestAt,
              groupId: group.id,
              threadId: thread.id
            })
          }
        }
      } else noteError(groupsResult)

      if (botsResult.ok) {
        const perBot = await Promise.all(
          botsResult.value.map(async (bot) => ({
            bot,
            result: await callApi<BotChatPayload[]>(
              window.icode.bots.chats({ botId: bot.id })
            )
          }))
        )
        if (cancelled) return
        for (const { bot, result } of perBot) {
          if (!result.ok) {
            noteError(result)
            continue
          }
          for (const chat of result.value) {
            if (!chat.isHome && chat.lastMessageAt === null) continue
            next.push({
              key: `chat:${bot.id}:${chat.id}`,
              kind: 'chat',
              title: chat.isHome
                ? `${bot.name} · ${t('bots.home.tab')}`
                : chat.title === ASSISTANT_SIDE_CHAT_TITLE
                  ? t('bots.chat.untitled')
                  : chat.title === ASSISTANT_PREVIOUS_HOME_TITLE
                    ? t('bots.chat.previousHome')
                    : chat.title,
              subtitle: bot.name,
              detail:
                chat.harness === null
                  ? bot.role
                  : `${harnessLabel(chat.harness)} · ${bot.role}`,
              time: chat.lastMessageAt ?? chat.createdAt,
              botId: bot.id,
              threadId: chat.id
            })
          }
        }
      } else noteError(botsResult)

      if (cancelled) return
      next.sort((left, right) => right.time - left.time)
      setEntries(next)
      setError(next.length === 0 ? firstError : null)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // Repository rows are read through a ref; a new array identity is not a
    // reason to reload the whole history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repos.length, t])

  // Durable chat/room transcripts are searched in main; project sessions keep
  // their titles because terminal output is not persisted.
  useEffect(() => {
    const needle = query.trim()
    if (!open || needle.length === 0) {
      setMatches(new Map())
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void callApi<BotHistorySearchResult>(
        window.icode.bots.historySearch({ query: needle, limit: 100 })
      ).then((result) => {
        if (cancelled || !result.ok) return
        const next = new Map<string, { snippet: string; time: number }>()
        for (const hit of result.value.chats) {
          const key = `chat:${hit.botId}:${hit.threadId}`
          if (!next.has(key)) next.set(key, { snippet: hit.snippet, time: hit.createdAt })
        }
        for (const hit of result.value.rooms) {
          const key = `room:${hit.groupId}:${hit.threadId}`
          if (!next.has(key)) next.set(key, { snippet: hit.snippet, time: hit.createdAt })
        }
        setMatches(next)
      })
    }, 140)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query])

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return entries.filter((entry) => {
      if (filter !== 'all' && entry.kind !== filter) return false
      if (needle.length === 0) return true
      if (matches.has(entry.key)) return true
      return `${entry.title}\n${entry.subtitle}\n${entry.detail ?? ''}\n${entry.searchText ?? ''}`
        .toLocaleLowerCase()
        .includes(needle)
    })
  }, [entries, filter, matches, query])

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1))
  }, [active, filtered.length])

  if (!open) return null

  const openEntry = (entry: HistoryEntry): void => {
    onClose()
    if (entry.kind === 'session' && entry.sessionId !== undefined) {
      onOpenSession(entry.sessionId)
    } else if (entry.kind === 'task' && entry.taskId !== undefined) {
      onOpenTask(entry.taskId)
    } else if (entry.kind === 'room' && entry.groupId !== undefined) {
      onOpenGroup(entry.groupId, entry.threadId)
    } else if (
      entry.kind === 'chat' &&
      entry.botId !== undefined &&
      entry.threadId !== undefined
    ) {
      onOpenBotChat(entry.botId, entry.threadId)
    }
  }

  const filterLabel = (value: Filter): string => {
    switch (value) {
      case 'all':
        return t('history.all')
      case 'session':
        return t('history.sessions')
      case 'task':
        return t('history.tasks')
      case 'room':
        return t('history.rooms')
      case 'chat':
        return t('history.chats')
    }
  }

  const iconFor = (entry: HistoryEntry): React.JSX.Element => {
    switch (entry.kind) {
      case 'session':
        return <TerminalSquare size={12} className="shrink-0 text-muted-foreground" />
      case 'task':
        return <ListTodo size={12} className="shrink-0 text-muted-foreground" />
      case 'room':
        return <Users size={12} className="shrink-0 text-muted-foreground" />
      case 'chat':
        return <MessageSquare size={12} className="shrink-0 text-muted-foreground" />
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 px-4 pt-[9vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      data-testid="session-history"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('history.title')}
        className="flex max-h-[72vh] w-[min(620px,100%)] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-[var(--icode-shadow-overlay)]"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActive((current) => Math.min(filtered.length - 1, current + 1))
            return
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((current) => Math.max(0, current - 1))
            return
          }
          if (event.key === 'Enter') {
            const entry = filtered[active]
            if (entry !== undefined) {
              event.preventDefault()
              openEntry(entry)
            }
          }
        }}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <History size={13} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
            value={query}
            placeholder={t('history.search')}
            aria-label={t('history.search')}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            data-testid="session-history-input"
          />
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('session.close')}
            data-testid="session-history-close"
          >
            <X size={12} />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              className={`inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[10px] ${
                filter === value
                  ? 'bg-accent-weak text-accent'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              onClick={() => {
                setFilter(value)
                setActive(0)
              }}
              aria-pressed={filter === value}
              data-testid={`session-history-filter-${value}`}
            >
              {filterLabel(value)}
            </button>
          ))}
          <span className="ml-auto shrink-0 text-[9.5px] text-muted-foreground">
            {filtered.length}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5" data-testid="session-history-results">
          {loading ? (
            <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              {t('history.loading')}
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              {error ?? t('history.empty')}
            </p>
          ) : (
            filtered.map((entry, index) => (
              <button
                key={entry.key}
                type="button"
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                  index === active
                    ? 'bg-muted text-foreground'
                    : 'text-foreground hover:bg-muted/60'
                }`}
                onMouseEnter={() => setActive(index)}
                onClick={() => openEntry(entry)}
                data-testid={`session-history-item-${entry.key}`}
              >
                {iconFor(entry)}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px]">{entry.title}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {entry.subtitle}
                    {(() => {
                      const match = matches.get(entry.key)
                      const detail =
                        query.trim().length > 0 && match !== undefined
                          ? clipped(match.snippet, 90)
                          : entry.detail
                      return detail === null ? '' : ` · ${detail}`
                    })()}
                  </span>
                </span>
                <span className="shrink-0 text-[9.5px] text-muted-foreground">
                  {relativeTimeLabel(entry.time)}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-[9.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Search size={9} /> {t('history.searchHint')}
          </span>
          <span className="ml-auto">{t('history.keyboardHint')}</span>
        </div>
      </div>
    </div>
  )
}

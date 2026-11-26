import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  Settings,
  Square,
  Users
} from 'lucide-react'
import type {
  GroupSummaryPayload,
  GroupThreadPayload,
  GroupTurnPayload,
  GroupUpdateInput
} from '../../../../shared/schemas/groups'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import type { RepositorySummary } from '../../../../shared/schemas/ipc'
import type { Notice } from '../../state/workspace'
import { useGroupRoom } from '../../state/use-group-room'
import { groupDraftAudience } from '../../../../shared/domain/group-mentions'
import AssistantAvatar from '../AssistantAvatar'
import AssistantCardView, { type AssistantTaskAction } from '../AssistantCardView'
import GroupSettingsDialog from './GroupSettingsDialog'
import ItemsRail from './ItemsRail'
import Markdown from '../Markdown'
import { useT } from '../../i18n/use-i18n'

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

function turnStatus(
  turn: GroupTurnPayload,
  t: ReturnType<typeof useT>
): { label: string; tone: string } {
  switch (turn.status) {
    case 'queued':
      return { label: t('bots.turn.queued'), tone: 'text-muted-foreground' }
    case 'working':
      return { label: t('bots.turn.working'), tone: 'text-info' }
    case 'completed':
      return {
        label: t('bots.turn.workedFor', {
          duration: formatDuration(
            Math.max(0, turn.updatedAt - (turn.deliveredAt ?? turn.createdAt))
          )
        }),
        tone: 'text-muted-foreground'
      }
    case 'failed':
      return { label: t('bots.turn.failed'), tone: 'text-destructive' }
    case 'cancelled':
      return { label: t('bots.turn.stopped'), tone: 'text-muted-foreground' }
    case 'inactive':
      return { label: t('bots.turn.inactive'), tone: 'text-muted-foreground' }
    default:
      return { label: turn.status, tone: 'text-muted-foreground' }
  }
}

const ACTIVE_TURN = new Set(['queued', 'working'])

/**
 * One thread of a bot group. Owner messages carry the bot turns they started;
 * a bot's final answer is stored on its turn, so the room never has to pair two
 * message rows to show who answered what.
 */
export default function GroupRoomPage({
  group,
  thread,
  bots,
  repos,
  notify,
  onOpenTask,
  onTaskAction,
  onSelectThread,
  onNewThread,
  onUpdateGroup,
  onArchiveGroup,
  onDeleteGroup
}: {
  group: GroupSummaryPayload
  thread: GroupThreadPayload
  bots: BotSummaryPayload[]
  repos: RepositorySummary[]
  notify: (notice: Notice) => void
  onOpenTask: (taskId: string) => void
  onTaskAction: (action: AssistantTaskAction, taskId: string) => void
  onSelectThread: (threadId: string) => void
  onNewThread: () => Promise<GroupThreadPayload | null>
  onUpdateGroup: (input: GroupUpdateInput) => Promise<GroupSummaryPayload | null>
  onArchiveGroup: () => Promise<boolean>
  onDeleteGroup: () => Promise<boolean>
}): React.JSX.Element {
  const t = useT()
  const room = useGroupRoom(group.id, thread.id, notify)
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [creatingThread, setCreatingThread] = useState(false)
  const [updatingMode, setUpdatingMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const stickBottom = useRef(true)

  const members = useMemo(
    () =>
      group.memberBotIds
        .map((botId) => bots.find((bot) => bot.id === botId))
        .filter((bot): bot is BotSummaryPayload => bot !== undefined),
    [bots, group.memberBotIds]
  )
  const namedBots = useMemo(
    () => members.map((bot) => ({ id: bot.id, name: bot.name })),
    [members]
  )
  const roomAudience = useMemo(
    () => ({
      members: group.memberBotIds.map((botId) => ({ botId })),
      replyMode: group.replyMode
    }),
    [group.memberBotIds, group.replyMode]
  )
  const audience = useMemo(
    () => groupDraftAudience(draft, roomAudience, namedBots),
    [draft, namedBots, roomAudience]
  )
  const mentionMenu = useMemo(() => {
    const before = draft.slice(0, caret)
    const match = /(?:^|[\s(])@([^@\n]*)$/u.exec(before)
    if (match === null) return null
    const start = match.index + match[0].lastIndexOf('@')
    const query = (match[1] ?? '').trim().toLocaleLowerCase()
    const items = members.filter((bot) =>
      bot.name.toLocaleLowerCase().startsWith(query)
    )
    const everyone = 'everyone'.startsWith(query)
    if (items.length === 0 && !everyone) return null
    return { start, items: items.slice(0, 6), everyone }
  }, [caret, draft, members])

  useEffect(() => {
    setDraft('')
    setCaret(0)
    stickBottom.current = true
  }, [thread.id])

  useEffect(() => {
    const element = threadRef.current
    if (element !== null && stickBottom.current) element.scrollTop = element.scrollHeight
  }, [room.messages])

  const memberName = (botId: string | null | undefined): string =>
    members.find((bot) => bot.id === botId)?.name ?? t('bots.fallback')

  const audienceLabel = ((): string => {
    if (audience === 'invalid') return t('bots.audience.invalid')
    if (audience.ids.length === 0) return t('bots.audience.none')
    if (audience.addressed) {
      return audience.ids.length === 1
        ? t('bots.audience.single', { name: memberName(audience.ids[0]) })
        : t('bots.audience.multiple', { count: audience.ids.length })
    }
    return group.replyMode.kind === 'all'
      ? t('bots.reply.all')
      : group.replyMode.kind === 'mentions'
        ? t('bots.reply.mentions')
        : t('bots.audience.single', { name: memberName(group.replyMode.botId) })
  })()

  const insertMention = (name: string): void => {
    if (mentionMenu === null) return
    const next = `${draft.slice(0, mentionMenu.start)}@${name} ${draft.slice(caret)}`
    setDraft(next)
    const position = mentionMenu.start + name.length + 2
    setCaret(position)
    requestAnimationFrame(() => {
      const composer = composerRef.current
      if (composer === null) return
      composer.focus()
      composer.setSelectionRange(position, position)
    })
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0 || audience === 'invalid') return
    stickBottom.current = true
    const ok = await room.send(text)
    if (ok) {
      setDraft('')
      setCaret(0)
    }
  }

  const changeReplyMode = async (value: string): Promise<void> => {
    if (updatingMode) return
    setUpdatingMode(true)
    const patch: GroupUpdateInput =
      value === 'all'
        ? { groupId: group.id, revision: group.revision, replyMode: { kind: 'all' } }
        : value === 'mentions'
          ? { groupId: group.id, revision: group.revision, replyMode: { kind: 'mentions' } }
          : {
              groupId: group.id,
              revision: group.revision,
              defaultBotId: value.slice('bot:'.length),
              replyMode: { kind: 'bot', botId: value.slice('bot:'.length) }
            }
    await onUpdateGroup(patch)
    setUpdatingMode(false)
  }

  const createThread = async (): Promise<void> => {
    if (creatingThread) return
    setCreatingThread(true)
    await onNewThread()
    setCreatingThread(false)
  }

  const replyModeValue =
    group.replyMode.kind === 'bot' ? `bot:${group.replyMode.botId}` : group.replyMode.kind

  const repoName = (repoId: string | undefined): string | undefined =>
    repoId === undefined ? undefined : repos.find((repo) => repo.id === repoId)?.displayName

  return (
    <div className="flex h-full min-h-0 bg-background" data-testid="bots-room">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-start gap-3 border-b border-border bg-card px-4 py-2.5">
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent">
            <Users size={13} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-[14px] font-semibold">{group.name}</h1>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t('bots.room.members', { count: members.length })}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {thread.isDefault ? t('bots.room.thread') : thread.title}
            </div>
          </div>
          <div className="mt-0.5 flex -space-x-1">
            {members.map((bot) => (
              <span key={bot.id} className="relative inline-flex" title={`${bot.name} · ${bot.role}`}>
                <AssistantAvatar
                  name={bot.name}
                  status={bot.status}
                  size="sm"
                  color={bot.avatarColor}
                  image={bot.avatarImage}
            mascot={bot.avatarMascot}
            outfit={bot.avatarOutfit}
                />
              </span>
            ))}
          </div>
          <div className="ml-2 flex items-center gap-1.5">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setSettingsOpen(true)}
              aria-label={t('bots.groupSettings.title')}
              title={t('bots.groupSettings.title')}
              data-testid="bots-group-settings"
            >
              <Settings size={11} />
            </button>
            <label className="sr-only" htmlFor="bots-reply-mode">
              {t('bots.reply.label')}
            </label>
            <select
              id="bots-reply-mode"
              className="h-7 max-w-[180px] rounded border border-border bg-background px-1.5 text-[10.5px] text-foreground outline-none focus:border-line-strong"
              value={replyModeValue}
              onChange={(event) => void changeReplyMode(event.target.value)}
              disabled={updatingMode || members.length === 0}
              data-testid="bots-reply-mode"
            >
              {members.map((bot) => (
                <option key={bot.id} value={`bot:${bot.id}`}>
                  {t('bots.reply.bot', { name: bot.name })}
                  {bot.pausedAt !== null ? ` · ${t('bots.paused')}` : ''}
                </option>
              ))}
              <option value="all">{t('bots.reply.all')}</option>
              <option value="mentions">{t('bots.reply.mentions')}</option>
            </select>
            {room.busy ? (
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void room.stop()}
                data-testid="bots-stop-all"
              >
                <Square size={9} /> {t('bots.room.stopAll')}
              </button>
            ) : null}
          </div>
        </header>

        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card/40 px-3 py-1.5">
          {group.threads.map((entry) => {
            const active = entry.id === thread.id
            return (
              <button
                key={entry.id}
                type="button"
                className={`inline-flex h-6 max-w-[200px] shrink-0 items-center gap-1 rounded px-2 text-[10.5px] ${
                  active
                    ? 'bg-accent/15 text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                onClick={() => onSelectThread(entry.id)}
                title={entry.title}
                data-testid={`bots-thread-${entry.id}`}
              >
                <MessageSquare size={9} />
                <span className="truncate">{entry.title}</span>
                {entry.unread > 0 && !active ? (
                  <span className="rounded-full bg-signal-weak px-1 text-[8px] text-signal">
                    {entry.unread > 9 ? '9+' : entry.unread}
                  </span>
                ) : null}
              </button>
            )
          })}
          <button
            type="button"
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={() => void createThread()}
            disabled={creatingThread}
            data-testid="bots-thread-new"
          >
            {creatingThread ? <Loader2 size={9} className="animate-spin" /> : <Plus size={9} />}
            {t('bots.room.newThread')}
          </button>
        </div>

        <div
          ref={threadRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          onScroll={() => {
            const element = threadRef.current
            if (element === null) return
            stickBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 48
          }}
          data-testid="bots-room-thread"
        >
          {room.loading ? (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 size={11} className="animate-spin" /> {t('bots.room.loading')}
            </p>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
              {room.hasEarlier ? (
                <button
                  type="button"
                  className="mx-auto inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  onClick={() => void room.loadEarlier()}
                  disabled={room.loadingEarlier}
                >
                  {room.loadingEarlier ? <Loader2 size={9} className="animate-spin" /> : <ArrowDown size={9} />}
                  {t('bots.room.loadEarlier')}
                </button>
              ) : null}
              {room.messages.length === 0 ? (
                <div className="mx-auto mt-8 max-w-sm rounded-md border border-dashed border-border p-4 text-center text-[11px] leading-relaxed text-muted-foreground">
                  {t('bots.room.empty')}
                </div>
              ) : (
                room.messages.map((message) => {
                  if (message.authorKind === 'system') {
                    return (
                      <div
                        key={message.id}
                        className="mx-auto max-w-[86%] rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[10.5px] text-muted-foreground"
                        data-testid={`bots-message-${message.id}`}
                      >
                        <div className="whitespace-pre-wrap">{message.body}</div>
                        {message.card !== null ? (
                          <div className="mt-1.5">
                            <AssistantCardView
                              card={message.card}
                              repoName={repoName(
                                'repoId' in message.card ? message.card.repoId : undefined
                              )}
                              onOpenTask={onOpenTask}
                              onTaskAction={onTaskAction}
                            />
                          </div>
                        ) : null}
                      </div>
                    )
                  }
                  const mine = message.authorKind === 'human'
                  const bot = members.find((entry) => entry.id === message.authorBotId)
                  return (
                    <div
                      key={message.id}
                      className={`flex flex-col gap-1.5 ${mine ? 'items-end' : 'items-start'}`}
                      data-testid={`bots-message-${message.id}`}
                    >
                      <div className="flex min-w-0 max-w-[88%] items-start gap-2">
                        {!mine ? (
                          <AssistantAvatar
                            name={message.authorName ?? bot?.name ?? '?'}
                            status={bot?.status ?? 'idle'}
                            size="sm"
                            color={bot?.avatarColor}
                            image={bot?.avatarImage}
                            mascot={bot?.avatarMascot}
                            outfit={bot?.avatarOutfit}
                          />
                        ) : null}
                        <div className="min-w-0">
                          <div className="mb-0.5 text-[9.5px] text-muted-foreground">
                            {mine ? t('bots.you') : (message.authorName ?? message.authorBotId)}
                          </div>
                          <div
                            className={`break-words rounded-lg px-3 py-2 text-[12px] leading-relaxed ${
                              mine
                                ? 'bg-accent/12 text-foreground'
                                : 'border border-border bg-card text-foreground'
                            }`}
                          >
                            {mine ? (
                              <span className="whitespace-pre-wrap">{message.body}</span>
                            ) : (
                              <Markdown text={message.body} />
                            )}
                          </div>
                          {message.card !== null ? (
                            <div className="mt-1.5">
                              <AssistantCardView
                                card={message.card}
                                repoName={repoName(
                                  'repoId' in message.card ? message.card.repoId : undefined
                                )}
                                onOpenTask={onOpenTask}
                                onTaskAction={onTaskAction}
                              />
                            </div>
                          ) : null}
                        </div>
                      </div>
                      {(message.turns ?? []).length > 0 ? (
                        <div className="w-full max-w-[88%] space-y-2 pl-7">
                          {(message.turns ?? []).map((turn) => {
                            const status = turnStatus(turn, t)
                            const active = ACTIVE_TURN.has(turn.status)
                            const turnBot = members.find((entry) => entry.id === turn.botId)
                            return (
                              <div
                                key={turn.operationId}
                                className="rounded-md border border-border bg-card/60 px-2.5 py-2"
                                data-testid={`bots-turn-${turn.operationId}`}
                              >
                                <div className="flex items-center gap-1.5">
                                  <AssistantAvatar
                                    name={turn.botName}
                                    status={turnBot?.status ?? 'idle'}
                                    size="sm"
                                    color={turnBot?.avatarColor}
                                    image={turnBot?.avatarImage}
                                    mascot={turnBot?.avatarMascot}
                                    outfit={turnBot?.avatarOutfit}
                                  />
                                  <span className="min-w-0 truncate text-[11px] font-medium text-foreground">
                                    {turn.botName}
                                  </span>
                                  <span className={`text-[9.5px] ${status.tone}`}>
                                    {active ? (
                                      <Loader2 size={9} className="mr-1 inline animate-spin" />
                                    ) : null}
                                    {status.label}
                                  </span>
                                  <span className="ml-auto flex items-center gap-1">
                                    {active ? (
                                      <button
                                        type="button"
                                        className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[9.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                                        onClick={() => void room.stop(turn.botId)}
                                        data-testid={`bots-turn-stop-${turn.operationId}`}
                                      >
                                        <Square size={8} /> {t('bots.turn.stop')}
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[9.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                                      onClick={() => {
                                        setDraft(`@${turn.botName} `)
                                        setCaret(turn.botName.length + 2)
                                        composerRef.current?.focus()
                                      }}
                                    >
                                      {t('bots.turn.reply')}
                                    </button>
                                  </span>
                                </div>
                                {turn.reply !== null ? (
                                  <div className="mt-1.5 text-[12px] leading-relaxed text-foreground">
                                    <Markdown text={turn.reply} />
                                  </div>
                                ) : null}
                                {turn.status === 'failed' && turn.error !== null ? (
                                  <p className="mt-1 text-[10px] text-destructive">{turn.error}</p>
                                ) : null}
                                <details className="mt-1.5 text-[9.5px] text-muted-foreground">
                                  <summary className="cursor-pointer select-none hover:text-foreground">
                                    {t('bots.turn.details')}
                                  </summary>
                                  <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                                    <span>{t('bots.turn.run')}</span>
                                    <span className="truncate font-mono" title={turn.runId ?? undefined}>
                                      {turn.runId ?? '—'}
                                    </span>
                                    <span>{t('bots.turn.session')}</span>
                                    <span
                                      className="truncate font-mono"
                                      title={turn.assistantThreadId ?? undefined}
                                    >
                                      {turn.assistantThreadId ?? '—'}
                                    </span>
                                    <span>{t('bots.turn.handoffs')}</span>
                                    <span className="truncate">
                                      {turn.handedOff.length > 0 ? turn.handedOff.join(', ') : '—'}
                                    </span>
                                    <span>{t('bots.turn.queuedAt')}</span>
                                    <span>{new Date(turn.createdAt).toLocaleTimeString()}</span>
                                    <span>{t('bots.turn.startedAt')}</span>
                                    <span>
                                      {turn.deliveredAt === null
                                        ? '—'
                                        : new Date(turn.deliveredAt).toLocaleTimeString()}
                                    </span>
                                    <span>{t('bots.turn.finishedAt')}</span>
                                    <span>
                                      {turn.status === 'queued' || turn.status === 'working'
                                        ? '—'
                                        : new Date(turn.updatedAt).toLocaleTimeString()}
                                    </span>
                                  </div>
                                </details>
                              </div>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        <div className="relative shrink-0 border-t border-border bg-card p-3">
          {mentionMenu !== null ? (
            <div className="absolute bottom-full left-3 z-20 mb-1 w-64 overflow-hidden rounded-md border border-border bg-card py-1 shadow-xl">
              {mentionMenu.items.map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-muted"
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
              {mentionMenu.everyone ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-muted"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    insertMention('everyone')
                  }}
                >
                  <Users size={12} className="text-muted-foreground" />
                  <span>everyone</span>
                </button>
              ) : null}
            </div>
          ) : null}
          <textarea
            ref={composerRef}
            className="max-h-40 min-h-[56px] w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-[12px] leading-relaxed outline-none focus:border-line-strong"
            value={draft}
            placeholder={t('bots.composer.placeholder')}
            onChange={(event) => {
              setDraft(event.target.value)
              setCaret(event.target.selectionStart)
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            data-testid="bots-composer"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <span
              className={`min-w-0 flex-1 truncate text-[9.5px] ${
                audience === 'invalid' ? 'text-destructive' : 'text-muted-foreground'
              }`}
              data-testid="bots-audience"
            >
              {audienceLabel}
            </span>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded bg-accent px-2.5 text-[10.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              onClick={() => void send()}
              disabled={room.sending || draft.trim().length === 0 || audience === 'invalid'}
              data-testid="bots-send"
            >
              {room.sending ? <Loader2 size={10} className="animate-spin" /> : <Send size={10} />}
              {t('bots.composer.send')}
            </button>
          </div>
        </div>
      </div>

      <ItemsRail
        filter={{ groupId: group.id }}
        members={members}
        notify={notify}
        onOpenTask={onOpenTask}
        onTaskAction={onTaskAction}
      />
      {settingsOpen ? (
        <GroupSettingsDialog
          group={group}
          bots={bots}
          onUpdateGroup={onUpdateGroup}
          onArchive={onArchiveGroup}
          onDelete={onDeleteGroup}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  )
}

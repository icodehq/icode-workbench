import { useState } from 'react'
import { ListTree, Loader2, MessageSquare, Plus, Settings, Users } from 'lucide-react'
import type {
  GroupSummaryPayload,
  GroupThreadPayload,
  GroupUpdateInput
} from '../../../../shared/schemas/groups'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import { groupThreadLabel } from '../../../../shared/domain/group'
import AssistantAvatar from '../AssistantAvatar'
import { useT } from '../../i18n/use-i18n'

/** Group-level controls shared by every room pane in a split. */
export default function GroupWorkspaceHeader({
  group,
  members,
  activeThreadId,
  creatingThread,
  onOpenThread,
  onNewThread,
  onUpdateGroup,
  onOpenSettings
}: {
  group: GroupSummaryPayload
  members: BotSummaryPayload[]
  activeThreadId: string | null
  creatingThread: boolean
  onOpenThread: (thread: GroupThreadPayload) => void
  onNewThread: () => void
  onUpdateGroup: (input: GroupUpdateInput) => Promise<GroupSummaryPayload | null>
  onOpenSettings: () => void
}): React.JSX.Element {
  const t = useT()
  const [threadsOpen, setThreadsOpen] = useState(false)
  const [updatingMode, setUpdatingMode] = useState(false)

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

  const replyModeValue =
    group.replyMode.kind === 'bot' ? `bot:${group.replyMode.botId}` : group.replyMode.kind

  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent">
        <Users size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-[13px] font-semibold">{group.name}</h1>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {t('bots.room.members', { count: members.length })}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <div className="flex -space-x-1">
            {members.slice(0, 6).map((bot) => (
              <span
                key={bot.id}
                className="relative inline-flex rounded-full ring-1 ring-card"
                title={`${bot.name} · ${bot.role}`}
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
              </span>
            ))}
          </div>
          {members.length > 6 ? (
            <span className="text-[9px] text-muted-foreground">+{members.length - 6}</span>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="relative">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setThreadsOpen((current) => !current)}
            aria-haspopup="menu"
            aria-expanded={threadsOpen}
            data-testid="bots-threads-menu"
          >
            <ListTree size={10} /> {t('bots.room.threads')}
          </button>
          {threadsOpen ? (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setThreadsOpen(false)} />
              <div
                className="absolute right-0 top-full z-30 mt-1 max-h-[320px] w-64 overflow-y-auto rounded-md border border-border bg-card py-1 shadow-xl"
                role="menu"
              >
                {group.threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    role="menuitem"
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] ${
                      thread.id === activeThreadId ? 'bg-muted' : 'hover:bg-muted'
                    }`}
                    onClick={() => {
                      setThreadsOpen(false)
                      onOpenThread(thread)
                    }}
                    data-testid={`bots-thread-${thread.id}`}
                  >
                    <MessageSquare
                      size={10}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {groupThreadLabel(
                        group.name,
                        thread,
                        t('bots.thread.untitled')
                      )}
                    </span>
                    {thread.unread > 0 ? (
                      <span className="rounded-full bg-signal-weak px-1 text-[8px] text-signal">
                        {thread.unread > 9 ? '9+' : thread.unread}
                      </span>
                    ) : null}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={creatingThread}
                  onClick={() => {
                    setThreadsOpen(false)
                    onNewThread()
                  }}
                  data-testid="bots-thread-new"
                >
                  {creatingThread ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <Plus size={10} />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {t('bots.room.newThreadIn', { name: group.name })}
                  </span>
                  <span className="text-[9px] font-normal text-muted-foreground">
                    {t('bots.room.newThreadStartsFresh')}
                  </span>
                </button>
              </div>
            </>
          ) : null}
        </div>

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

        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onOpenSettings}
          aria-label={t('bots.groupSettings.title')}
          title={t('bots.groupSettings.title')}
          data-testid="bots-group-settings"
        >
          <Settings size={11} />
        </button>
      </div>
    </header>
  )
}

import { useEffect, useState } from 'react'
import { Plus, Settings } from 'lucide-react'
import { useT } from '../../i18n/use-i18n'
import type { BotsWorkspaceState } from '../../state/use-bots'
import type { AssistantState } from '../../state/use-assistant'
import { useBotChat } from '../../state/use-assistant'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { RepositorySummary } from '../../../../shared/schemas/ipc'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import type { Notice } from '../../state/workspace'
import type { AssistantTaskAction } from '../AssistantCardView'
import AssistantAvatar from '../AssistantAvatar'
import AssistantPage from '../../pages/AssistantPage'
import BotSettingsDialog from './BotSettingsDialog'
import GroupRoomPage from './GroupRoomPage'
import ItemsRail from './ItemsRail'

function BotHomeHeader({
  bot,
  assistant,
  onOpenSettings
}: {
  bot: BotSummaryPayload
  assistant: AssistantState
  onOpenSettings: () => void
}): React.JSX.Element {
  const t = useT()
  const working = assistant.status === 'working'
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      <AssistantAvatar
        name={bot.name}
        status={bot.status}
        size="sm"
        color={bot.avatarColor}
        image={bot.avatarImage}
        mascot={bot.avatarMascot}
        outfit={bot.avatarOutfit}
      />
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium text-foreground">{bot.name}</div>
        <div className="truncate text-[10px] text-muted-foreground">
          {bot.role}
          {bot.pausedAt !== null ? ` · ${t('bots.paused')}` : ''}
        </div>
      </div>
      <button
        type="button"
        className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => void assistant.newConversation()}
        disabled={working}
        title={t('bots.home.newChat')}
        aria-label={t('bots.home.newChat')}
        data-testid="bots-new-conversation"
      >
        <Plus size={12} />
      </button>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onOpenSettings}
        data-testid="bots-open-settings"
      >
        <Settings size={11} /> {t('bot.settings.title')}
      </button>
    </div>
  )
}

function BotHomeView({
  bot,
  assistant,
  suggestions,
  repos,
  tasks,
  mentionBots,
  onOpenTask,
  onTaskAction,
  onOpenSettings
}: {
  bot: BotSummaryPayload
  assistant: AssistantState
  suggestions: boolean
  repos: RepositorySummary[]
  tasks: TaskRecordPayload[]
  mentionBots: BotSummaryPayload[]
  onOpenTask: (taskId: string) => void
  onTaskAction: (action: AssistantTaskAction, taskId: string) => void
  onOpenSettings: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BotHomeHeader bot={bot} assistant={assistant} onOpenSettings={onOpenSettings} />
      <div className="min-h-0 flex-1">
        <AssistantPage
          assistant={assistant}
          repos={repos}
          tasks={tasks}
          mentionBots={mentionBots}
          role={bot.role}
          suggestions={suggestions}
          showHeader={false}
          color={bot.avatarColor}
          image={bot.avatarImage}
          mascot={bot.avatarMascot}
          outfit={bot.avatarOutfit}
          onOpenTask={onOpenTask}
          onTaskAction={onTaskAction}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </div>
  )
}

function BotChatView({
  bot,
  repos,
  tasks,
  mentionBots,
  notify,
  onOpenTask,
  onTaskAction,
  onOpenSettings
}: {
  bot: BotSummaryPayload
  repos: RepositorySummary[]
  tasks: TaskRecordPayload[]
  mentionBots: BotSummaryPayload[]
  notify: (notice: Notice) => void
  onOpenTask: (taskId: string) => void
  onTaskAction: (action: AssistantTaskAction, taskId: string) => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const chat = useBotChat(bot.id, notify)
  return (
    <BotHomeView
      bot={bot}
      assistant={chat}
      suggestions={false}
      repos={repos}
      tasks={tasks}
      mentionBots={mentionBots}
      onOpenTask={onOpenTask}
      onTaskAction={onTaskAction}
      onOpenSettings={onOpenSettings}
    />
  )
}

/**
 * The Bots surface: a group room, or one bot's home chat. Group selection is
 * always a (group, thread) pair; bot home chats are their own assistant thread.
 */
export default function BotsSurface({
  state,
  repos,
  tasks,
  notify,
  onOpenTask,
  onOpenSession,
  onTaskAction
}: {
  state: BotsWorkspaceState
  repos: RepositorySummary[]
  tasks: TaskRecordPayload[]
  notify: (notice: Notice) => void
  onOpenTask: (taskId: string) => void
  onOpenSession: (sessionId: string) => void
  onTaskAction: (action: AssistantTaskAction, taskId: string) => void
}): React.JSX.Element {
  const t = useT()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const selectedBotId = state.bot?.id ?? null
  useEffect(() => {
    setSettingsOpen(false)
  }, [selectedBotId])

  if (state.selected?.kind === 'group' && state.group !== null && state.thread !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <GroupRoomPage
            key={`${state.group.id}:${state.thread.id}`}
            group={state.group}
            thread={state.thread}
            bots={state.bots}
            repos={repos}
            notify={notify}
            onOpenTask={onOpenTask}
            onOpenSession={onOpenSession}
            onTaskAction={onTaskAction}
            onSelectThread={state.selectThread}
            onNewThread={() => state.createThread(state.group!.id)}
            onUpdateGroup={state.updateGroup}
            onArchiveGroup={() => state.archiveGroup(state.group!.id)}
            onDeleteGroup={() => state.deleteGroup(state.group!.id)}
          />
        </div>
      </div>
    )
  }

  if (state.selected?.kind === 'bot' && state.bot !== null) {
    const bot = state.bot
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <BotChatView
              key={bot.id}
              bot={bot}
              repos={repos}
              tasks={tasks}
              mentionBots={state.bots.filter((entry) => entry.id !== bot.id)}
              notify={notify}
              onOpenTask={onOpenTask}
              onTaskAction={onTaskAction}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </div>
          <ItemsRail
            filter={{ botId: bot.id }}
            members={[bot]}
            notify={notify}
            onOpenTask={onOpenTask}
            onTaskAction={onTaskAction}
          />
        </div>
        {settingsOpen ? (
          <BotSettingsDialog
            bot={bot}
            state={state}
            notify={notify}
            groups={state.groups.filter((group) => group.memberBotIds.includes(bot.id))}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div
      className="flex h-full items-center justify-center bg-background p-8"
      data-testid="bots-empty"
    >
      <div className="max-w-sm rounded-lg border border-dashed border-border p-6 text-center">
        <h1 className="text-[15px] font-semibold">{t('bots.empty.title')}</h1>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t('bots.empty.body')}
        </p>
        <p className="mt-3 text-[10.5px] text-muted-foreground">{t('bots.select')}</p>
      </div>
    </div>
  )
}

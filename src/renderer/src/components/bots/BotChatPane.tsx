import { History, Plus, Settings } from 'lucide-react'
import { harnessLabel, type ModelHarness } from '../../../../shared/domain/harness'
import { useT } from '../../i18n/use-i18n'
import type { AssistantState } from '../../state/use-assistant'
import { useBotChat } from '../../state/use-assistant'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { RepositorySummary } from '../../../../shared/schemas/ipc'
import type { BotSummaryPayload } from '../../../../shared/schemas/bots'
import type { Notice } from '../../state/workspace'
import type { AssistantTaskAction } from '../AssistantCardView'
import AssistantAvatar from '../AssistantAvatar'
import AssistantPage from '../../pages/AssistantPage'

function BotChatHeader({
  bot,
  title,
  harness,
  assistant,
  creating,
  onNewChat,
  onOpenHistory,
  onOpenSettings
}: {
  bot: BotSummaryPayload
  title: string
  harness: ModelHarness | null
  assistant: AssistantState
  creating: boolean
  onNewChat: () => void
  onOpenHistory: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const t = useT()
  const agent = harness === null ? null : harnessLabel(harness)
  const working = assistant.status === 'working'
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3"
      data-testid="bot-chat-header"
      data-agent={agent ?? ''}
      data-harness={harness ?? ''}
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
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium text-foreground">{title}</div>
        <div className="truncate text-[10px] text-muted-foreground">
          {bot.name} · {agent ?? bot.role}
          {bot.pausedAt !== null ? ` · ${t('bots.paused')}` : ''}
        </div>
      </div>
      <button
        type="button"
        className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onNewChat}
        disabled={working || creating}
        title={t('bots.home.newChat')}
        aria-label={t('bots.home.newChat')}
        data-testid="bots-new-conversation"
      >
        <Plus size={12} />
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onOpenHistory}
        title={t('history.title')}
        aria-label={t('history.title')}
        data-testid="bots-open-history"
      >
        <History size={11} />
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

/** One assistant thread of a bot, rendered in a workspace pane. */
export default function BotChatPane({
  bot,
  threadId,
  title,
  harness,
  creating,
  repos,
  tasks,
  mentionBots,
  notify,
  onOpenTask,
  onTaskAction,
  onOpenHistory,
  onOpenSettings,
  onNewChat
}: {
  bot: BotSummaryPayload
  threadId: string
  title: string
  harness: ModelHarness | null
  creating: boolean
  repos: RepositorySummary[]
  tasks: TaskRecordPayload[]
  mentionBots: BotSummaryPayload[]
  notify: (notice: Notice) => void
  onOpenTask: (taskId: string) => void
  onTaskAction: (action: AssistantTaskAction, taskId: string) => void
  onOpenHistory: () => void
  onOpenSettings: () => void
  onNewChat: () => void
}): React.JSX.Element {
  const chat = useBotChat(bot.id, notify, undefined, threadId)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BotChatHeader
        bot={bot}
        title={title}
        harness={harness}
        assistant={chat}
        creating={creating}
        onNewChat={onNewChat}
        onOpenHistory={onOpenHistory}
        onOpenSettings={onOpenSettings}
      />
      <div className="min-h-0 flex-1">
        <AssistantPage
          assistant={chat}
          repos={repos}
          tasks={tasks}
          mentionBots={mentionBots}
          role={bot.role}
          suggestions={false}
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

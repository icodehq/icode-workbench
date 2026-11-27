import { useEffect, useState } from 'react'
import { useT } from '../../i18n/use-i18n'
import type { BotsWorkspaceState } from '../../state/use-bots'
import type { TaskRecordPayload } from '../../../../shared/icode-api'
import type { RepositorySummary } from '../../../../shared/schemas/ipc'
import type { Notice } from '../../state/workspace'
import type { AssistantTaskAction } from '../AssistantCardView'
import BotChatWorkspace from './BotChatWorkspace'
import BotSettingsDialog from './BotSettingsDialog'
import GroupWorkspaceSurface from './GroupWorkspaceSurface'
import ItemsRail from './ItemsRail'

/**
 * The Bots surface: a group workspace, or one bot's own workspace with its
 * Home chat and side chats. A group selection is always a (group, thread) pair.
 */
export default function BotsSurface({
  state,
  repos,
  tasks,
  notify,
  onOpenTask,
  onOpenSession,
  onOpenHistory,
  onTaskAction
}: {
  state: BotsWorkspaceState
  repos: RepositorySummary[]
  tasks: TaskRecordPayload[]
  notify: (notice: Notice) => void
  onOpenTask: (taskId: string) => void
  onOpenSession: (sessionId: string) => void
  onOpenHistory: () => void
  onTaskAction: (action: AssistantTaskAction, taskId: string) => void
}): React.JSX.Element {
  const t = useT()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const selectedBotId = state.bot?.id ?? null
  useEffect(() => {
    setSettingsOpen(false)
  }, [selectedBotId])

  if (state.selected?.kind === 'group' && state.group !== null) {
    return (
      <GroupWorkspaceSurface
        state={state}
        group={state.group}
        repos={repos}
        notify={notify}
        onOpenTask={onOpenTask}
        onOpenSession={onOpenSession}
        onTaskAction={onTaskAction}
      />
    )
  }

  if (state.selected?.kind === 'bot' && state.bot !== null) {
    const bot = state.bot
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <BotChatWorkspace
              key={bot.id}
              bot={bot}
              repos={repos}
              tasks={tasks}
              mentionBots={state.bots.filter((entry) => entry.id !== bot.id)}
              request={state.chatRequest}
              notify={notify}
              onOpenTask={onOpenTask}
              onTaskAction={onTaskAction}
              onOpenHistory={onOpenHistory}
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

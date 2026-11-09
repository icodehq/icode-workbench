import { CalendarClock, LayoutGrid, Settings } from 'lucide-react'
import type { Surface } from '../router/routes'
import { useT } from '../i18n/use-i18n'

type Props = {
  surface: Surface
  assistantName: string
  assistantUnread: number
  assistantStatus: 'working' | 'idle' | 'offline' | 'error'
  onProjects: () => void
  onSchedules: () => void
  onAssistant: () => void
  onSettings: () => void
}

function RailDivider(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="rail-divider"
      className="h-6 w-px shrink-0 self-center bg-border min-[900px]:h-px min-[900px]:w-8"
    />
  )
}

const ASSISTANT_STATUS_CLASS: Record<Props['assistantStatus'], string> = {
  working: 'bg-info animate-pulse',
  idle: 'bg-add',
  offline: 'bg-muted-foreground',
  error: 'bg-destructive'
}

function PersonItem({
  active,
  name,
  unread,
  status,
  onClick
}: {
  active: boolean
  name: string
  unread: number
  status: Props['assistantStatus']
  onClick: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <button
      type="button"
      className={`relative flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-[9.5px] transition-colors min-[900px]:h-14 min-[900px]:w-[54px] min-[900px]:flex-col min-[900px]:gap-1 ${
        active
          ? 'bg-accent/10 text-accent'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={
        unread > 0 ? t('rail.assistantUnread', { name, count: unread }) : name
      }
      title={t('rail.assistantTitle', { name })}
      data-testid="rail-assistant"
      data-unread={unread}
    >
      <span className="relative inline-flex">
        <span
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent/12 text-[10px] font-semibold text-accent ${
            active ? 'ring-2 ring-accent/40' : ''
          }`}
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card ${ASSISTANT_STATUS_CLASS[status]}`}
          aria-hidden="true"
          data-testid="rail-assistant-status"
        />
        {unread > 0 ? (
          <span
            className="absolute -right-2 -top-2 min-w-3 rounded-full bg-signal px-1 text-center text-[9px] font-semibold leading-3 text-signal-ink"
            data-testid="rail-assistant-unread"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </span>
      <span className="leading-none">{name}</span>
    </button>
  )
}

function Item({
  active,
  label,
  testId,
  onClick,
  children
}: {
  active: boolean
  label: string
  testId: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-[9.5px] transition-colors min-[900px]:h-14 min-[900px]:w-[54px] min-[900px]:flex-col min-[900px]:gap-1 ${
        active
          ? 'bg-accent/10 text-accent'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={label}
      data-testid={testId}
    >
      {children}
      <span className="leading-none">{label}</span>
    </button>
  )
}

/**
 * Global destinations only. Sessions and Tasks are deliberately absent: they
 * belong to a project and are switched in the project header.
 */
export default function AppRail({
  surface,
  assistantName,
  assistantUnread,
  assistantStatus,
  onProjects,
  onSchedules,
  onAssistant,
  onSettings
}: Props): React.JSX.Element {
  const t = useT()
  const projectsActive =
    surface === 'projects' || surface === 'sessions' || surface === 'tasks'

  return (
    <nav
      className="flex h-12 w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-2 min-[900px]:h-auto min-[900px]:w-[66px] min-[900px]:flex-col min-[900px]:items-center min-[900px]:overflow-visible min-[900px]:border-b-0 min-[900px]:border-r min-[900px]:py-2"
      aria-label={t('rail.primaryNavigation')}
      data-testid="app-rail"
    >
      <Item
        active={projectsActive}
        label={t('rail.projects')}
        testId="rail-projects"
        onClick={onProjects}
      >
        <LayoutGrid size={18} />
      </Item>
      <Item
        active={surface === 'schedules'}
        label={t('rail.schedules')}
        testId="rail-schedules"
        onClick={onSchedules}
      >
        <CalendarClock size={18} />
      </Item>
      <RailDivider />
      <PersonItem
        active={surface === 'assistant'}
        name={assistantName}
        unread={assistantUnread}
        status={assistantStatus}
        onClick={onAssistant}
      />
      <span className="min-[900px]:mt-auto" />
      <RailDivider />
      <Item
        active={surface === 'settings'}
        label={t('rail.settings')}
        testId="rail-settings"
        onClick={onSettings}
      >
        <Settings size={18} />
      </Item>
    </nav>
  )
}

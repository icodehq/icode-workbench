import { CalendarClock, LayoutGrid, Settings } from 'lucide-react'
import type { Surface } from '../state/navigation'

type Props = {
  surface: Surface
  onProjects: () => void
  onSchedules: () => void
  onSettings: () => void
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
  onProjects,
  onSchedules,
  onSettings
}: Props): React.JSX.Element {
  const projectsActive =
    surface === 'projects' || surface === 'sessions' || surface === 'tasks' || surface === 'repositories'

  return (
    <nav
      className="flex h-12 w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-2 min-[900px]:h-auto min-[900px]:w-[66px] min-[900px]:flex-col min-[900px]:items-center min-[900px]:overflow-visible min-[900px]:border-b-0 min-[900px]:border-r min-[900px]:py-2"
      aria-label="Primary navigation"
      data-testid="app-rail"
    >
      <Item
        active={projectsActive}
        label="Projects"
        testId="rail-projects"
        onClick={onProjects}
      >
        <LayoutGrid size={18} />
      </Item>
      <Item
        active={surface === 'schedules'}
        label="Schedules"
        testId="rail-schedules"
        onClick={onSchedules}
      >
        <CalendarClock size={18} />
      </Item>
      <span className="min-[900px]:mt-auto" />
      <Item
        active={surface === 'settings'}
        label="Settings"
        testId="rail-settings"
        onClick={onSettings}
      >
        <Settings size={18} />
      </Item>
    </nav>
  )
}

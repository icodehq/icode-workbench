import { CalendarClock, Settings as SettingsIcon, Sparkles, TerminalSquare, X } from 'lucide-react'
import type { AppTab, AuxAppTab } from './shell/app-tabs'
import { headerRightInset } from './shell/window-chrome'
import { useT } from '../i18n/use-i18n'

type Props = {
  activeTab: AppTab
  auxTabs: readonly AuxAppTab[]
  assistantName: string
  assistantUnread: number
  platform: string | null
  onActivate: (tab: AppTab) => void
  onClose: (tab: AuxAppTab) => void
}

/**
 * Temporary app views. Sessions is pinned and always first; Mira, Settings and
 * Schedules exist only while opened. Task work is a main surface, not a tab.
 */
export default function AppTabStrip({
  activeTab,
  auxTabs,
  assistantName,
  assistantUnread,
  platform,
  onActivate,
  onClose
}: Props): React.JSX.Element | null {
  const t = useT()
  if (auxTabs.length === 0) return null

  const tabs: Array<{
    id: AppTab
    label: string
    icon: React.ReactNode
    closable: boolean
    badge?: number
  }> = [
    {
      id: 'sessions',
      label: t('projectHeader.sessions'),
      icon: <TerminalSquare size={12} />,
      closable: false
    },
    ...auxTabs.map((tab) => ({
      id: tab,
      label:
        tab === 'mira'
          ? assistantName
          : tab === 'settings'
            ? t('settings.title')
            : t('rail.schedules'),
      icon:
        tab === 'mira' ? (
          <Sparkles size={12} />
        ) : tab === 'settings' ? (
          <SettingsIcon size={12} />
        ) : (
          <CalendarClock size={12} />
        ),
      closable: true,
      badge: tab === 'mira' && assistantUnread > 0 ? assistantUnread : undefined
    }))
  ]

  const moveFocus = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
    )
    const index = buttons.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    event.preventDefault()
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    const next = buttons[nextIndex]
    if (!next) return
    next.focus()
    const id = next.getAttribute('data-tab-id') as AppTab | null
    if (id) onActivate(id)
  }

  return (
    <nav
      className="icode-titlebar flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-card px-2"
      style={{ paddingRight: headerRightInset(platform) + 8 }}
      role="tablist"
      aria-label={t('appTabs.label')}
      onKeyDown={moveFocus}
      data-testid="app-tabs"
    >
      {tabs.map((tab) => {
        const active = activeTab === tab.id
        const label = tab.label
        return (
          <div key={tab.id} className="relative flex h-8 shrink-0 items-center">
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`inline-flex h-8 items-center gap-1.5 rounded-t-md px-2.5 text-[11px] ${
                active
                  ? 'border-b-2 border-accent bg-background text-foreground'
                  : 'border-b-2 border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
              onClick={() => onActivate(tab.id)}
              data-tab-id={tab.id}
              data-testid={`app-tab-${tab.id}`}
              title={label}
            >
              {tab.icon}
              <span>{label}</span>
              {tab.badge !== undefined ? (
                <span
                  className="rounded-full bg-signal-weak px-1 text-[8px] font-medium text-signal"
                  title={t('rail.assistantUnread', { name: assistantName, count: tab.badge })}
                  data-testid="app-tab-mira-unread"
                >
                  {tab.badge > 9 ? '9+' : tab.badge}
                </span>
              ) : null}
            </button>
            {tab.closable ? (
              <button
                type="button"
                className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(tab.id as AuxAppTab)
                }}
                aria-label={t('appTabs.close', { name: label })}
                title={t('appTabs.close', { name: label })}
                data-testid={`app-tab-close-${tab.id}`}
              >
                <X size={10} />
              </button>
            ) : null}
          </div>
        )
      })}
    </nav>
  )
}

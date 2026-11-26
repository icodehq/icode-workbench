import {
  CalendarClock,
  MessageSquare,
  Settings as SettingsIcon,
  Sparkles,
  TerminalSquare,
  Users,
  X
} from 'lucide-react'
import type { AppTab, AuxAppTab } from './shell/app-tabs'
import type { OpenBotsTab } from '../state/use-bots'
import { headerRightInset } from './shell/window-chrome'
import { useT } from '../i18n/use-i18n'

export type AppBotsTab = {
  key: string
  tab: OpenBotsTab
  label: string
  badge?: number
}

type Props = {
  activeTab: AppTab
  auxTabs: readonly AuxAppTab[]
  botsTabs: readonly AppBotsTab[]
  activeBotsKey: string | null
  botsUnread: number
  platform: string | null
  onActivate: (tab: AppTab) => void
  onClose: (tab: AuxAppTab) => void
  onActivateBots: (tab: OpenBotsTab) => void
  onCloseBots: (tab: OpenBotsTab) => void
}

/**
 * Center tabs. Sessions is pinned; Bots, Settings and Schedules are fixed app
 * views; bot homes and group rooms are dynamic, one tab per open bot/group.
 */
export default function AppTabStrip({
  activeTab,
  auxTabs,
  botsTabs,
  activeBotsKey,
  botsUnread,
  platform,
  onActivate,
  onClose,
  onActivateBots,
  onCloseBots
}: Props): React.JSX.Element | null {
  const t = useT()
  const hasBotsHub = auxTabs.includes('bots')
  const showBotsHub = hasBotsHub && botsTabs.length === 0
  if (auxTabs.length === 0 && botsTabs.length === 0) return null

  const tabs: Array<{
    key: string
    label: string
    icon: React.ReactNode
    active: boolean
    closable: boolean
    badge?: number
    badgeTitle?: string
    testId: string
    closeTestId?: string
    activate: () => void
    close?: () => void
  }> = [
    {
      key: 'sessions',
      label: t('projectHeader.sessions'),
      icon: <TerminalSquare size={12} />,
      active: activeTab === 'sessions',
      closable: false,
      testId: 'app-tab-sessions',
      activate: () => onActivate('sessions')
    },
    ...botsTabs.map((tab) => ({
      key: `bots:${tab.key}`,
      label: tab.label,
      icon:
        tab.tab.kind === 'group' ? <MessageSquare size={12} /> : <Sparkles size={12} />,
      active: activeTab === 'bots' && activeBotsKey === tab.key,
      closable: true,
      ...(tab.badge === undefined || tab.badge === 0 ? {} : { badge: tab.badge }),
      badgeTitle: t('bots.unread', { count: tab.badge ?? 0 }),
      testId: `app-tab-bots-${tab.key}`,
      closeTestId: `app-tab-close-bots-${tab.key}`,
      activate: () => onActivateBots(tab.tab),
      close: () => onCloseBots(tab.tab)
    })),
    ...auxTabs
      .filter((tab) => tab !== 'bots' || showBotsHub)
      .map((tab) => ({
        key: tab,
        label:
          tab === 'bots'
            ? t('bots.label')
            : tab === 'settings'
              ? t('settings.title')
              : t('rail.schedules'),
        icon:
          tab === 'bots' ? (
            <Users size={12} />
          ) : tab === 'settings' ? (
            <SettingsIcon size={12} />
          ) : (
            <CalendarClock size={12} />
          ),
        active: activeTab === tab,
        closable: true,
        ...(tab === 'bots' && botsUnread > 0
          ? { badge: botsUnread, badgeTitle: t('bots.unread', { count: botsUnread }) }
          : {}),
        testId: `app-tab-${tab}`,
        closeTestId: `app-tab-close-${tab}`,
        activate: () => onActivate(tab),
        close: () => onClose(tab)
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
    next.click()
  }

  const tabIndex = (active: boolean): number => (active ? 0 : -1)

  return (
    <nav
      className="icode-titlebar flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-card px-2"
      style={{ paddingRight: headerRightInset(platform) + 8 }}
      role="tablist"
      aria-label={t('appTabs.label')}
      onKeyDown={moveFocus}
      data-testid="app-tabs"
    >
      {tabs.map((tab) => (
        <div key={tab.key} className="relative flex h-8 shrink-0 items-center">
          <button
            type="button"
            role="tab"
            aria-selected={tab.active}
            tabIndex={tabIndex(tab.active)}
            className={`inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-t-md px-2.5 text-[11px] ${
              tab.active
                ? 'border-b-2 border-accent bg-background text-foreground'
                : 'border-b-2 border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            }`}
            onClick={tab.activate}
            data-tab-id={tab.key}
            data-testid={tab.testId}
            title={tab.label}
          >
            {tab.icon}
            <span className="truncate">{tab.label}</span>
            {tab.badge !== undefined ? (
              <span
                className="rounded-full bg-signal-weak px-1 text-[8px] font-medium text-signal"
                title={tab.badgeTitle}
                data-testid={`${tab.testId}-unread`}
              >
                {tab.badge > 9 ? '9+' : tab.badge}
              </span>
            ) : null}
          </button>
          {tab.closable && tab.close !== undefined ? (
            <button
              type="button"
              className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation()
                tab.close?.()
              }}
              aria-label={t('appTabs.close', { name: tab.label })}
              title={t('appTabs.close', { name: tab.label })}
              data-testid={tab.closeTestId}
            >
              <X size={10} />
            </button>
          ) : null}
        </div>
      ))}
    </nav>
  )
}

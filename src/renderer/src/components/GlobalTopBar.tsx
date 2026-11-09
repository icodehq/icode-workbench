import { useEffect, useRef, useState } from 'react'
import {
  Bell,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  ListTodo,
  Minus,
  Monitor,
  Moon,
  Search,
  Square,
  Sun,
  Terminal,
  TerminalSquare,
  X
} from 'lucide-react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import { isMacPlatform, modifierLabel } from '../lib/platform'
import type { ThemeName, ThemePreference } from '../theme/apply-theme'
import { useT, useTp } from '../i18n/use-i18n'

export type NeedsYouEntry = {
  task: TaskRecordPayload
  repoName: string
}

type Props = {
  needsTasks: NeedsYouEntry[]
  hostUnreachable: boolean
  onSearch: () => void
  onNewSession: () => void
  onQueueTask: () => void
  onSchedules: () => void
  onOpenNotifications: () => void
  onProjects: () => void
  themePreference: ThemePreference
  resolvedTheme: ThemeName
  onSetTheme: (preference: ThemePreference) => void
  /** Host platform; macOS keeps native traffic lights and hides custom controls. */
  platform: string | null
}

/**
 * The global command bar.
 *
 * It deliberately contains no repository picker: project identity and the
 * Sessions/Tasks switch live in the project header, and Projects is the only
 * all-project surface. This is the visual answer to the two-project-selectors
 * defect.
 */
export default function GlobalTopBar({
  needsTasks,
  hostUnreachable,
  onSearch,
  onNewSession,
  onQueueTask,
  onSchedules,
  onOpenNotifications,
  onProjects,
  themePreference,
  resolvedTheme,
  onSetTheme,
  platform
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()
  // The UA identifies macOS before the runtime IPC resolves, so native traffic
  // lights never share the window with the custom Windows/Linux controls.
  const isMac = isMacPlatform(platform)
  const themeName =
    resolvedTheme === 'dark' ? t('common.dark') : t('common.light')
  const appearance =
    themePreference === 'system'
      ? `${t('common.system')} (${themeName})`
      : themePreference === 'dark'
        ? t('common.dark')
        : t('common.light')
  const needsYouLabel =
    needsTasks.length === 0
      ? t('topbar.notificationsActivity')
      : tp('topbar.notificationsAria', needsTasks.length)
  const needsYouTitle =
    needsTasks.length === 0
      ? t('topbar.notificationsActivity')
      : tp('topbar.notificationsTitle', needsTasks.length)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const newWrapRef = useRef<HTMLDivElement | null>(null)
  const themeWrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let disposed = false
    void window.icode.window.isMaximized().then((result) => {
      if (!disposed && result.ok) setMaximized(result.value)
    })
    const off = window.icode.window.onMaximizedChange((value) => {
      if (!disposed) setMaximized(value)
    })
    return () => {
      disposed = true
      off()
    }
  }, [])

  const toggleMaximize = (): void => {
    void window.icode.window.toggleMaximize().then((result) => {
      if (result.ok) setMaximized(result.value)
    })
  }

  const onHeaderDoubleClick = (event: React.MouseEvent<HTMLElement>): void => {
    const target = event.target
    if (target instanceof Element && target.closest('button, input, a, [role="button"]')) return
    toggleMaximize()
  }

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (newWrapRef.current?.contains(target) !== true) setNewMenuOpen(false)
      if (themeWrapRef.current?.contains(target) !== true) setThemeOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setNewMenuOpen(false)
        setThemeOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <header
      className={`icode-titlebar relative z-0 flex h-[50px] shrink-0 items-center gap-2 border-b border-border bg-card ${isMac ? 'pl-[78px]' : 'pl-3'}`}
      data-testid="app-topbar"
      onDoubleClick={isMac ? undefined : onHeaderDoubleClick}
    >
      <button
        type="button"
        className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted/50"
        onClick={onProjects}
        title={t('topbar.backToProjects')}
        data-testid="brand-home"
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border border-line bg-muted text-brand">
          <Terminal size={16} strokeWidth={1.8} />
        </span>
        <span className="flex flex-col leading-none">
          <span className="text-[14px] font-semibold tracking-tight">
            <span className="text-brand">i</span>Code
          </span>
          <span className="mt-1 hidden text-[9.5px] uppercase tracking-[0.16em] text-muted-foreground sm:inline">
            Workbench
          </span>
        </span>
      </button>

      <button
        type="button"
        className="ml-3 inline-flex h-8 min-w-0 max-w-[520px] flex-1 items-center gap-2 rounded-md border border-border bg-muted/60 px-2.5 text-left text-[11.5px] text-muted-foreground hover:border-line-strong hover:bg-muted hover:text-foreground"
        onClick={onSearch}
        title={t('topbar.searchTitle', { shortcut: `${modifierLabel(platform)}+K` })}
        data-testid="global-search"
      >
        <Search size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t('topbar.searchPlaceholder')}</span>
        <span className="hidden shrink-0 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] sm:inline">
          {modifierLabel(platform)} K
        </span>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className="relative" ref={newWrapRef}>
          <div className="flex items-center">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-l-md bg-accent px-3 text-[11.5px] font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              onClick={onNewSession}
              disabled={hostUnreachable}
              title={
                hostUnreachable
                  ? t('topbar.hostUnreachable')
                  : t('topbar.startDirectSession')
              }
              data-testid="new-session-open"
            >
              <TerminalSquare size={13} />
              <span className="hidden sm:inline">{t('topbar.newSession')}</span>
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center rounded-r-md border-l border-accent-ink/20 bg-accent px-2 text-accent-ink hover:opacity-90"
              onClick={() => setNewMenuOpen((open) => !open)}
              aria-label={t('topbar.moreWays')}
              aria-expanded={newMenuOpen}
              title={t('topbar.moreWays')}
              data-testid="new-menu"
            >
              <ChevronDown size={13} />
            </button>
          </div>
          {newMenuOpen ? (
            <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-52 rounded-md border border-border bg-card p-1 shadow-2xl">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-foreground hover:bg-muted"
                onClick={() => {
                  setNewMenuOpen(false)
                  onQueueTask()
                }}
                data-testid="queue-task-from-menu"
              >
                <ListTodo size={12} />
                {t('topbar.queueTask')}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-foreground hover:bg-muted"
                onClick={() => {
                  setNewMenuOpen(false)
                  onSchedules()
                }}
                data-testid="schedules-from-menu"
              >
                <CalendarClock size={12} />
                {t('topbar.schedules')}
              </button>
            </div>
          ) : null}
        </div>

        <div className="relative" ref={themeWrapRef}>
          <button
            type="button"
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setThemeOpen((open) => !open)}
            aria-label={t('topbar.appearanceLabel', { appearance })}
            aria-expanded={themeOpen}
            title={t('topbar.appearanceLabel', { appearance })}
            data-testid="theme-menu-button"
            data-theme-preference={themePreference}
            data-theme-resolved={resolvedTheme}
          >
            {themePreference === 'system' ? (
              <Monitor size={15} />
            ) : resolvedTheme === 'dark' ? (
              <Moon size={15} />
            ) : (
              <Sun size={15} />
            )}
          </button>
          {themeOpen ? (
            <div
              className="absolute right-0 top-[calc(100%+6px)] z-30 w-48 rounded-md border border-border bg-card p-1 shadow-2xl"
              role="dialog"
              aria-label={t('topbar.appearance')}
              data-testid="theme-menu"
            >
              <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('topbar.appearance')}
              </p>
              {(
                [
                  ['system', t('common.system'), Monitor],
                  ['dark', t('common.dark'), Moon],
                  ['light', t('common.light'), Sun]
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] ${
                    themePreference === value
                      ? 'bg-accent/10 text-accent'
                      : 'text-foreground hover:bg-muted'
                  }`}
                  onClick={() => {
                    setThemeOpen(false)
                    onSetTheme(value)
                  }}
                  data-testid={`theme-option-${value}`}
                >
                  <Icon size={12} />
                  <span className="flex-1">
                    {label}
                    {value === 'system' ? (
                      <span className="ml-1 text-[9px] text-muted-foreground">({themeName})</span>
                    ) : null}
                  </span>
                  {themePreference === value ? <Check size={11} /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onOpenNotifications}
          aria-label={needsYouLabel}
          title={needsYouTitle}
          data-testid="needs-you-bell"
          data-count={needsTasks.length}
        >
          <Bell size={15} />
          {needsTasks.length > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-signal px-1 text-center text-[9px] font-semibold leading-3 text-signal-ink">
              {needsTasks.length}
            </span>
          ) : null}
        </button>
      </div>

      {isMac ? null : (
      <div
        className="ml-2 flex h-full shrink-0 items-stretch"
        role="group"
        aria-label={t('topbar.windowControls')}
        data-testid="window-controls"
      >
        <button
          type="button"
          className="flex w-[42px] items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground min-[900px]:w-[46px]"
          onClick={() => { void window.icode.window.minimize() }}
          aria-label={t('topbar.minimize')}
          title={t('topbar.minimize')}
          data-testid="window-minimize"
        >
          <Minus size={12} />
        </button>
        <button
          type="button"
          className="flex w-[42px] items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground min-[900px]:w-[46px]"
          onClick={toggleMaximize}
          aria-label={maximized ? t('topbar.restore') : t('topbar.maximize')}
          aria-pressed={maximized}
          title={maximized ? t('topbar.restore') : t('topbar.maximize')}
          data-testid="window-toggle"
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          type="button"
          className="flex w-[42px] items-center justify-center text-muted-foreground hover:bg-destructive hover:text-white min-[900px]:w-[46px]"
          onClick={() => { void window.icode.window.close() }}
          aria-label={t('topbar.close')}
          title={t('topbar.close')}
          data-testid="window-close"
        >
          <X size={13} />
        </button>
      </div>
      )}
    </header>
  )
}

import type { ReactNode } from 'react'
import { Menu } from 'lucide-react'
import { isMacPlatform } from '../lib/platform'
import { useWindowMaximized } from '../components/shell/use-window-maximized'
import { useT } from '../i18n/use-i18n'

type Props = {
  /** Terminal-focus mode hides the surrounding chrome. */
  focusActive: boolean
  sidebar: ReactNode
  sidebarOpen: boolean
  onOpenSidebar: () => void
  onCloseSidebar: () => void
  appTabs: ReactNode
  windowChrome: ReactNode
  /** Global overlays stay mounted at the shell root. */
  overlays: ReactNode
  platform: string | null
  children: ReactNode
}

/**
 * The application shell: persistent sidebar, main column, window chrome,
 * status bar and app-wide overlays. It owns layout and focus visibility only.
 *
 * Below 900px the sidebar becomes a drawer with a scrim. Focus mode unmounts
 * every piece of chrome so the terminal can own the window.
 */
export default function AppLayout({
  focusActive,
  sidebar,
  sidebarOpen,
  onOpenSidebar,
  onCloseSidebar,
  appTabs,
  windowChrome,
  overlays,
  platform,
  children
}: Props): React.JSX.Element {
  const t = useT()
  const [, toggleMaximize] = useWindowMaximized()
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (isMacPlatform(platform)) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('button, input, select, textarea, a, [role="button"], [role="tab"]')) return
    if (!target.closest('.icode-titlebar')) return
    toggleMaximize()
  }
  return (
    <div
      className="relative flex h-screen overflow-hidden bg-background text-foreground"
      data-terminal-focus={focusActive ? 'true' : 'false'}
      data-window-platform={isMacPlatform(platform) ? 'mac' : 'win'}
      onDoubleClick={onDoubleClick}
    >
      {!focusActive ? (
        <>
          {sidebarOpen ? (
            <button
              type="button"
              className="fixed inset-0 z-40 bg-black/50 min-[900px]:hidden"
              onClick={onCloseSidebar}
              aria-label={t('sidebar.closeSidebar')}
              data-testid="sidebar-backdrop"
            />
          ) : null}
          <div
            className={`max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:z-50 max-[900px]:transition-transform max-[900px]:duration-150 min-[900px]:static ${
              sidebarOpen ? 'max-[900px]:translate-x-0' : 'max-[900px]:-translate-x-full'
            }`}
            data-testid="sidebar-shell"
          >
            {sidebar}
          </div>
        </>
      ) : null}

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {!focusActive ? (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-2 min-[900px]:hidden">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onOpenSidebar}
              aria-label={t('sidebar.openSidebar')}
              title={t('sidebar.openSidebar')}
              data-testid="sidebar-toggle"
            >
              <Menu size={14} />
            </button>
            <span className="truncate text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              iCode
            </span>
          </div>
        ) : null}

        {!focusActive ? appTabs : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </main>

      {!focusActive ? windowChrome : null}
      {overlays}
    </div>
  )
}

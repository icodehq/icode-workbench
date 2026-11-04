import type { ReactNode } from 'react'

type Props = {
  /** Terminal-focus mode hides the surrounding chrome. */
  focusActive: boolean
  topBar: ReactNode
  rail: ReactNode
  statusBar: ReactNode
  /** Global overlays stay mounted at the shell root. */
  overlays: ReactNode
  children: ReactNode
}

/**
 * The application shell: title bar, primary rail, main content, status bar and
 * app-wide overlays. It owns layout and focus visibility only; the composition
 * root supplies the elements and all behavior stays in their own owners.
 */
export default function AppLayout({
  focusActive,
  topBar,
  rail,
  statusBar,
  overlays,
  children
}: Props): React.JSX.Element {
  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-background text-foreground"
      data-terminal-focus={focusActive ? 'true' : 'false'}
    >
      {!focusActive ? topBar : null}

      <div className="flex min-h-0 flex-1 flex-col min-[900px]:flex-row">
        {!focusActive ? rail : null}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
      </div>

      {!focusActive ? statusBar : null}

      {overlays}
    </div>
  )
}

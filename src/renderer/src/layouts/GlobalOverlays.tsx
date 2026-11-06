import type { ComponentProps } from 'react'
import AddRepositoryDialog from '../components/AddRepositoryDialog'
import AppCloseGuard from '../components/AppCloseGuard'
import BranchCleanupDialog from '../components/BranchCleanupDialog'
import CommandPalette from '../components/CommandPalette'
import NewSessionDialog from '../components/NewSessionDialog'
import NotificationsDrawer from '../components/NotificationsDrawer'
import QuickOpen from '../components/QuickOpen'
import RemovalDialog from '../components/RemovalDialog'
import WorktreeCleanupDialog from '../components/WorktreeCleanupDialog'

type Props = {
  /** Always mounted; visibility is controlled by the drawer's `open` prop. */
  notifications: ComponentProps<typeof NotificationsDrawer>
  /** Always mounted; visibility is controlled by the palette's `open` prop. */
  palette: ComponentProps<typeof CommandPalette>
  /** Mounted only while a session owns the file palette. */
  quickOpen: ComponentProps<typeof QuickOpen> | null
  addRepository: ComponentProps<typeof AddRepositoryDialog> | null
  newSession: ComponentProps<typeof NewSessionDialog> | null
  removal: ComponentProps<typeof RemovalDialog> | null
  sessionCleanup: ComponentProps<typeof WorktreeCleanupDialog> | null
  branchCleanup: ComponentProps<typeof BranchCleanupDialog> | null
}

/**
 * The application's global overlays. This component owns only the mount
 * conditions and their order; open flags and busy state stay with their
 * existing owners in the composition root.
 */
export default function GlobalOverlays({
  notifications,
  palette,
  quickOpen,
  addRepository,
  newSession,
  removal,
  sessionCleanup,
  branchCleanup
}: Props): React.JSX.Element {
  return (
    <>
      <NotificationsDrawer {...notifications} />

      <CommandPalette {...palette} />

      {quickOpen !== null ? <QuickOpen {...quickOpen} /> : null}

      {addRepository !== null ? <AddRepositoryDialog {...addRepository} /> : null}

      {newSession !== null ? <NewSessionDialog {...newSession} /> : null}

      {removal !== null ? <RemovalDialog {...removal} /> : null}

      {sessionCleanup !== null ? (
        <WorktreeCleanupDialog {...sessionCleanup} />
      ) : null}

      {branchCleanup !== null ? <BranchCleanupDialog {...branchCleanup} /> : null}

      <AppCloseGuard />
    </>
  )
}

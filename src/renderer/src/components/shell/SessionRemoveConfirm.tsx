import type { SessionSummary } from '../../../../shared/schemas/ipc'
import { useFilesDirtyCount } from '../../files/open-files'
import { worktreeIsShared } from '../sessions/session-menu'
import RemoveSessionDialog from '../RemoveSessionDialog'

/**
 * The remove dialog needs the target session's open-file state, which is a
 * hook, so it lives in its own component rather than inside the sidebar body.
 */
export default function SessionRemoveConfirm({
  session,
  sessions,
  onClose,
  onConfirm
}: {
  session: SessionSummary
  sessions: SessionSummary[]
  onClose: () => void
  onConfirm: (deleteBranch: boolean) => void
}): React.JSX.Element {
  const unsavedCount = useFilesDirtyCount(session.id)
  return (
    <RemoveSessionDialog
      session={session}
      unsavedCount={unsavedCount}
      sharedWorktree={worktreeIsShared(session, sessions)}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  )
}

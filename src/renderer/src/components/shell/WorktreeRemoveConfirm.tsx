import type { RepositorySummary } from '../../../../shared/schemas/ipc'
import type { WorktreeRemovalOutcome } from '../../state/use-workspace'
import { useFilesDirtyCount } from '../../files/open-files'
import { worktreeWorkspaceKey } from '../../workspace/workspace-key'
import RemoveWorktreeDialog from '../RemoveWorktreeDialog'
import type { WorktreeSessionGroup } from './sidebar-model'

/**
 * The removal dialog needs the workspace's open-file state, which is a hook,
 * so it lives in its own component rather than inside the sidebar body.
 */
export default function WorktreeRemoveConfirm({
  repo,
  group,
  onClose,
  onRemove,
  onDiscard
}: {
  repo: RepositorySummary
  group: WorktreeSessionGroup
  onClose: () => void
  onRemove: (deleteBranch: boolean) => Promise<WorktreeRemovalOutcome>
  onDiscard: (confirmBranch: string, deleteBranch: boolean) => Promise<boolean>
}): React.JSX.Element {
  const unsavedCount = useFilesDirtyCount(worktreeWorkspaceKey(group.path))
  return (
    <RemoveWorktreeDialog
      repoName={repo.displayName}
      branch={group.branch}
      path={group.path}
      sessionCount={group.sessions.length}
      unsavedCount={unsavedCount}
      onClose={onClose}
      onRemove={onRemove}
      onDiscard={onDiscard}
    />
  )
}

import type { Notice } from '../../state/workspace'
import type { GitStashEntry } from '../../../../shared/icode-api'
import ScmStashesSection from '../ScmStashesSection'
import ScmWorktreesSection from '../ScmWorktreesSection'
import ScmSubmodulesSection from '../ScmSubmodulesSection'
import ScmTagsSection from '../ScmTagsSection'

type Props = {
  sessionId: string
  refreshToken: number
  gitRevision: number
  notify: (notice: Notice) => void
  onChanged: () => void
  onOpenStash: (stash: GitStashEntry) => void
}

/** The optional Git surfaces below the change list. */
export default function ScmAdvancedSections({
  sessionId,
  refreshToken,
  gitRevision,
  notify,
  onChanged,
  onOpenStash
}: Props): React.JSX.Element {
  return (
    <div className="max-h-[62%] min-h-0 shrink-0 overflow-y-auto">
      <ScmStashesSection
        sessionId={sessionId}
        refreshToken={refreshToken}
        gitRevision={gitRevision}
        notify={notify}
        onChanged={onChanged}
        onOpenStash={onOpenStash}
      />
      <ScmWorktreesSection
        sessionId={sessionId}
        refreshToken={refreshToken}
        gitRevision={gitRevision}
        notify={notify}
        onChanged={onChanged}
      />
      <ScmSubmodulesSection
        sessionId={sessionId}
        refreshToken={refreshToken}
        gitRevision={gitRevision}
        notify={notify}
        onChanged={onChanged}
      />
      <ScmTagsSection
        sessionId={sessionId}
        refreshToken={refreshToken}
        gitRevision={gitRevision}
        notify={notify}
        onChanged={onChanged}
      />
    </div>
  )
}

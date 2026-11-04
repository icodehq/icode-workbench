import { FolderGit2, Server } from 'lucide-react'
import type { RepositorySummary } from '../../../shared/schemas/ipc'

/**
 * The execution target is read from the persisted repository summary, never
 * inferred from the path: a Windows path and a distro path are different
 * filesystems even when they end with the same folder name.
 */
export default function TargetBadge({
  repo,
  compact = false
}: {
  repo: RepositorySummary
  compact?: boolean
}): React.JSX.Element {
  if (repo.target.kind === 'wsl') {
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-info/40 bg-info-weak px-1.5 text-[9px] font-medium text-info"
        title={`Execution target: WSL distro ${repo.target.distro}${
          repo.target.distroId === null ? '' : ` (registration ${repo.target.distroId})`
        }. Agent sessions run inside the distro; WSL terminals run on this desktop.`}
        data-testid="repo-target"
        data-target="wsl"
        data-distro={repo.target.distro}
      >
        <Server size={9} />
        {compact ? 'WSL' : `WSL · ${repo.target.distro}`}
      </span>
    )
  }
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-border bg-muted/40 px-1.5 text-[9px] font-medium text-muted-foreground"
      title="Execution target: this machine."
      data-testid="repo-target"
      data-target="local"
    >
      <FolderGit2 size={9} />
      {compact ? 'Local' : 'Local'}
    </span>
  )
}

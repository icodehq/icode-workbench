import { FolderGit2, Server } from 'lucide-react'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import { useT } from '../i18n/use-i18n'

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
  const t = useT()
  if (repo.target.kind === 'wsl') {
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-info/40 bg-info-weak px-1.5 text-[9px] font-medium text-info"
        title={t('projects.target.wslTitle', {
          distro: repo.target.distro,
          registration:
            repo.target.distroId === null
              ? ''
              : t('projects.target.registration', { id: repo.target.distroId })
        })}
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
      title={t('projects.target.localTitle')}
      data-testid="repo-target"
      data-target="local"
    >
      <FolderGit2 size={9} />
      {t('projects.target.local')}
    </span>
  )
}

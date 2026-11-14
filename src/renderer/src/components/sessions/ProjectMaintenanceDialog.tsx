import { useEffect } from 'react'
import { AlertTriangle, GitBranch, Trash2, X } from 'lucide-react'
import type {
  OrphanedHostSession,
  OwnedBranchSummary,
  RepositorySummary
} from '../../../../shared/schemas/ipc'
import { useT, useTp } from '../../i18n/use-i18n'

type Props = {
  repo: RepositorySummary
  branches: OwnedBranchSummary[]
  orphans: OrphanedHostSession[]
  onRemoveBranch: (branch: string) => void
  onClose: () => void
}

/**
 * Retained branches and terminals left behind by an earlier host. These used to
 * live in the project-local Sessions list; the sidebar owns session navigation
 * now, so maintenance moved into this focused dialog.
 */
export default function ProjectMaintenanceDialog({
  repo,
  branches,
  orphans,
  onRemoveBranch,
  onClose
}: Props): React.JSX.Element {
  const t = useT()
  const tp = useTp()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const repoBranches = branches.filter((branch) => branch.repoId === repo.id)

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('sidebar.maintenance')}
      data-testid="project-maintenance-dialog"
    >
      <div className="icode-modal w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
              {t('sidebar.maintenance')}
            </p>
            <h2 className="mt-1 text-[16px] font-semibold">{repo.displayName}</h2>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>

        <section className="mt-4">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <GitBranch size={12} />
            {t('sessionsList.retainedBranches')}
          </div>
          {repoBranches.length === 0 ? (
            <p className="mt-2 text-[11px] text-muted-foreground">{t('sessionsList.noRetainedBranches')}</p>
          ) : (
            <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border">
              {repoBranches.map((branch) => (
                <li
                  key={branch.branch}
                  className="flex items-center gap-1 border-b border-border px-2 py-1.5 last:border-b-0"
                  data-testid={`retained-branch-${branch.branch}`}
                  data-branch-exists={String(branch.exists)}
                  data-branch-unmerged={branch.unmergedCommits ?? 'unknown'}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                    {branch.branch}
                    {branch.unmergedCommits !== null && branch.unmergedCommits > 0
                      ? ` · ${t('sessionsList.unmerged', { count: branch.unmergedCommits })}`
                      : ''}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40"
                    onClick={() => onRemoveBranch(branch.branch)}
                    disabled={!branch.exists || branch.worktreePath !== null}
                    title={
                      branch.worktreePath !== null
                        ? t('sessionsList.worktreeInUse')
                        : branch.exists
                          ? t('sessionsList.deleteBranch', { branch: branch.branch })
                          : t('sessionsList.branchGone')
                    }
                    aria-label={t('sessionsList.deleteBranch', { branch: branch.branch })}
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {orphans.length > 0 ? (
          <section className="mt-4 rounded-md border border-signal-line bg-signal-weak px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-signal">
              <AlertTriangle size={12} />
              {tp('sessionsList.orphans', orphans.length)}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-signal opacity-80">
              {t('sessionsList.orphansBody')}
            </p>
            <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
              {orphans.map((orphan) => (
                <li
                  key={orphan.sessionId}
                  className="truncate font-mono text-[9px] text-signal opacity-80"
                  title={`${orphan.command} in ${orphan.cwd}`}
                >
                  {orphan.command} · pid {orphan.ptyPid}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-[12px] hover:bg-muted"
            onClick={onClose}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

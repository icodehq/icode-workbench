import { ArrowLeft, FolderGit2, Plus, Trash2 } from 'lucide-react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import { repositoryPreparationView } from '../lib/repository-preparation'
import { taskAttention } from './task-status'
import TargetBadge from './TargetBadge'

type Props = {
  repos: RepositorySummary[]
  sessions: SessionSummary[]
  tasks: TaskRecordPayload[]
  onBack: () => void
  onAdd: () => void
  onRemove: (repoId: string) => void
  onOpenProject: (repoId: string) => void
}

/**
 * Repository registration stays a Projects subpage, not a global destination.
 * The Projects rail stays active while it is open.
 */
export default function RepositoriesView({
  repos,
  sessions,
  tasks,
  onBack,
  onAdd,
  onRemove,
  onOpenProject
}: Props): React.JSX.Element {
  const taskSessionIds = new Set(
    tasks.map((task) => task.sessionId).filter((id): id is string => id !== null)
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="repositories-view">
      <div className="w-full px-5 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onBack}
            data-testid="repositories-back"
          >
            <ArrowLeft size={11} />
            All projects
          </button>
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-[-0.02em]">Repositories</h1>
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              Register an existing checkout without modifying it, or explicitly initialize a folder. Every session and task gets an isolated worktree.
            </p>
          </div>
          <button
            type="button"
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[11px] font-medium text-accent-ink hover:opacity-90"
            onClick={onAdd}
            data-testid="repositories-add"
          >
            <Plus size={11} />
            Add project
          </button>
        </div>

        {repos.length === 0 ? (
          <div className="mt-5 rounded-lg border border-border bg-card p-5" data-testid="repositories-empty">
            <div className="flex items-center gap-2">
              <FolderGit2 size={16} className="text-muted-foreground" />
              <p className="text-[13px] font-medium">No repositories registered</p>
            </div>
            <p className="mt-1 max-w-lg text-[11px] leading-relaxed text-muted-foreground">
              Add an existing Git checkout or initialize a folder on this machine or inside a WSL
              distro.
            </p>
            <button
              type="button"
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[10.5px] hover:bg-muted"
              onClick={onAdd}
            >
              <Plus size={11} />
              Add project
            </button>
          </div>
        ) : (
          <ul className="mt-4 space-y-2">
            {repos.map((repo) => {
              const repoSessions = sessions.filter(
                (session) => session.repoId === repo.id && !taskSessionIds.has(session.id)
              )
              const live = repoSessions.filter(
                (session) => session.state === 'live' || session.state === 'starting'
              ).length
              const repoTasks = tasks.filter((task) => task.repoId === repo.id)
              const needs = repoTasks.filter((task) => taskAttention(task) !== null).length
              const preparation = repositoryPreparationView(repo)
              return (
                <li
                  key={repo.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
                  data-testid={`repository-row-${repo.id}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{repo.displayName}</span>
                      <TargetBadge repo={repo} compact />
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {repo.currentBranch ?? 'no branch'}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground" title={repo.path}>
                      {repo.path}
                    </span>
                    {repo.availability === 'missing' ? (
                      <span className="mt-1 block text-[10px] text-signal">Path is missing on disk</span>
                    ) : (
                      <span className="mt-1 block text-[10.5px] text-muted-foreground">
                        {preparation !== null ? (
                          <span className={preparation.kind === 'failed' ? 'text-destructive' : 'text-signal'}>
                            {preparation.label}
                            {' · '}
                          </span>
                        ) : null}
                        {repoSessions.length} session{repoSessions.length === 1 ? '' : 's'} · {live} live ·{' '}
                        {repoTasks.length} task{repoTasks.length === 1 ? '' : 's'}
                        {needs > 0 ? (
                          <>
                            {' · '}
                            <span className="text-signal">{String(needs)} need you</span>
                          </>
                        ) : null}
                      </span>
                    )}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      className="inline-flex h-8 items-center rounded-md border border-border px-2.5 text-[10.5px] hover:bg-muted"
                      onClick={() => onOpenProject(repo.id)}
                      data-testid={`repository-open-${repo.id}`}
                    >
                      Open project
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-destructive"
                      onClick={() => onRemove(repo.id)}
                      title={`Remove ${repo.displayName}`}
                      data-testid={`repository-remove-${repo.id}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

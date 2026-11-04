import { FolderGit2, Plus } from 'lucide-react'
import type { TaskRecordPayload } from '../../../shared/icode-api'
import type { RepositorySummary, SessionSummary } from '../../../shared/schemas/ipc'
import type { ProjectMode } from '../router/routes'
import ProjectsWall from '../components/ProjectsWall'

export type ProjectsPageProps = {
  repos: RepositorySummary[]
  sessions: SessionSummary[]
  tasks: TaskRecordPayload[]
  maxConcurrent: number
  onOpenProject: (repoId: string, mode?: ProjectMode) => void
  onOpenTask: (task: TaskRecordPayload) => void
  onManageRepositories: () => void
  onAddRepository: () => void
  onRetryPreparation: (repoId: string) => void
}

export default function ProjectsPage({
  repos,
  sessions,
  tasks,
  maxConcurrent,
  onOpenProject,
  onOpenTask,
  onManageRepositories,
  onAddRepository,
  onRetryPreparation
}: ProjectsPageProps): React.JSX.Element {
  if (repos.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8" data-testid="empty-workspace">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <FolderGit2 size={15} className="text-muted-foreground" />
            <h1 className="text-[14px] font-semibold">Add a project</h1>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            iCode runs coding agents in isolated worktrees on this machine or in a WSL distro.
            Add an existing Git checkout, or initialize a folder once to make it usable.
          </p>
          <button
            type="button"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink hover:opacity-90"
            onClick={onAddRepository}
            data-testid="empty-add-repo"
          >
            <Plus size={12} />
            Add project
          </button>
        </div>
      </div>
    )
  }

  return (
    <ProjectsWall
      repos={repos}
      sessions={sessions}
      tasks={tasks}
      maxConcurrent={maxConcurrent}
      onOpenProject={onOpenProject}
      onOpenTask={onOpenTask}
      onManageRepositories={onManageRepositories}
      onAddRepository={onAddRepository}
      onRetryPreparation={onRetryPreparation}
    />
  )
}

import type { RepoId } from '../../shared/domain/ids'
import type { Database } from '../persistence/database'
import type { MergeStore } from '../persistence/merge-store'
import type { RepoRemovalJobStore } from '../persistence/repo-removal-job-store'
import type { RepositoryStore } from '../persistence/repository-store'
import type { SessionStore } from '../persistence/session-store'
import type { UiStateStore } from '../persistence/ui-state-store'
import type { WorktreeStore } from '../persistence/worktree-store'
import type { WorkspaceFilesService } from '../files/workspace-files-service'
import type { GitStatusWatcherService } from '../git/status-watcher'
import type { WorkspaceFilesWatcherService } from '../files/workspace-files-watcher'
import type { MergeService } from '../integration/merge-service'
import type { GitWorktreeService } from '../worktrees/git-worktree-service'
import type { RepositoryService } from './repository-service'

export type StopAndWait = (sessionId: string, timeoutMs?: number) => Promise<void>

export type RepositoryRemovalDeps = {
  database: Database
  repositories: RepositoryStore
  sessions: SessionStore
  worktrees: WorktreeStore
  merges: MergeStore
  sessionService: {
    stopAndWait: StopAndWait
    forgetSessions?: (sessionIds: readonly string[]) => void
  }
  repositoryService: Pick<RepositoryService, 'removeRepository'>
  mergeService: Pick<MergeService, 'abort'>
  gitWorktrees: Pick<
    GitWorktreeService,
    | 'worktreeRootFor'
    | 'hostFsFor'
    | 'assertManagedPath'
    | 'remove'
    | 'gitResultFor'
    | 'runRepositoryExclusive'
  >
  jobs: RepoRemovalJobStore
  uiState: Pick<UiStateStore, 'getActiveRepository' | 'getActiveSession' | 'setActiveRepository' | 'setActiveSession'>
  gitStatusWatcher: Pick<GitStatusWatcherService, 'setActive'>
  filesWatcher: Pick<WorkspaceFilesWatcherService, 'setActive'>
  workspaceFiles: Pick<WorkspaceFilesService, 'discardTrashForSessions' | 'disposeSessions'>
  preparations: { cancel(repoId: RepoId): void }
  now: () => number
  onTasksPurged: () => void
  onRepoChanged: () => void
  onChanged: () => void
}

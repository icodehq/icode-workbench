import {
  FolderGit2,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2
} from 'lucide-react'
import type { RuntimeInfo } from '../../../shared/ade-api'
import type { RepositorySummary } from '../../../shared/schemas/ipc'
import type { WorkspaceState } from '../state/workspace'

type HostStatus = 'reachable' | 'unreachable' | 'unknown'

function deriveHostStatus(state: WorkspaceState): HostStatus {
  if (
    state.sessions.some(
      (session) =>
        session.authority === 'unreachable' ||
        session.reason === 'host_unreachable' ||
        session.reason === 'host_unreachable_history'
    )
  ) {
    return 'unreachable'
  }
  if (state.sessions.some((session) => session.authority === 'host')) return 'reachable'
  return 'unknown'
}

function hostLabel(status: HostStatus): string {
  if (status === 'reachable') return 'Host reachable'
  if (status === 'unreachable') return 'Host unreachable'
  return 'Host status unknown'
}

/**
 * Where the active repository lives, as persisted.
 *
 * Read straight from `RepositorySummary.target`, never inferred from the path:
 * after a reload the renderer has no other source, and a path string alone cannot
 * tell this machine's `/home/you` from the distro's.
 */
function TargetBadge({ repo }: { repo: RepositorySummary }): React.JSX.Element {
  if (repo.target.kind === 'wsl') {
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 text-[9px] font-medium text-sky-300"
        title={`Execution target: WSL distro ${repo.target.distro}${
          repo.target.distroId === null ? '' : ` (registration ${repo.target.distroId})`
        }. Agent sessions run inside the distro; WSL terminals run on this desktop.`}
        data-testid="repo-target"
        data-target="wsl"
        data-distro={repo.target.distro}
      >
        <Server size={9} />
        WSL · {repo.target.distro}
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
      Local
    </span>
  )
}

type Props = {
  state: WorkspaceState
  runtime: RuntimeInfo | null
  onSelectRepo: (repoId: string) => void
  onAddRepository: () => void
  onRemoveRepository: () => void
  onRefresh: () => void
  onNewSession: () => void
}

export default function TopBar({
  state,
  runtime,
  onSelectRepo,
  onAddRepository,
  onRemoveRepository,
  onRefresh,
  onNewSession
}: Props): React.JSX.Element {
  const host = deriveHostStatus(state)
  const available = state.harnesses.filter((entry) => entry.state === 'available').length
  const activeRepo: RepositorySummary | null =
    state.repos.find((repo) => repo.id === state.activeRepoId) ?? null

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
      <div className="flex shrink-0 items-baseline gap-2">
        <span className="text-[13px] font-semibold tracking-tight">ADE</span>
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
          agent workspace
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <FolderGit2 size={13} className="shrink-0 text-muted-foreground" />
        <select
          className="h-7 min-w-0 max-w-[340px] flex-1 rounded-md border border-border bg-background px-2 text-[11px] outline-none focus:border-accent disabled:opacity-50"
          value={state.activeRepoId ?? ''}
          onChange={(event) => onSelectRepo(event.target.value)}
          disabled={state.repos.length === 0}
          aria-label="Active repository"
          data-testid="repo-select"
        >
          {state.repos.length === 0 ? <option value="">No repository registered</option> : null}
          {state.repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.displayName}
              {repo.target.kind === 'wsl' ? ` · WSL ${repo.target.distro}` : ''}
              {repo.currentBranch === null ? '' : ` (${repo.currentBranch})`}
              {repo.availability === 'missing' ? ' — path missing' : ''}
            </option>
          ))}
        </select>
        {activeRepo ? <TargetBadge repo={activeRepo} /> : null}
        {activeRepo ? (
          <span
            className="hidden min-w-0 truncate font-mono text-[9px] text-muted-foreground xl:inline"
            title={activeRepo.path}
          >
            {activeRepo.path}
          </span>
        ) : null}
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[10px] hover:bg-muted"
          onClick={onAddRepository}
          data-testid="add-repo-open"
        >
          <Plus size={11} />
          Register
        </button>
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onRemoveRepository}
          disabled={activeRepo === null}
          title={activeRepo ? `Remove ${activeRepo.displayName}` : 'No repository selected'}
          data-testid="remove-repo"
        >
          <Trash2 size={11} />
          Remove
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span
          className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[9px] ${
            host === 'unreachable'
              ? 'border-amber-500/40 text-amber-400'
              : 'border-border text-muted-foreground'
          }`}
          title="Derived from host reconciliation of session state"
          data-testid="host-status"
          data-host-status={host}
        >
          <Server size={10} />
          {hostLabel(host)}
        </span>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => {
            if (state.repos.length > 0) onNewSession()
          }}
          title="Harness detection status; open New session for details"
          data-testid="harness-summary"
          disabled={state.repos.length === 0}
        >
          {state.harnessLoading ? <Loader2 size={10} className="animate-spin" /> : null}
          {available}/{state.harnesses.length || 4} Harnesses
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          onClick={onRefresh}
          disabled={state.refreshing}
          title="Refresh repositories, sessions and Harness detection"
          data-testid="refresh-all"
        >
          <RefreshCw size={12} className={state.refreshing ? 'animate-spin' : ''} />
        </button>
        <span
          className="hidden font-mono text-[9px] text-muted-foreground lg:inline"
          title={runtime ? `Electron ${runtime.electron ?? '?'} · Node ${runtime.node}` : undefined}
        >
          v{runtime?.appVersion ?? '0.1.0'}
        </span>
      </div>
    </header>
  )
}

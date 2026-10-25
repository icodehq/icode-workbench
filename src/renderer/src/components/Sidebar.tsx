import { AlertTriangle, GitBranch, Plus, TerminalSquare, Trash2 } from 'lucide-react'
import type {
  OrphanedHostSession,
  OwnedBranchSummary,
  RepositorySummary,
  SessionSummary
} from '../../../shared/schemas/ipc'
import type { PendingAction } from '../state/workspace'
import {
  activityDotClass,
  activitySuffix,
  activityTone,
  activityTooltip,
  harnessName,
  sessionStateLabel,
  stateDotClass
} from './status'

type Props = {
  repos: RepositorySummary[]
  sessions: SessionSummary[]
  orphans: OrphanedHostSession[]
  activeRepoId: string | null
  activeSessionId: string | null
  pending: Record<string, PendingAction>
  canCreate: boolean
  branches: OwnedBranchSummary[]
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  onRemoveBranch: (branch: string) => void
}

export default function Sidebar({
  repos,
  sessions,
  orphans,
  activeRepoId,
  activeSessionId,
  pending,
  canCreate,
  branches,
  onSelectSession,
  onNewSession,
  onRemoveBranch
}: Props): React.JSX.Element {
  return (
    <aside className="flex w-[258px] shrink-0 flex-col border-r border-border bg-card/40">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Sessions
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[10px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onNewSession}
          disabled={!canCreate}
          title={canCreate ? 'Create a session' : 'Register a repository first'}
          data-testid="new-session-open"
        >
          <Plus size={11} />
          New
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {repos.length === 0 ? (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-muted-foreground">
            No repositories yet. Register a Git repository — on this machine or in a WSL
            distro — to start a session.
          </p>
        ) : null}

        {repos.map((repo) => {
          const sessionsForRepo = sessions.filter((session) => session.repoId === repo.id)
          const active = repo.id === activeRepoId
          return (
            <section key={repo.id} className="mb-3">
              <div
                className={`px-2 pb-1 text-[10px] font-medium uppercase tracking-wide ${
                  active ? 'text-foreground' : 'text-muted-foreground'
                }`}
                title={repo.path}
              >
                <span className="truncate">{repo.displayName}</span>
                <span className="ml-1 font-normal normal-case tracking-normal text-muted-foreground">
                  {repo.currentBranch ?? 'no branch'}
                </span>
                {repo.target.kind === 'wsl' ? (
                  <span
                    className="ml-1 rounded border border-sky-500/40 bg-sky-500/10 px-1 text-[8px] font-medium text-sky-300"
                    title={`WSL distro ${repo.target.distro}`}
                    data-testid="sidebar-repo-target"
                    data-target="wsl"
                  >
                    WSL
                  </span>
                ) : null}
              </div>
              {repo.availability === 'missing' ? (
                <p className="mb-1 px-2 text-[10px] text-amber-400">Path is missing on disk</p>
              ) : null}
              {sessionsForRepo.length === 0 ? (
                <p className="px-2 py-1 text-[10px] text-muted-foreground">No sessions</p>
              ) : (
                <ul className="space-y-0.5">
                  {sessionsForRepo.map((session) => {
                    const action = pending[session.id] ?? null
                    const selected = session.id === activeSessionId
                    const activity = session.activity
                    const suffix = activitySuffix(activity)
                    return (
                      <li key={session.id}>
                        <button
                          type="button"
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                            selected
                              ? 'bg-muted text-foreground'
                              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                          }`}
                          onClick={() => onSelectSession(session.id)}
                          aria-current={selected ? 'true' : undefined}
                          data-testid={`session-item-${session.id}`}
                          data-session-id={session.id}
                          data-session-state={session.state}
                          data-session-incarnation={session.incarnationId ?? ''}
                          data-session-activity={activity?.state ?? 'unknown'}
                          data-session-activity-unread={String(activity?.unread ?? false)}
                          title={`${session.title} — ${harnessName(session.harness)}${suffix ? ` — ${activityTooltip(activity)}` : ''}`}
                        >
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateDotClass(session.state, action)}`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11px]">{session.title}</span>
                            <span className="block truncate text-[9px] text-muted-foreground">
                              {harnessName(session.harness)}
                              {repo.target.kind === 'wsl' ? ' · WSL' : ''} ·{' '}
                              {sessionStateLabel(session.state, action)}
                              {session.worktree ? ` · ${session.worktree.branch}` : ''}
                            </span>
                            {suffix ? (
                              <span
                                className={`mt-0.5 flex items-center gap-1 text-[9px] ${activityTone(activity)}${
                                  activity?.unread ? ' font-semibold' : ''
                                }`}
                                data-testid={`session-activity-${session.id}`}
                                data-activity={activity?.state ?? 'unknown'}
                                data-activity-unread={String(activity?.unread ?? false)}
                              >
                                <span
                                  className={`h-1 w-1 shrink-0 rounded-full ${activityDotClass(activity)}`}
                                />
                                <span className="truncate">{suffix}</span>
                                {activity?.unread ? (
                                  <span
                                    className="ml-auto shrink-0 text-[8px] uppercase tracking-wide"
                                    aria-label="Unread activity"
                                    data-testid={`session-unread-${session.id}`}
                                  >
                                    new
                                  </span>
                                ) : null}
                              </span>
                            ) : null}
                            {session.worktree &&
                            (session.worktree.status === 'missing' ||
                              session.worktree.status === 'inconsistent' ||
                              session.worktree.status === 'failed' ||
                              session.worktree.status === 'incomplete') ? (
                              <span
                                className="block truncate text-[9px] text-amber-400"
                                data-testid={`session-worktree-status-${session.id}`}
                              >
                                {session.worktree.status}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}

        {branches.length > 0 ? (
          <section className="mt-2 rounded-md border border-border px-2 py-2">
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
              <GitBranch size={11} />
              Retained branches
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
              Branches ADE created are kept after a worktree is removed.
            </p>
            <ul className="mt-1 space-y-0.5">
              {branches.map((branch) => (
                <li
                  key={branch.branch}
                  className="flex items-center gap-1"
                  data-testid={`retained-branch-${branch.branch}`}
                  data-branch-exists={String(branch.exists)}
                  data-branch-unmerged={branch.unmergedCommits ?? 'unknown'}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground">
                    {branch.branch}
                    {branch.unmergedCommits !== null && branch.unmergedCommits > 0
                      ? ` · ${String(branch.unmergedCommits)} unmerged`
                      : ''}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40"
                    onClick={() => onRemoveBranch(branch.branch)}
                    disabled={!branch.exists || branch.worktreePath !== null}
                    title={
                      branch.worktreePath !== null
                        ? 'A worktree still uses this branch'
                        : branch.exists
                          ? `Delete branch ${branch.branch}`
                          : 'Branch no longer exists'
                    }
                    aria-label={`Delete branch ${branch.branch}`}
                  >
                    <Trash2 size={10} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {orphans.length > 0 ? (
          <section className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-2">
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-amber-300">
              <AlertTriangle size={11} />
              {orphans.length} untracked terminal{orphans.length === 1 ? '' : 's'}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-amber-200/80">
              The terminal host still owns sessions that ADE does not track. They are not attached
              here and are left running.
            </p>
            <ul className="mt-1 space-y-0.5">
              {orphans.slice(0, 4).map((orphan) => (
                <li
                  key={orphan.sessionId}
                  className="truncate font-mono text-[9px] text-amber-200/70"
                  title={`${orphan.command} in ${orphan.cwd}`}
                >
                  {orphan.command} · pid {orphan.ptyPid}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="flex h-8 shrink-0 items-center gap-1.5 border-t border-border px-3 text-[9px] text-muted-foreground">
        <TerminalSquare size={11} />
        {sessions.length} session{sessions.length === 1 ? '' : 's'} · PTYs survive switching
      </div>
    </aside>
  )
}

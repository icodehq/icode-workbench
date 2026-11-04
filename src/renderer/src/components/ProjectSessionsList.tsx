import { AlertTriangle, GitBranch, PanelLeftClose, Plus, Trash2 } from 'lucide-react'
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
  sessionStateLabelFor,
  sessionStateDotClass
} from './status'

type Props = {
  repo: RepositorySummary
  sessions: SessionSummary[]
  activeSessionId: string | null
  pending: Record<string, PendingAction>
  branches: OwnedBranchSummary[]
  orphans: OrphanedHostSession[]
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  onRemoveBranch: (branch: string) => void
  /** Hides the list for a wider terminal; the session header keeps the reopen control. */
  onCollapse?: () => void
}

/**
 * The project-local Sessions list.
 *
 * It receives direct sessions only. A task-owned session is opened from its
 * task, so it is not repeated here; the project directory's live count still
 * includes it.
 */
export default function ProjectSessionsList({
  repo,
  sessions,
  activeSessionId,
  pending,
  branches,
  orphans,
  onSelectSession,
  onNewSession,
  onRemoveBranch,
  onCollapse
}: Props): React.JSX.Element {
  return (
    <aside
      className="flex w-[326px] shrink-0 flex-col border-r border-border bg-card max-[900px]:max-h-[34vh] max-[900px]:w-full max-[900px]:border-b max-[900px]:border-r-0"
      data-testid="project-sessions-list"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-foreground">
          Sessions
        </span>
        <span className="font-mono text-[10.5px] text-muted-foreground">{sessions.length}</span>
        {onCollapse !== undefined ? (
          <button
            type="button"
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onCollapse}
            title="Hide sessions list"
            aria-label="Hide sessions list"
            data-testid="sessions-list-collapse"
          >
            <PanelLeftClose size={11} />
          </button>
        ) : null}
        <button
          type="button"
          className={`${onCollapse === undefined ? 'ml-auto' : ''} inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] hover:bg-muted`}
          onClick={onNewSession}
          title={`Start a direct session in ${repo.displayName}`}
          data-testid="project-new-session"
        >
          <Plus size={11} />
          New
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-0">
        {sessions.length === 0 ? (
          <div className="px-2 py-3 text-[11px] leading-relaxed text-muted-foreground">
            No direct sessions yet. Tasks have their own list and never appear here.
            <div className="mt-2">
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-foreground hover:bg-muted"
                onClick={onNewSession}
                data-testid="empty-new-session"
              >
                <Plus size={11} />
                New session
              </button>
            </div>
          </div>
        ) : (
          <ul className="space-y-1">
            {sessions.map((session) => {
              const action = pending[session.id] ?? null
              const selected = session.id === activeSessionId
              const activity = session.activity
              const suffix = activitySuffix(activity)
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left ${
                      selected
                        ? 'border-accent/50 bg-muted text-foreground shadow-[inset_2px_0_0_var(--icode-accent)]'
                        : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                    onClick={() => onSelectSession(session.id)}
                    aria-current={selected ? 'true' : undefined}
                    data-testid={`session-item-${session.id}`}
                    data-session-id={session.id}
                    data-session-state={session.state}
                    data-session-sleeping={String(session.sleeping === true)}
                    data-session-incarnation={session.incarnationId ?? ''}
                    data-session-activity={activity?.state ?? 'unknown'}
                    data-session-activity-unread={String(activity?.unread ?? false)}
                    title={`${session.title} — ${harnessName(session.harness)}${suffix ? ` — ${activityTooltip(activity)}` : ''}`}
                  >
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${sessionStateDotClass(session, action)}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">{session.title}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {harnessName(session.harness)} · {sessionStateLabelFor(session, action)}
                        {session.worktree ? ` · ${session.worktree.branch}` : ''}
                      </span>
                      {suffix ? (
                        <span
                          className={`mt-0.5 flex items-center gap-1 text-[10px] ${activityTone(activity)}${
                            activity?.unread ? ' font-semibold' : ''
                          }`}
                          data-testid={`session-activity-${session.id}`}
                          data-activity={activity?.state ?? 'unknown'}
                          data-activity-unread={String(activity?.unread ?? false)}
                        >
                          <span className={`h-1 w-1 shrink-0 rounded-full ${activityDotClass(activity)}`} />
                          <span className="truncate">{suffix}</span>
                          {activity?.unread ? (
                            <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wide">new</span>
                          ) : null}
                        </span>
                      ) : null}
                      {session.worktree &&
                      (session.worktree.status === 'missing' ||
                        session.worktree.status === 'inconsistent' ||
                        session.worktree.status === 'failed' ||
                        session.worktree.status === 'incomplete') ? (
                        <span className="mt-0.5 block truncate text-[9px] text-signal">
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
      </div>

      {branches.length > 0 ? (
        <section className="mx-2 mb-2 rounded-md border border-border px-2 pb-3 pt-0">
          <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
            <GitBranch size={11} />
            Retained branches
          </div>
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
        <section className="mx-2 mb-2 rounded-md border border-signal-line bg-signal/10 px-2 pb-3 pt-0">
          <div className="flex items-center gap-1.5 text-[10px] font-medium text-signal">
            <AlertTriangle size={11} />
            {orphans.length} untracked terminal{orphans.length === 1 ? '' : 's'}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-signal opacity-80">
            The terminal host still owns sessions iCode does not track. They are not attached here and
            are left running.
          </p>
          <ul className="mt-1 space-y-0.5">
            {orphans.slice(0, 4).map((orphan) => (
              <li
                key={orphan.sessionId}
                className="truncate font-mono text-[9px] text-signal opacity-70"
                title={`${orphan.command} in ${orphan.cwd}`}
              >
                {orphan.command} · pid {orphan.ptyPid}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border px-3 text-[9px] text-muted-foreground">
        {repo.target.kind === 'wsl' ? `WSL ${repo.target.distro}` : 'Local'} · {sessions.length} direct
      </div>
    </aside>
  )
}

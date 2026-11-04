import { useCallback, useEffect, useState } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'
import { callApi, errorNotice } from '../lib/api'
import type {
  GitBranchesPayload,
  GitBranchPayload,
  GitCommitPayload,
  GitOpPayload,
  GitStatusPayload,
  WorkspaceUnavailablePayload
} from '../../../shared/ade-api'
import type { GitStatusEntry, GitWorkspaceStatus } from '../../../shared/domain/git-workspace'
import type { Notice } from '../state/workspace'

export type GitPanelProps = {
  sessionId: string
  refreshToken: number
  notify: (notice: Notice) => void
  /** Opens the selected path in the file editor. */
  onOpenPath: (path: string) => void
  /** Called after any operation that changes the working tree. */
  onChanged: () => void
}

const unavailableText = (payload: WorkspaceUnavailablePayload): string => {
  switch (payload.reason) {
    case 'worktree-unavailable':
      return 'This distro could not be reached, so its Git state is unavailable right now.'
    case 'worktree-missing':
      return 'The session worktree is missing.'
    case 'primary-checkout':
      return 'This session runs in the primary checkout, so it has no worktree Git state.'
    default:
      return payload.detail
  }
}

function Group({
  title,
  entries,
  onOpenPath,
  onToggleStaged,
  staged,
  busy,
  testId
}: {
  title: string
  entries: GitStatusEntry[]
  onOpenPath: (path: string) => void
  onToggleStaged: (path: string, staged: boolean) => void
  /** True for the group whose entries are currently in the index. */
  staged: boolean
  busy: boolean
  testId: string
}): React.JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <div className="mb-2" data-testid={testId}>
      <p className="px-2 py-1 text-[9px] uppercase tracking-wide text-muted-foreground">
        {title} · {entries.length}
      </p>
      {entries.map((entry) => (
        <div key={`${entry.path}:${entry.code}`} className="flex items-center gap-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-0.5 text-left hover:bg-muted/60"
            onClick={() => onOpenPath(entry.path)}
            data-testid={`git-entry-${entry.path}`}
            title={entry.path}
          >
            <span className="w-3 shrink-0 font-mono text-[9px] text-muted-foreground">{entry.code.trim()}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
              {entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
            </span>
            <span className="shrink-0 text-[9px] text-muted-foreground">{entry.status}</span>
          </button>
          {entry.area === 'conflicted' ? null : (
            <button
              type="button"
              className="shrink-0 rounded px-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              title={staged ? 'Unstage this file' : 'Stage this file'}
              data-testid={`git-toggle-${entry.path}`}
              disabled={busy}
              onClick={() => onToggleStaged(entry.path, !staged)}
            >
              {staged ? '−' : '+'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Worktree-scoped Git state and the three operations a developer uses while
 * reviewing an Agent's work.
 *
 * Nothing destructive happens on a single click except an explicit per-file
 * discard, which is confirmed by the caller. Stage/commit are reversible steps
 * in the normal Git flow, so they act directly and report what happened.
 */
export default function GitPanel({
  sessionId,
  refreshToken,
  notify,
  onOpenPath,
  onChanged
}: GitPanelProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<GitWorkspaceStatus | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [branches, setBranches] = useState<{ current: string | null; names: string[] } | null>(null)
  const [branchBusy, setBranchBusy] = useState(false)
  const [remoteBusy, setRemoteBusy] = useState<'push' | 'pull' | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const result = await callApi<GitStatusPayload>(window.ade.git.status({ sessionId }))
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    const value = result.value
    if (value.status === 'unavailable') {
      setSnapshot(null)
      setNote(unavailableText(value))
      return
    }
    setSnapshot(value.snapshot)
    setNote('')
  }, [notify, sessionId])

  useEffect(() => {
    setSnapshot(null)
    setNote('')
    void load()
  }, [load, refreshToken, sessionId])

  const act = async (work: () => Promise<{ ok: boolean; label: string }>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const outcome = await work()
      if (outcome.ok) notify({ tone: 'success', message: outcome.label })
    } finally {
      setBusy(false)
      await load()
      onChanged()
    }
  }

  /** Stages or unstages exactly one path, then re-reads the real status. */
  const setStaged = async (path: string, staged: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await callApi<GitOpPayload>(
        window.ade.git.setPathStaged({ sessionId, path, staged })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({ tone: 'success', message: `${staged ? 'Staged' : 'Unstaged'} ${path}` })
    } finally {
      setBusy(false)
      await load()
      onChanged()
    }
  }

  const loadBranches = async (): Promise<void> => {
    const result = await callApi<GitBranchesPayload>(window.ade.git.branches({ sessionId }))
    if (!result.ok) {
      notify(errorNotice(result.error))
      return
    }
    if (result.value.status === 'unavailable') {
      notify({ tone: 'error', message: result.value.detail })
      return
    }
    setBranches({ current: result.value.current, names: result.value.names })
  }

  /**
   * Switching branches is the one Git action here that can strand work, so the
   * dirty-worktree refusal comes from main and is shown verbatim.
   */
  const switchBranch = async (branch: string): Promise<void> => {
    if (branchBusy || branch.length === 0) return
    setBranchBusy(true)
    try {
      const result = await callApi<GitBranchPayload>(window.ade.git.switchBranch({ sessionId, branch }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail, detail: result.value.reason })
        return
      }
      notify({ tone: 'success', message: `Switched to ${result.value.branch}` })
      setBranches(null)
    } finally {
      setBranchBusy(false)
      await load()
      onChanged()
    }
  }

  const remote = async (verb: 'push' | 'pull'): Promise<void> => {
    if (remoteBusy) return
    setRemoteBusy(verb)
    try {
      const result = await callApi<GitBranchPayload>(
        verb === 'push' ? window.ade.git.push({ sessionId }) : window.ade.git.pull({ sessionId })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      notify({
        tone: 'success',
        message: `${verb === 'push' ? 'Pushed' : 'Pulled'} ${result.value.branch} (${result.value.upstream ?? 'upstream'})`
      })
    } finally {
      setRemoteBusy(null)
      await load()
      onChanged()
    }
  }

  const stageAll = (): Promise<void> =>
    act(async () => {
      const result = await callApi<GitOpPayload>(window.ade.git.stageAll({ sessionId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return { ok: false, label: '' }
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return { ok: false, label: '' }
      }
      return { ok: true, label: `Staged ${String(result.value.staged)} path(s).` }
    })

  const unstageAll = (): Promise<void> =>
    act(async () => {
      const result = await callApi<GitOpPayload>(window.ade.git.unstageAll({ sessionId }))
      if (!result.ok) {
        notify(errorNotice(result.error))
        return { ok: false, label: '' }
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return { ok: false, label: '' }
      }
      return { ok: true, label: `Unstaged ${String(result.value.unstaged)} path(s).` }
    })

  const commit = (): Promise<void> =>
    act(async () => {
      const result = await callApi<GitCommitPayload>(
        window.ade.git.commit({ sessionId, message })
      )
      if (!result.ok) {
        notify(errorNotice(result.error))
        return { ok: false, label: '' }
      }
      if (result.value.status === 'unavailable') {
        notify({ tone: 'error', message: result.value.detail })
        return { ok: false, label: '' }
      }
      setMessage('')
      return {
        ok: true,
        label: `Committed ${result.value.oid} · ${String(result.value.files)} file(s): ${result.value.subject}`
      }
    })

  if (note) {
    return (
      <div className="p-4" data-testid="git-panel">
        <p className="text-[11px] text-signal" data-testid="git-unavailable">
          {note}
        </p>
      </div>
    )
  }

  if (snapshot === null) {
    return (
      <div className="p-4" data-testid="git-panel">
        <p className="text-[11px] text-muted-foreground">Reading Git state…</p>
      </div>
    )
  }

  const total =
    snapshot.staged.length + snapshot.unstaged.length + snapshot.untracked.length + snapshot.conflicted.length

  return (
    <div className="flex min-h-0 flex-1" data-testid="git-panel">
      <div className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
          <GitBranch size={11} className="shrink-0 text-muted-foreground" />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[11px] text-foreground hover:underline"
            title="Switch branch"
            data-testid="git-branch"
            onClick={() => {
              if (branches === null) void loadBranches()
              else setBranches(null)
            }}
          >
            {snapshot.branch ?? 'detached / unborn'}
          </button>
          {snapshot.upstream ? (
            <span className="shrink-0 text-[9px] text-muted-foreground" data-testid="git-ahead-behind">
              {snapshot.upstream} ↑{snapshot.ahead} ↓{snapshot.behind}
            </span>
          ) : null}
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => void load()}
            data-testid="git-refresh"
            title="Refresh Git state"
          >
            <RefreshCw size={10} />
          </button>
        </div>

        {branches !== null ? (
          <div className="border-b border-border px-2 py-1.5" data-testid="git-branches">
            <p className="mb-1 text-[9px] text-muted-foreground">Switch to</p>
            <div className="max-h-32 overflow-auto">
              {branches.names.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[10px] hover:bg-muted ${
                    name === branches.current ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                  disabled={branchBusy || name === branches.current}
                  data-testid={`git-branch-option-${name}`}
                  onClick={() => void switchBranch(name)}
                >
                  {name}
                  {name === branches.current ? ' · current' : ''}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[9px] text-muted-foreground">
              A worktree with uncommitted changes is refused rather than carried across.
            </p>
          </div>
        ) : null}

        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            onClick={() => void remote('pull')}
            disabled={remoteBusy !== null}
            title="Pull from the configured upstream (fast-forward only)"
            data-testid="git-pull"
          >
            {remoteBusy === 'pull' ? 'Pulling…' : 'Pull'}
          </button>
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            onClick={() => void remote('push')}
            disabled={remoteBusy !== null}
            title="Push to the configured upstream"
            data-testid="git-push"
          >
            {remoteBusy === 'push' ? 'Pushing…' : 'Push'}
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            onClick={() => void stageAll()}
            disabled={busy || total === 0}
            data-testid="git-stage-all"
          >
            Stage all
          </button>
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            onClick={() => void unstageAll()}
            disabled={busy || snapshot.staged.length === 0}
            data-testid="git-unstage-all"
          >
            Unstage
          </button>
          <span className="ml-auto text-[9px] text-muted-foreground" data-testid="git-total">
            {snapshot.clean ? 'clean' : `${String(total)} change(s)`}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
          {snapshot.clean ? (
            <p className="px-2 py-1 text-[10px] text-muted-foreground" data-testid="git-clean">
              Nothing to commit — this worktree matches its baseline.
            </p>
          ) : null}
          {[
            { title: 'Conflicted', entries: snapshot.conflicted, testId: 'git-group-conflicted', staged: false },
            { title: 'Staged', entries: snapshot.staged, testId: 'git-group-staged', staged: true },
            { title: 'Modified', entries: snapshot.unstaged, testId: 'git-group-unstaged', staged: false },
            { title: 'Untracked', entries: snapshot.untracked, testId: 'git-group-untracked', staged: false }
          ].map((group) => (
            <Group
              key={group.testId}
              title={group.title}
              entries={group.entries}
              onOpenPath={onOpenPath}
              staged={group.staged}
              busy={busy}
              onToggleStaged={(path, stage) => void setStaged(path, stage)}
              testId={group.testId}
            />
          ))}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
        <p className="mb-1 text-[9px] uppercase tracking-wide text-muted-foreground">Commit message</p>
        <textarea
          value={message}
          placeholder="Describe what this change does…"
          className="mb-2 h-20 w-full resize-none rounded border border-border bg-transparent p-2 font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="git-commit-message"
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 text-[10px] text-foreground hover:bg-muted disabled:opacity-40"
            onClick={() => void commit()}
            disabled={busy || message.trim().length === 0 || snapshot.staged.length === 0}
            data-testid="git-commit"
          >
            Commit {snapshot.staged.length > 0 ? `${String(snapshot.staged.length)} staged` : ''}
          </button>
          <span className="text-[9px] text-muted-foreground">
            Commits what is staged, in this worktree only.
          </span>
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
          Review the diff for these paths in <span className="text-foreground">Changes</span>; the Agent
          sees committed work in its own terminal.
        </p>
      </div>
    </div>
  )
}

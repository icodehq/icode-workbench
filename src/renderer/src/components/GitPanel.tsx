import { useCallback, useEffect, useState } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'
import { callApi, errorNotice } from '../lib/api'
import type {
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
  testId
}: {
  title: string
  entries: GitStatusEntry[]
  onOpenPath: (path: string) => void
  testId: string
}): React.JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <div className="mb-2" data-testid={testId}>
      <p className="px-2 py-1 text-[9px] uppercase tracking-wide text-muted-foreground">
        {title} · {entries.length}
      </p>
      {entries.map((entry) => (
        <button
          key={`${entry.path}:${entry.code}`}
          type="button"
          className="flex w-full items-center gap-2 rounded px-2 py-0.5 text-left hover:bg-muted/60"
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
        <p className="text-[11px] text-amber-400" data-testid="git-unavailable">
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
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground" data-testid="git-branch">
            {snapshot.branch ?? 'detached / unborn'}
          </span>
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
          <Group title="Conflicted" entries={snapshot.conflicted} onOpenPath={onOpenPath} testId="git-group-conflicted" />
          <Group title="Staged" entries={snapshot.staged} onOpenPath={onOpenPath} testId="git-group-staged" />
          <Group title="Modified" entries={snapshot.unstaged} onOpenPath={onOpenPath} testId="git-group-unstaged" />
          <Group title="Untracked" entries={snapshot.untracked} onOpenPath={onOpenPath} testId="git-group-untracked" />
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

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type {
  GitWorktreeActionPayload,
  GitWorktreeInfo,
  GitWorktreeListPayload
} from '../../../shared/icode-api'
import { callApi } from '../lib/api'
import type { Notice } from '../state/workspace'

type Props = {
  sessionId: string
  refreshToken: number
  gitRevision: number
  notify: (notice: Notice) => void
  onChanged: () => void
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/gu, '/').split('/').filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? path
}

export default function ScmWorktreesSection({
  sessionId,
  refreshToken,
  gitRevision,
  notify,
  onChanged
}: Props): React.JSX.Element {
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [removeIndex, setRemoveIndex] = useState<number | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    void (async (): Promise<void> => {
      const result = await callApi<GitWorktreeListPayload>(
        window.icode.git.worktreeList({ sessionId })
      )
      if (cancelled) return
      if (!result.ok) {
        setError(result.error.message)
        setLoading(false)
        return
      }
      if (result.value.status !== 'ok') {
        setError(result.value.detail)
        setLoading(false)
        return
      }
      setWorktrees(result.value.worktrees)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [gitRevision, refreshToken, reloadTick, sessionId])

  const reload = (): void => {
    setReloadTick((value) => value + 1)
    onChanged()
  }

  const act = async (
    action: 'lock' | 'unlock' | 'prune' | 'remove',
    path?: string
  ): Promise<void> => {
    if (busy !== null) return
    const key = `${action}:${path ?? ''}`
    setBusy(key)
    setError(null)
    try {
      const result = await callApi<GitWorktreeActionPayload>(
        window.icode.git.worktreeAction({ sessionId, action, ...(path ? { path } : {}) })
      )
      if (!result.ok) {
        notify({ tone: 'error', message: result.error.message })
        return
      }
      if (result.value.status !== 'ok') {
        notify({ tone: 'error', message: result.value.detail })
        return
      }
      const past =
        action === 'lock'
          ? 'Locked'
          : action === 'unlock'
            ? 'Unlocked'
            : action === 'remove'
              ? 'Removed'
              : 'Pruned'
      notify({
        tone: 'success',
        message: `${past} worktree${action === 'prune' ? 's' : ''}`
      })
      setRemoveIndex(null)
      reload()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="border-t border-border" aria-label="Worktrees" data-testid="scm-worktrees">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={collapsed ? 'Expand Worktrees' : 'Collapse Worktrees'}
          aria-expanded={!collapsed}
          data-testid="scm-worktrees-toggle"
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
        <span className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          Worktrees
        </span>
        <span className="font-mono text-[9px] text-muted-foreground">{worktrees.length}</span>
        <button
          type="button"
          className="ml-auto rounded border border-border px-1.5 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          disabled={busy !== null}
          data-testid="scm-worktrees-prune"
          title="Prune stale worktree metadata"
          onClick={() => void act('prune')}
        >
          {busy === 'prune:' ? 'Pruning…' : 'Prune'}
        </button>
      </div>

      {!collapsed ? (
        loading ? (
          <p className="flex items-center gap-1.5 px-3 py-1.5 text-[9.5px] text-muted-foreground">
            <Loader2 size={9} className="animate-spin" />
            Reading worktrees…
          </p>
        ) : error !== null ? (
          <p className="px-3 py-1.5 text-[9.5px] text-destructive">{error}</p>
        ) : (
          <ul className="pb-1">
            {worktrees.map((entry, index) => {
              const canRemove = !entry.primary && !entry.active
              return (
                <li
                  key={`${entry.path}-${String(index)}`}
                  className="border-t border-border/40 px-1 py-1"
                  data-testid={`scm-worktree-row-${String(index)}`}
                >
                  <div className="flex items-start gap-1">
                    <div className="min-w-0 flex-1 px-1 py-0.5">
                      <div className="flex items-center gap-1">
                        <span
                          className="truncate font-mono text-[10px] text-foreground"
                          title={entry.path}
                        >
                          {shortPath(entry.path)}
                        </span>
                        {entry.primary ? (
                          <span className="rounded border border-border px-1 text-[8px] uppercase text-muted-foreground">
                            primary
                          </span>
                        ) : null}
                        {entry.active ? (
                          <span className="rounded border border-signal-line bg-signal-weak px-1 text-[8px] uppercase text-signal">
                            session
                          </span>
                        ) : null}
                        {entry.locked !== null ? (
                          <span
                            className="rounded border border-border px-1 text-[8px] uppercase text-muted-foreground"
                            title={entry.locked || 'Locked'}
                          >
                            locked
                          </span>
                        ) : null}
                        {entry.prunable !== null ? (
                          <span className="rounded border border-destructive/40 px-1 text-[8px] uppercase text-destructive">
                            prunable
                          </span>
                        ) : null}
                      </div>
                      <span className="block truncate font-mono text-[8.5px] text-muted-foreground">
                        {entry.branch ?? (entry.detached ? 'detached' : 'unknown')} ·{' '}
                        {entry.head?.slice(0, 8) ?? 'no head'}
                      </span>
                    </div>
                    <span className="flex shrink-0 items-center gap-0.5">
                      {entry.locked === null ? (
                        <button
                          type="button"
                          className="rounded px-1 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                          disabled={busy !== null || entry.active || entry.primary}
                          title={
                            entry.active
                              ? 'Session worktrees cannot be locked'
                              : entry.primary
                                ? 'The primary checkout cannot be locked'
                                : 'Lock this worktree'
                          }
                          data-testid={`scm-worktree-lock-${String(index)}`}
                          onClick={() => void act('lock', entry.path)}
                        >
                          Lock
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="rounded px-1 py-0.5 text-[8.5px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                          disabled={busy !== null}
                          data-testid={`scm-worktree-unlock-${String(index)}`}
                          onClick={() => void act('unlock', entry.path)}
                        >
                          Unlock
                        </button>
                      )}
                      <button
                        type="button"
                        className="rounded px-1 py-0.5 text-[8.5px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
                        disabled={busy !== null || !canRemove}
                        title={
                          entry.primary
                            ? 'The primary checkout cannot be removed'
                            : entry.active
                              ? 'Remove the owning session first'
                              : 'Remove this worktree'
                        }
                        data-testid={`scm-worktree-remove-${String(index)}`}
                        onClick={() => setRemoveIndex(index)}
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                  {removeIndex === index ? (
                    <div className="mt-1 flex items-center gap-1 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-1">
                      <span className="text-[9px] text-destructive">Remove this worktree?</span>
                      <span className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          className="rounded border border-destructive bg-destructive px-1.5 py-0.5 text-[8.5px] text-white disabled:opacity-50"
                          disabled={busy !== null}
                          data-testid={`scm-worktree-remove-yes-${String(index)}`}
                          onClick={() => void act('remove', entry.path)}
                        >
                          Remove
                        </button>
                        <button
                          type="button"
                          className="rounded px-1 py-0.5 text-[8.5px] text-muted-foreground hover:text-foreground"
                          data-testid={`scm-worktree-remove-cancel-${String(index)}`}
                          onClick={() => setRemoveIndex(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )
      ) : null}
    </section>
  )
}
